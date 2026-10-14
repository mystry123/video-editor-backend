// services/director/run.ts
//
// Runs one Cue Director edit, stage by stage, recording progress on the
// DirectorRun so the editor can show it:
//
//   watching    Gemini watches each source (cached per file)
//   briefing    the director writes the creative brief
//   cutting     the story editor builds the cut; problems go back to it
//   crafting    titles/captions, motion, sound and assets in parallel
//   assembling  sound effects and pictures are fetched, the edit compiled
//               and checked
//   (reviewing / revising: the storyboard review loop, see review.ts)
//   done        the draft is ready for the user to review and apply
//
// One run is one `directorRuns` unit, reserved at the start and released if
// the run fails or is stopped before it finishes. Sound effects it makes are
// part of the run (not counted again).

import { v4 as uuidv4 } from 'uuid';
import { Types } from 'mongoose';
import { logger } from '../../utils/logger';
import { DirectorRun, type DirectorStage, type IDirectorRun } from '../../models/DirectorRun';
import { File } from '../../models/File';
import { Transcription } from '../../models/Transcription';
import { User } from '../../models/User';
import { getEffectiveQuota } from '../../config/quotas';
import { releaseUsage, reserveUsage, settleUsage } from '../usage.service';
import { describePreferences } from '../ai/preferences';
import { getAudioTools } from '../audio';
import { saveAudio } from '../../controllers/audioTools.controller';
import { copyStockToMedia } from '../../controllers/stock.controller';
import { searchStock, stockEnabled } from '../stock.service';
import { footageAnalysis } from './footage';
import { attachAnalyses, cutProblems, sourcesOf, type Cutaway, type ProjectJson, type Segment, type Source } from './sources';
import { cutStory, designMotion, designSound, designType, scoutAssets, writeBrief, type AssetPart, type Brief, type MotionPart, type SoundPart, type TypePart } from './crew';
import { compileEdit, frameFor, type AudioAsset, type CompiledEdit, type VisualAsset } from './compile';
import { editProblems } from './checks';
import { GOOD_ENOUGH, renderStoryboard, reviewDraft, type Review, type StoryboardFrame } from './review';

export interface DirectorInput {
  projectId: string;
  request: string;
  /** Recent conversation, oldest first */
  conversation: Array<{ role: 'user' | 'model'; text: string }>;
  /** The editor's project summary (as quick Cue gets it) */
  context: string;
  project: ProjectJson;
}

/** At most this many sources are watched and offered (the rest are left out of the edit) */
const MAX_SOURCES = 6;
const MAX_SFX = 6;
const MAX_VISUALS = 3;
/** Review rounds before the draft goes to the user anyway */
const MAX_REVIEWS = 2;
/** No new review round starts after this long (a round takes about a minute) */
const REVIEW_BUDGET_MS = 8 * 60 * 1000;

class Stopped extends Error {}

const SFX_PROMPTS: Record<string, string> = {
  whoosh: 'fast cinematic whoosh transition, short, clean',
  swoosh: 'quick airy swoosh, short',
  pop: 'short bubbly pop for a title appearing',
  riser: 'short tension riser building up, 1.5 seconds',
  hit: 'deep cinematic impact hit, punchy',
  click: 'crisp UI click',
  ding: 'bright notification ding',
  'camera-shutter': 'camera shutter click',
  'record-scratch': 'vinyl record scratch',
};

/** Starts a run (reserving one Director run) and carries it out in the background */
export async function startDirectorRun(userId: string, input: DirectorInput): Promise<IDirectorRun> {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  const usageJobId = `director:${uuidv4()}`;
  await reserveUsage(user._id, 'directorRuns', usageJobId, 1, getEffectiveQuota(user).maxDirectorRuns);
  const run = await DirectorRun.create({
    userId: user._id,
    projectId: input.projectId,
    request: input.request.slice(0, 4000),
    stage: 'queued',
    events: [{ at: new Date(), stage: 'queued', text: 'Starting' }],
    usageJobId,
  });
  void carryOut(String(run._id), input).catch((error) => logger.error('Director run crashed', { runId: String(run._id), error: (error as Error).message }));
  return run;
}

