// services/director/review.ts
//
// The director looks at the draft before the user does. A storyboard of
// real frames (the hook, the middle of each piece, each title, the end) is
// rendered on Remotion Lambda with the same composition the export uses,
// so what the director judges is what the user would get: unreadable text,
// a bad crop, a face covered by a title. The director scores it against the
// brief and, when it isn't good enough, writes notes for the specialists
// who need to redo their part.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { renderStillOnLambda, type AwsRegion } from '@remotion/lambda-client';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { uploadBufferToS3 } from '../storage.service';
import { getGeminiClient } from '../ai/gemini';
import type { Brief } from './crew';
import { clipLength, type CompiledEdit } from './compile';
import { clock } from './sources';

export interface StoryboardFrame {
  time: number;
  /** What should be there (for the reviewer) */
  label: string;
  url?: string;
  bytes?: Buffer;
}

export interface Review {
  score: number;
  verdict: 'ship' | 'revise';
  strengths: string[];
  issues: Array<{ who: Crew; problem: string; fix: string }>;
  notes: Partial<Record<Crew, string>>;
}

export type Crew = 'story' | 'type' | 'motion' | 'sound' | 'assets';

/** At or above this the draft goes to the user */
export const GOOD_ENOUGH = 8;
const MAX_FRAMES = 8;

/** The moments worth looking at: the opening, each piece, each title, the end */
export function storyboardTimes(edit: CompiledEdit): StoryboardFrame[] {
  const duration = Number(edit.project.duration) || 0;
  const byId = new Map(edit.elements.map((e) => [e.id, e]));
  const wanted: StoryboardFrame[] = [{ time: Math.min(0.4, duration / 2), label: 'the opening (hook)' }];
  const titles = (edit.groups.titles ?? []).map((id) => byId.get(id)).filter(Boolean) as Array<Record<string, any>>;
  for (const t of titles) wanted.push({ time: t.time + Math.min(0.7, clipLength(t) / 2), label: `title "${t.text}"` });
  const cut = (edit.groups.cut ?? []).map((id) => byId.get(id)).filter(Boolean) as Array<Record<string, any>>;
  cut.forEach((c, i) => wanted.push({ time: c.time + clipLength(c) / 2, label: `piece #${i + 1}` }));
  wanted.push({ time: Math.max(0, duration - 0.3), label: 'the ending' });
  // Close times merge (labels joined); spread evenly when there are too many
  const merged: StoryboardFrame[] = [];
  for (const f of wanted.sort((a, b) => a.time - b.time)) {
    const last = merged[merged.length - 1];
    if (last && f.time - last.time < 0.6) last.label = `${last.label}, ${f.label}`;
    else merged.push({ ...f, time: Math.max(0, Math.min(duration - 0.05, f.time)) });
  }
  if (merged.length <= MAX_FRAMES) return merged;
  const keep = new Set([0, merged.length - 1]);
  for (let k = 1; keep.size < MAX_FRAMES; k++) keep.add(Math.round((k * (merged.length - 1)) / (MAX_FRAMES - 1)));
  return merged.filter((_, i) => keep.has(i));
}

let remotionS3: S3Client | null = null;
function bucketClient(): S3Client {
  if (!remotionS3) {
    const accessKeyId = env.remotionAwsAccessKeyID || env.awsAccessKeyId;
    const secretAccessKey = env.remotionAwsSecretAccessKey || env.awsSecretAccessKey;
    remotionS3 = new S3Client({ region: env.awsRegion, ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}) });
  }
  return remotionS3;
}

export type StillRenderer = (edit: CompiledEdit, frame: number, scale: number) => Promise<Buffer>;

const lambdaStill: StillRenderer = async (edit, frame, scale) => {
  const out = await renderStillOnLambda({
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
    serveUrl: env.remotionServeUrl,
    composition: 'VideoEditor',
    inputProps: { projectSettings: edit.project, elements: edit.elements },
    frame,
    imageFormat: 'jpeg',
    jpegQuality: 72,
    scale,
    privacy: 'private',
    maxRetries: 1,
    timeoutInMilliseconds: 90_000,
  });
  const object = await bucketClient().send(new GetObjectCommand({ Bucket: out.bucketName, Key: out.outKey }));
  return Buffer.from(await object.Body!.transformToByteArray());
};

let stillOverride: StillRenderer | null = null;
/** Tests: render stills with `renderer` instead (null: Lambda) */
export function setStillRenderer(renderer: StillRenderer | null) {
  stillOverride = renderer;
}

/** Renders the storyboard (small frames) and keeps a copy in the user's storage for the editor to show */
export async function renderStoryboard(edit: CompiledEdit, userId: string, runId: string, round: number): Promise<StoryboardFrame[]> {
  const frames = storyboardTimes(edit);
  const fps = Number(edit.project.fps) || 30;
  const longest = Math.max(Number(edit.project.width) || 1080, Number(edit.project.height) || 1920);
  const scale = Math.min(1, 720 / longest);
  const render = stillOverride ?? lambdaStill;
  const done = await Promise.all(
    frames.map(async (f, i) => {
      try {
        const bytes = await render(edit, Math.round(f.time * fps), scale);
        const url = await uploadBufferToS3(bytes, `users/${userId}/director/${runId}/r${round}-f${i + 1}.jpg`, 'image/jpeg');
        return { ...f, bytes, url };
      } catch (error) {
        logger.warn('Storyboard frame failed', { runId, time: f.time, error: (error as Error).message });
        return f;
      }
    })
  );
  return done;
}

const N = (d: string) => ({ type: 'STRING', description: d });
const CREW = ['story', 'type', 'motion', 'sound', 'assets'];
const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER', description: '1–10 against the brief: 8+ = a strong edit you would post, 6–7 = decent but clearly improvable, ≤5 = weak' },
    verdict: { type: 'STRING', enum: ['ship', 'revise'] },
    strengths: { type: 'ARRAY', items: N('What works') },
    issues: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { who: { type: 'STRING', enum: CREW }, problem: N('What is wrong, concretely (which frame/time)'), fix: N('Exactly what to change') }, required: ['who', 'problem', 'fix'] },
    },
    notes: {
      type: 'OBJECT',
      description: 'For each specialist who must redo their part: the instructions. Leave out the ones whose part is fine.',
      properties: Object.fromEntries(CREW.map((c) => [c, N(`Notes for ${c}`)])),
    },
  },
  required: ['score', 'verdict', 'strengths', 'issues', 'notes'],
};

/** The edit in words (what plays when) for the reviewer */
export function describeEdit(edit: CompiledEdit): string {
  const lines: string[] = [`Frame ${edit.project.width}×${edit.project.height}, ${edit.project.duration}s`];
  const sorted = [...edit.elements].sort((a, b) => a.time - b.time);
  for (const e of sorted) {
    const span = `${clock(e.time)}–${clock(e.time + clipLength(e))}`;
    if (e.type === 'video') lines.push(`${span} clip "${e.name}" (source ${clock(e.trimStart)}–${clock(e.trimStart + e.trimDuration)})${e.transition ? ` in with ${e.transition.type}` : ''}${e.keyframes ? ` moves: ${Object.keys(e.keyframes).join('+')}` : ''}${e.muted ? ' muted' : ''}${e.opacityEnabled && e.opacity === 0 ? ' (heard, not seen)' : ''}${e.anchorY === 0 && parseFloat(String(e.height)) > 100 ? ' (zoomed so the footage\'s own burned-in captions are below the frame: any captions you see are the fresh ones)' : ''}`);
    else if (e.type === 'text') lines.push(`${span} title "${e.text}" at y ${e.y}${e.enter ? `, ${e.enter.type} in` : ''}`);
    else if (e.type === 'caption') lines.push(`${span} captions (${e.displayMode}, ${e.wordsPerLine} words a line, one line at a time, y ${e.y}): "${e.transcription.words.map((w: any) => w.word).join(' ').slice(0, 300)}"`);
    else if (e.type === 'audio') lines.push(`${span} ${e.name}`);
    else lines.push(`${span} ${e.type} "${e.name}"`);
  }
  return lines.join('\n');
}