async function progress(runId: string, stage: DirectorStage, text: string, set: Record<string, unknown> = {}) {
  const run = await DirectorRun.findByIdAndUpdate(
    runId,
    { $set: { stage, ...set }, $push: { events: { $each: [{ at: new Date(), stage, text: text.slice(0, 500) }], $slice: -60 } } },
    { new: true }
  );
  if (run?.stopRequested) throw new Stopped();
}

async function carryOut(runId: string, input: DirectorInput): Promise<void> {
  const run = await DirectorRun.findById(runId);
  if (!run) return;
  const user = await User.findById(run.userId);
  if (!user) return;
  const started = Date.now();
  try {
    // --- Watching ---
    const sources = sourcesOf(input.project).slice(0, MAX_SOURCES);
    await progress(runId, 'watching', sources.length ? `Watching ${sources.length === 1 ? `"${sources[0].name}"` : `${sources.length} clips`}` : 'No footage in the project: working from your request');
    // Only the user's own files
    const owned = await File.find({ _id: { $in: sources.map((s) => s.fileId).filter((f) => Types.ObjectId.isValid(f)) }, userId: user._id }).select('_id metadata').lean();
    const ownedIds = new Set(owned.map((f) => String(f._id)));
    const mine = sources.filter((s) => ownedIds.has(s.fileId));
    for (const s of mine) {
      const meta = owned.find((f) => String(f._id) === s.fileId)?.metadata as any;
      if (!s.duration && meta?.duration) s.duration = Number(meta.duration);
      s.width = Number(meta?.width) || 0;
      s.height = Number(meta?.height) || 0;
    }
    const analyses = await Promise.all(mine.map((s) => footageAnalysis(s.fileId, user._id)));
    const watched = attachAnalyses(mine, analyses);
    const words: Record<string, Array<{ text: string; start: number; end: number }>> = {};
    for (const t of await Transcription.find({ fileId: { $in: watched.map((s) => s.fileId) } }).select('fileId words').lean()) {
      const list = (t.words ?? []).filter((w: any) => !w.type || w.type === 'word').map((w: any) => ({ text: String(w.text), start: Number(w.start), end: Number(w.end) }));
      if (list.length) words[String(t.fileId)] = list;
    }
    const seen = watched.filter((s) => s.analysis).length;
    await progress(runId, 'watching', seen ? `Watched ${seen} clip${seen === 1 ? '' : 's'}: ${watched.map((s) => s.analysis?.moments.length ?? 0).reduce((a, b) => a + b, 0)} moments worth using` : 'Could not watch the footage; using what is known about it');

    // --- Briefing ---
    await progress(runId, 'briefing', 'Director is writing the brief');
    const preferences = describePreferences((user as any).assistantPreferences).concat(((user as any).assistantMemory || []).map((m: any) => m.note)).filter(Boolean).join('\n');
    const conversation = input.conversation.slice(-8).map((m) => `${m.role === 'user' ? 'User' : 'Cue'}: ${m.text.slice(0, 800)}`).join('\n');
    const brief: Brief = await writeBrief({ request: input.request, conversation, project: input.context, sources: watched, preferences });
    await progress(runId, 'briefing', `Brief: ${brief.understood} (${brief.aspect}, ${brief.targetSeconds}s, ${brief.tone})`, { brief });

    // --- Cutting ---
    let segments: Segment[] = [];
    let cutaways: Cutaway[] = [];
    if (watched.length) {
      await progress(runId, 'cutting', 'Story editor is choosing the moments');
      let cut = await cutStory({ brief, sources: watched });
      for (let attempt = 0; attempt < 2; attempt++) {
        const problems = cutProblems(cut.segments, watched, brief.targetSeconds, cut.cutaways);
        if (!problems.length) break;
        await progress(runId, 'cutting', `Fixing the cut: ${problems[0]}`);
        cut = await cutStory({ brief, sources: watched, problems, previous: cut.segments, previousCutaways: cut.cutaways });
      }
      // Whatever still doesn't fit its source is clamped or dropped
      const byRef = new Map(watched.map((s) => [s.ref, s]));
      segments = cut.segments
        .filter((s) => byRef.has(s.source))
        .map((s) => ({ ...s, from: Math.max(0, s.from), to: Math.min(byRef.get(s.source)!.duration || s.to, s.to) }))
        .filter((s) => s.to - s.from >= 0.3);
      cutaways = keepValidCutaways(cut.cutaways, segments, watched);
      const length = segments.reduce((t, s) => t + s.to - s.from, 0);
      await progress(runId, 'cutting', `Cut: ${segments.length} moments${cutaways.length ? ` + ${cutaways.length} cutaways` : ''}, ${length.toFixed(1)}s`);
    }

    // --- Crafting (in parallel) ---
    await progress(runId, 'crafting', 'Titles, captions, motion, sound and B-roll are being designed');
    const frame = frameFor(brief.aspect, input.project);
    const settle = async <T>(label: string, job: Promise<T>): Promise<T | undefined> => {
      try {
        return await job;
      } catch (error) {
        logger.warn('Director specialist failed', { runId, label, error: (error as Error).message });
        return undefined;
      }
    };
    const wantsAssets = !!brief.assets && !/^none\b/i.test(brief.assets.trim());
    let parts: { type?: TypePart; motion?: MotionPart; sound?: SoundPart; assets?: AssetPart } = {};
    /** Runs the specialists named (all when none are), each with its review notes */
    const craft = async (only: Set<string> | null, notes: Review['notes'] = {}) => {
      const onCut = (key: string) => ({ brief, segments, cutaways, sources: watched, frame, notes: notes[key as keyof Review['notes']] });
      const want = (key: string) => !only || only.has(key);
      const [type, motion, sound, assets] = await Promise.all([
        want('type') ? settle<TypePart>('type', designType(onCut('type'))) : Promise.resolve(parts.type),
        want('motion') && segments.length ? settle<MotionPart>('motion', designMotion(onCut('motion'))) : Promise.resolve(parts.motion),
        want('sound') ? settle<SoundPart>('sound', designSound(onCut('sound'))) : Promise.resolve(parts.sound),
        want('assets') && (wantsAssets || notes.assets) ? settle<AssetPart>('assets', scoutAssets(onCut('assets'))) : Promise.resolve(parts.assets),
      ]);
      // A specialist that failed this time keeps its last answer
      parts = { type: type ?? parts.type, motion: motion ?? parts.motion, sound: sound ?? parts.sound, assets: assets ?? parts.assets };
    };
    await craft(null);
    await progress(runId, 'crafting', craftSummary(parts), { parts });

    // --- Assembling ---
    let sfx: Array<{ at: number; asset: AudioAsset }> = [];
    let visuals: VisualAsset[] = [];
    const assemble = async () => {
      const total = segments.reduce((t, s) => t + s.to - s.from, 0);
      sfx = await soundEffects(user, (parts.sound?.sfx ?? []).filter((s) => s.at >= 0 && s.at < total).slice(0, MAX_SFX));
      visuals = await pictures(user, parts.assets?.assets ?? []);
      return compileEdit({ original: input.project, brief, sources: watched, segments, cutaways, ...parts, sfx, visuals, words });
    };
    await progress(runId, 'assembling', 'Making sound effects and putting the edit together');
    let edit: CompiledEdit = await assemble();
    let problems = editProblems(edit);

    // --- Reviewing: the director looks at real frames; revisions until it's good enough ---
    const reviews: Array<Review & { round: number; frames: Array<Omit<StoryboardFrame, 'bytes'>> }> = [];
    let storyboard: Array<Omit<StoryboardFrame, 'bytes'>> = [];
    for (let round = 1; round <= MAX_REVIEWS; round++) {
      if (Date.now() - started > REVIEW_BUDGET_MS) break;
      await progress(runId, 'reviewing', round === 1 ? 'Director is watching the draft' : `Director is checking revision ${round - 1}`);
      let review: Review;
      let frames: StoryboardFrame[] = [];
      try {
        frames = await renderStoryboard(edit, String(user._id), runId, round);
        review = await reviewDraft({ brief, request: input.request, edit, frames, problems, round });
      } catch (error) {
        logger.warn('Director review failed; the draft goes as it is', { runId, error: (error as Error).message });
        break;
      }
      storyboard = frames.map(({ bytes: _bytes, ...f }) => f);
      reviews.push({ ...review, round, frames: storyboard });
      const verdict = `Score ${review.score}/10${review.issues.length ? `: ${review.issues[0].problem}` : ''}`;
      await progress(runId, 'reviewing', verdict, { reviews });
      if (review.verdict === 'ship' || review.score >= GOOD_ENOUGH || round === MAX_REVIEWS) break;

      // --- Revising: only the parts with notes (a new cut means everything on it is redone) ---
      const asked = new Set(Object.keys(review.notes));
      for (const i of review.issues) asked.add(i.who);
      const notes = { ...review.notes };
      for (const i of review.issues) notes[i.who] = [notes[i.who], `${i.problem} → ${i.fix}`].filter(Boolean).join('\n');
      await progress(runId, 'revising', `Revising: ${[...asked].map((a) => CREW_WORDS[a] ?? a).join(', ')}`);
      if (asked.has('story') && watched.length) {
        const recut = await cutStory({ brief, sources: watched, previous: segments, previousCutaways: cutaways, notes: notes.story });
        const fixed = cutProblems(recut.segments, watched, brief.targetSeconds);
        if (!fixed.some((p) => /outside|no source|before it starts/.test(p))) {
          segments = recut.segments;
          cutaways = keepValidCutaways(recut.cutaways, segments, watched);
        }
        await craft(null, notes);
      } else {
        await craft(asked, notes);
      }
      edit = await assemble();
      problems = editProblems(edit);
    }

    const last = reviews[reviews.length - 1];
    const result = { ...edit, summary: summaryOf(brief, edit), problems, storyboard, review: last ? { score: last.score, strengths: last.strengths, rounds: reviews.length } : null };
    await progress(runId, 'done', `Ready in ${Math.round((Date.now() - started) / 1000)}s`, { result });
    await settleUsage(user._id, 'directorRuns', run.usageJobId);
  } catch (error) {
    const stopped = error instanceof Stopped;
    if (!stopped) logger.error('Director run failed', { runId, error: (error as Error).message });
    await DirectorRun.findByIdAndUpdate(runId, {
      $set: { stage: stopped ? 'stopped' : 'failed', ...(stopped ? {} : { error: friendly(error) }) },
      $push: { events: { at: new Date(), stage: stopped ? 'stopped' : 'failed', text: stopped ? 'Stopped' : friendly(error) } },
    });
    await releaseUsage('directorRuns', run.usageJobId, stopped ? 'stopped' : 'failed').catch(() => undefined);
  }
}