export async function reviewDraft(input: { brief: Brief; request: string; edit: CompiledEdit; frames: StoryboardFrame[]; problems: string[]; round: number }): Promise<Review> {
  const system = `You are the director reviewing your crew's draft before the client sees it. You have the brief, the edit as a timeline, and real rendered frames from it.
Judge it as the audience would on their phone: does the first second stop the scroll? Is every word readable (size, contrast, not cut off, not under app buttons, not covering faces)? Is the framing right (subject in frame after the crop to this shape)? Does the pacing hold? Does it deliver the brief and the request?
Some looks come from the footage itself (dissolves or text already edited into it): when a frame shows that, the fix is the story editor's (choose a span without it), not a rendering fault.
Be demanding but fair: only ask for changes that clearly improve it, and say exactly what to change. Round ${input.round}: from round 2, ship unless something is still clearly wrong.`;
  const frames = input.frames.filter((f) => f.bytes);
  const text = `REQUEST\n${input.request}\n\nBRIEF\n${JSON.stringify(input.brief, null, 1)}\n\nTHE EDIT\n${describeEdit(input.edit)}${
    input.problems.length ? `\n\nAUTOMATIC CHECKS FOUND\n- ${input.problems.join('\n- ')}` : ''
  }\n\nFRAMES (in order)\n${frames.map((f, i) => `Image ${i + 1}: ${clock(f.time)} — ${f.label}`).join('\n') || '(no frames could be rendered: judge from the timeline)'}`;
  const result = await getGeminiClient().generate({
    model: env.directorModel,
    fallback: env.aiModelStrong,
    system,
    messages: [{ role: 'user', text, media: frames.map((f) => ({ mimeType: 'image/jpeg', data: f.bytes!.toString('base64') })) }],
    jsonSchema: REVIEW_SCHEMA,
    thinking: 'high',
    timeoutMs: 90_000,
    patient: true,
  });
  const r = (result.json ?? {}) as Partial<Review>;
  const score = Math.max(1, Math.min(10, Math.round(Number(r.score) || 5)));
  return {
    score,
    verdict: r.verdict === 'ship' || score >= GOOD_ENOUGH ? 'ship' : 'revise',
    strengths: (r.strengths ?? []).map(String).slice(0, 8),
    issues: (r.issues ?? []).filter((i) => CREW.includes(i.who)).slice(0, 12),
    notes: Object.fromEntries(Object.entries(r.notes ?? {}).filter(([k, v]) => CREW.includes(k) && typeof v === 'string' && v.trim())) as Review['notes'],
  };
}

export interface Verdict {
  hook: number;
  pacing: number;
  readability: number;
  framing: number;
  fitsRequest: number;
  overall: number;
  biggestProblem: string;
  wouldPost: boolean;
}

const VERDICT_SCHEMA = {
  type: 'OBJECT',
  properties: Object.fromEntries([
    ...['hook', 'pacing', 'readability', 'framing', 'fitsRequest', 'overall'].map((k) => [k, { type: 'INTEGER', description: '1–10' }]),
    ['biggestProblem', { type: 'STRING' }],
    ['wouldPost', { type: 'BOOLEAN' }],
  ]),
  required: ['hook', 'pacing', 'readability', 'framing', 'fitsRequest', 'overall', 'biggestProblem', 'wouldPost'],
};

/**
 * An independent judge for evals (not the director grading its own work):
 * a harsh head of content scores the finished edit from its frames and
 * timeline. Null when there is nothing to judge.
 */
export async function judgeEdit(result: CompiledEdit & { storyboard?: StoryboardFrame[] }, request: string): Promise<Verdict | null> {
  const frames = (result.storyboard ?? []).filter((f) => f.url);
  const images = (
    await Promise.all(
      frames.map(async (f) => {
        try {
          const res = await fetch(f.url!, { signal: AbortSignal.timeout(15_000) });
          return res.ok ? { f, bytes: Buffer.from(await res.arrayBuffer()) } : null;
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean) as Array<{ f: StoryboardFrame; bytes: Buffer }>;
  if (!images.length && !result.elements.length) return null;
  const out = await getGeminiClient().generate({
    model: env.directorModel,
    fallback: env.aiModelStrong,
    system:
      'You are a harsh head of content at a social video agency judging an edit from its storyboard frames and timeline. Score 1–10 each: hook (the first second), pacing, readability (text size, contrast, inside the frame and safe area), framing (subjects well framed in this shape), fitsRequest. overall = how well it would perform. Most edits are 4–6; 8+ only if you would post it as is.',
    messages: [
      {
        role: 'user',
        text: `REQUEST: ${request}\n\nTIMELINE\n${describeEdit(result)}\n\nFRAMES: ${images.map((x, i) => `image ${i + 1} at ${clock(x.f.time)} (${x.f.label})`).join('; ') || 'none'}`,
        media: images.map((x) => ({ mimeType: 'image/jpeg', data: x.bytes.toString('base64') })),
      },
    ],
    jsonSchema: VERDICT_SCHEMA,
    thinking: 'high',
    timeoutMs: 120_000,
    patient: true,
  });
  return out.json as Verdict;
}