/** Cutaways that fit their piece and source (the rest are dropped) */
function keepValidCutaways(cutaways: Cutaway[], segments: Segment[], sources: Source[]): Cutaway[] {
  return cutaways.filter((c) => !cutProblems(segments, sources, undefined, [c]).some((p) => p.startsWith('Cutaway')));
}

const CREW_WORDS: Record<string, string> = { story: 'the cut', type: 'titles and captions', motion: 'motion', sound: 'sound', assets: 'B-roll' };

function craftSummary(parts: { type?: TypePart; motion?: MotionPart; sound?: SoundPart; assets?: AssetPart }): string {
  const { type, motion, sound, assets } = parts;
  return [type && `${type.titles.length} title${type.titles.length === 1 ? '' : 's'}${type.captions.use ? ' + captions' : ''}`, motion && `${motion.pieces.filter((p) => p.move !== 'none').length} moves`, sound && `${sound.sfx.length} sound effects`, assets?.assets.length ? `${assets.assets.length} B-roll` : ''].filter(Boolean).join(', ') || 'Designed';
}

function friendly(error: unknown): string {
  const message = (error as any)?.message || String(error);
  if (/busy|rate/i.test(message)) return 'The AI models are busy right now. Try again in a minute.';
  return "Cue Director couldn't finish this edit. Try again, or say it another way.";
}

function summaryOf(brief: Brief, edit: CompiledEdit) {
  const count = (g: keyof CompiledEdit['groups']) => edit.groups[g]?.length ?? 0;
  return {
    understood: brief.understood,
    platform: brief.platform,
    aspect: brief.aspect,
    seconds: edit.project.duration,
    tone: brief.tone,
    hook: brief.hook,
    beats: brief.structure,
    counts: { clips: count('cut'), titles: count('titles'), captions: count('captions'), motion: count('motion'), sounds: count('sound'), extras: count('extras') },
  };
}

/** One file per kind of sound effect per user, made once and reused */
async function soundEffects(user: any, wanted: Array<{ at: number; kind: string }>): Promise<Array<{ at: number; asset: AudioAsset }>> {
  const out: Array<{ at: number; asset: AudioAsset }> = [];
  const made = new Map<string, AudioAsset | null>();
  for (const s of wanted) {
    if (!made.has(s.kind)) {
      const name = `SFX - ${s.kind} (Cue)`;
      const existing = await File.findOne({ userId: user._id, source: 'sound_effect', name: `${name}.mp3`, status: 'ready' }).lean();
      if (existing) made.set(s.kind, { url: existing.cdnUrl, fileId: String(existing._id), duration: Number((existing.metadata as any)?.duration) || 1 });
      else {
        try {
          const audio = await getAudioTools().soundEffect(SFX_PROMPTS[s.kind] ?? s.kind, s.kind === 'riser' ? 1.6 : 1);
          const saved = await saveAudio(user, audio, `${name}.mp3`, 'sound_effect');
          made.set(s.kind, { url: saved.url, fileId: saved.fileId, duration: saved.duration });
        } catch (error) {
          logger.warn('Director sound effect failed', { kind: s.kind, error: (error as Error).message });
          made.set(s.kind, null);
        }
      }
    }
    const asset = made.get(s.kind);
    if (asset) out.push({ at: s.at, asset });
  }
  return out;
}

/** Stock pictures for the asset scout's picks (AI images are left as suggestions for now) */
async function pictures(user: any, wanted: AssetPart['assets']): Promise<VisualAsset[]> {
  if (!stockEnabled()) return [];
  const out: VisualAsset[] = [];
  for (const a of wanted.filter((x) => x.kind !== 'ai-image').slice(0, MAX_VISUALS)) {
    try {
      const kind = a.kind === 'stock-video' ? 'video' : 'photo';
      const found = await searchStock(kind, a.query, 1);
      const first = found.items[0];
      if (!first) continue;
      const file = await copyStockToMedia(user, kind, first.id);
      out.push({ kind: kind === 'video' ? 'video' : 'image', url: file.url, fileId: file.fileId, duration: file.duration, start: a.start, end: a.end, placement: a.placement });
    } catch (error) {
      logger.warn('Director stock pick failed', { query: a.query, error: (error as Error).message });
    }
  }
  return out;
}

/** Asks a running run to stop (it stops at the next stage) */
export async function stopDirectorRun(runId: string, userId: string): Promise<IDirectorRun | null> {
  return DirectorRun.findOneAndUpdate({ _id: runId, userId, stage: { $nin: ['done', 'failed', 'stopped'] } }, { $set: { stopRequested: true } }, { new: true });
}
