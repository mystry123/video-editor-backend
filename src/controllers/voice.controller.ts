// controllers/voice.controller.ts
//
//   GET    /voice/voices            the provider's voices and options, plus the user's own voice
//   POST   /voice/speech            text to speech: a new MP3 in their media
//   POST   /voice/preview           a short sample of a voice (providers without hosted previews)
//   POST   /voice/own/sample-url    where to upload a sample for their own voice
//   POST   /voice/own               make their own voice from that sample
//   DELETE /voice/own               delete their own voice
//
// The provider (ElevenLabs or Sarvam) comes from services/tts; what it can
// do (languages, speed range, previews, own voices) shapes these responses.
// Speech is metered in characters (ttsCharacters, plan limit maxTtsCharacters)
// and the MP3 counts toward storage like any upload. An own voice needs
// voiceCloneAllowed, is one per user, and is made only from a sample recorded
// in the editor (source 'voice_sample', uploaded in the last hour), which is
// deleted once the voice is made.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { Transcription } from '../models/Transcription';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { probeMedia, summarizeProbe } from '../utils/media';
import { createPresignedUpload, deleteFromS3, getObjectSize, readObjectStart, uploadBufferToS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { releaseUsage, reserveUsage, settleUsage } from '../services/usage.service';
import { getTtsProvider, getTtsProviderById, type TtsProvider, type TtsProviderId } from '../services/tts';
import { assertCanStore } from './file.controller';

/** MP3 at 128 kbps is 16 KB a second; speech runs about 15 characters a second. */
const BYTES_PER_CHARACTER = 1100;

export const SAMPLE_TYPES: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
};
export const SAMPLE_MAX_BYTES = 25 * 1024 * 1024;
export const SAMPLE_SECONDS = { min: 20, max: 300 } as const;
const SAMPLE_MAX_AGE_MS = 60 * 60 * 1000;

/** Which provider made the user's own voice (voices from before providers were pluggable are ElevenLabs) */
function ownVoiceProvider(user: any): TtsProviderId | null {
  return user?.voiceClone?.voiceId ? user.voiceClone.provider || 'elevenlabs' : null;
}

/** Their own voice, if it works with `provider` */
function ownVoiceView(user: any, provider: TtsProvider) {
  return ownVoiceProvider(user) === provider.id && provider.ownVoices
    ? { id: user.voiceClone.voiceId, name: user.voiceClone.name, createdAt: user.voiceClone.createdAt }
    : null;
}

/** A language the provider speaks, or a 400 (undefined for providers that detect it) */
function resolveLanguage(provider: TtsProvider, language: string | undefined): string | undefined {
  if (!provider.languages) return undefined;
  const code = language || provider.languages[0].code;
  if (!provider.languages.some((l) => l.code === code)) {
    throw ApiError.withCode(400, 'LANGUAGE_NOT_SUPPORTED', 'Pick one of the listed languages.');
  }
  return code;
}

async function loadUser(req: AuthRequest) {
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** "Hey everyone, welcome back to…" from a script, for the file's name. */
export function speechFileName(text: string, voiceName: string, ext = 'mp3'): string {
  const words = text.replace(/\s+/g, ' ').trim();
  const snippet = words.length > 40 ? `${words.slice(0, 40).replace(/\s+\S*$/, '')}…` : words;
  const safe = `${snippet} - ${voiceName}`.replace(/[\\/:*?"<>|]/g, '').trim();
  return `${safe || 'Voiceover'}.${ext}`;
}

/**
 * A short sample of a voice in a language. For providers without hosted
 * previews: made once, kept in the media bucket, and shared by everyone
 * (not charged to the user).
 */
export const previewVoice = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { voiceId, language } = req.body as { voiceId: string; language?: string };
    const provider = getTtsProvider();
    if (!provider.previewSpeech) throw ApiError.withCode(400, 'PREVIEW_NOT_NEEDED', 'This voice has its own preview.');
    const lang = resolveLanguage(provider, language) ?? 'en';
    if (!(await provider.listVoices()).some((v) => v.id === voiceId)) {
      throw ApiError.withCode(404, 'VOICE_NOT_FOUND', "That voice isn't available. Pick another one.");
    }
    const base = `voice-previews/${provider.id}/${voiceId}-${lang}`;
    for (const ext of ['mp3', 'wav']) {
      if ((await getObjectSize(`${base}.${ext}`)) !== null) {
        res.json({ url: `${env.cdnUrl}/${base}.${ext}` });
        return;
      }
    }
    const speech = await provider.previewSpeech(voiceId, lang);
    res.json({ url: await uploadBufferToS3(speech.audio, `${base}.${speech.ext}`, speech.mimeType) });
  } catch (error) {
    next(error);
  }
};

export const listVoices = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await loadUser(req);
    const quota = getEffectiveQuota(user);
    const provider = getTtsProvider();
    res.json({
      voices: await provider.listVoices(),
      // null: the provider works out the language from the script
      languages: provider.languages,
      speed: provider.speedRange,
      // 'hosted': voices carry previewUrl; 'generated': ask POST /voice/preview
      previews: provider.previewSpeech ? 'generated' : 'hosted',
      ownVoice: ownVoiceView(user, provider),
      ownVoiceSupported: !!provider.ownVoices,
      ownVoiceAllowed: !!quota.voiceCloneAllowed && !!provider.ownVoices,
    });
  } catch (error) {
    next(error);
  }
};

export const createSpeech = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const jobId = uuidv4();
  let reserved = false;
  try {
    const { text, voiceId, speed, language } = req.body as { text: string; voiceId: string; speed?: number; language?: string };
    const user = await loadUser(req);
    const quota = getEffectiveQuota(user);
    const provider = getTtsProvider();
    const lang = resolveLanguage(provider, language);

    // Only the provider's voices and their own voice: never another user's
    const own = ownVoiceView(user, provider);
    const isOwn = own?.id === voiceId;
    const voiceName = isOwn ? own!.name : (await provider.listVoices()).find((v) => v.id === voiceId)?.name;
    if (!voiceName) throw ApiError.withCode(404, 'VOICE_NOT_FOUND', "That voice isn't available. Pick another one.");
    const { min, max } = provider.speedRange;
    const pace = Math.min(max, Math.max(min, speed ?? 1));

    const characters = text.length;
    assertCanStore(user, characters * BYTES_PER_CHARACTER, 'audio/mpeg');
    await reserveUsage(user._id, 'ttsCharacters', jobId, characters, quota.maxTtsCharacters);
    reserved = true;

    const speech = await provider.speak({ voiceId, text, speed: pace, language: lang, ownVoice: isOwn });
    const audio = speech.audio;
    assertCanStore(user, audio.length, speech.mimeType);

    const key = `users/${user._id}/uploads/${uuidv4()}.${speech.ext}`;
    const cdnUrl = await uploadBufferToS3(audio, key, speech.mimeType);
    let duration = speech.ext === 'mp3' ? audio.length / 16_000 : audio.length / 88_200;
    try {
      duration = summarizeProbe(await probeMedia(cdnUrl)).duration || duration;
    } catch (error) {
      logger.warn('Could not probe speech audio; using its size', { key, error: (error as Error).message });
    }

    const file = await File.create({
      userId: user._id,
      name: speechFileName(text, voiceName, speech.ext),
      originalName: speechFileName(text, voiceName, speech.ext),
      mimeType: speech.mimeType,
      size: audio.length,
      storageKey: key,
      cdnUrl,
      status: 'ready',
      source: 'tts',
      metadata: { duration, width: 0, height: 0, hasAudio: true },
    });
    await quotaService.addStorageUsage(String(user._id), audio.length, String(file._id));
    await settleUsage(user._id, 'ttsCharacters', jobId, characters);

    // The provider said when each word is spoken: that's the file's transcript,
    // so Generate Captions on this clip is instant and free
    let transcript: { words: unknown[]; language?: string } | null = null;
    if (speech.words?.some((w) => w.type === 'word')) {
      const words = speech.words;
      try {
        await Transcription.create({
          userId: user._id,
          fileId: file._id,
          text,
          words,
          language: lang,
          transcriptionModel: `${provider.id}-tts`,
          status: 'completed',
          duration,
          processedAt: new Date(),
        });
        transcript = { words, language: lang };
      } catch (e) {
        logger.warn('Could not save speech word timings', { fileId: String(file._id), error: (e as Error).message });
      }
    }

    res.status(201).json({
      file: { fileId: String(file._id), name: file.name, url: cdnUrl, mimeType: speech.mimeType, size: audio.length, duration },
      characters,
      // Word timings for captions (null: transcribe the clip instead)
      transcript,
    });
  } catch (error) {
    if (reserved) {
      await releaseUsage('ttsCharacters', jobId, 'speech_failed').catch((e) =>
        logger.error('Failed to release text-to-speech usage', { jobId, error: (e as Error).message })
      );
    }
    next(error);
  }
};

function assertOwnVoiceAllowed(user: any): TtsProvider {
  const provider = getTtsProvider();
  if (!provider.ownVoices) {
    throw ApiError.withCode(400, 'VOICE_CLONE_NOT_SUPPORTED', "Using your own voice isn't available right now.");
  }
  if (!getEffectiveQuota(user).voiceCloneAllowed) {
    throw ApiError.withCode(403, 'VOICE_CLONE_NOT_ALLOWED', 'Using your own voice is available on paid plans.');
  }
  if (ownVoiceProvider(user)) {
    throw ApiError.withCode(409, 'VOICE_EXISTS', 'You already have your own voice. Delete it to make a new one.');
  }
  return provider;
}

export const createSampleUpload = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { mimeType, size } = req.body as { mimeType: string; size: number };
    const user = await loadUser(req);
    assertOwnVoiceAllowed(user);
    const ext = SAMPLE_TYPES[mimeType];
    if (!ext) throw ApiError.withCode(400, 'UNSUPPORTED_FILE_TYPE', 'Record the sample in the editor.');
    if (size > SAMPLE_MAX_BYTES) throw ApiError.withCode(400, 'VOICE_SAMPLE_TOO_LARGE', 'The recording is too long. Keep it under 5 minutes.');

    const key = `users/${user._id}/voice-samples/${uuidv4()}.${ext}`;
    const { url, fields } = await createPresignedUpload({ key, contentType: mimeType, maxSize: SAMPLE_MAX_BYTES });
    // Not storage the user pays for: it's deleted as soon as the voice is made
    const file = await File.create({
      userId: user._id,
      name: `Voice sample.${ext}`,
      originalName: `Voice sample.${ext}`,
      mimeType,
      size,
      storageKey: key,
      cdnUrl: `${env.cdnUrl}/${key}`,
      status: 'processing',
      source: 'voice_sample',
    });
    res.json({ uploadUrl: url, fields, sampleId: String(file._id) });
  } catch (error) {
    next(error);
  }
};

export const createOwnVoice = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  let sample: any = null;
  try {
    const { sampleId, name } = req.body as { sampleId: string; name: string; consent: true };
    const user = await loadUser(req);
    const provider = assertOwnVoiceAllowed(user);

    sample = await File.findOne({ _id: sampleId, userId: user._id, source: 'voice_sample' });
    if (!sample || Date.now() - new Date(sample.createdAt).getTime() > SAMPLE_MAX_AGE_MS) {
      sample = null;
      throw ApiError.withCode(400, 'VOICE_SAMPLE_NOT_FOUND', 'Record your voice sample again.');
    }
    const bytes = await readObjectStart(sample.storageKey, SAMPLE_MAX_BYTES + 1);
    if (!bytes || bytes.length === 0) throw ApiError.withCode(400, 'VOICE_SAMPLE_NOT_FOUND', 'Record your voice sample again.');
    if (bytes.length > SAMPLE_MAX_BYTES) throw ApiError.withCode(400, 'VOICE_SAMPLE_TOO_LARGE', 'The recording is too long. Keep it under 5 minutes.');

    let seconds = 0;
    try {
      seconds = summarizeProbe(await probeMedia(sample.cdnUrl)).duration;
    } catch {
      throw ApiError.withCode(422, 'VOICE_SAMPLE_REJECTED', "We couldn't read that recording. Record it again.");
    }
    if (seconds < SAMPLE_SECONDS.min) {
      throw ApiError.withCode(422, 'VOICE_SAMPLE_TOO_SHORT', `Record at least ${SAMPLE_SECONDS.min} seconds. A minute works best.`);
    }
    if (seconds > SAMPLE_SECONDS.max + 5) {
      throw ApiError.withCode(400, 'VOICE_SAMPLE_TOO_LARGE', 'The recording is too long. Keep it under 5 minutes.');
    }

    const voiceId = await provider.ownVoices!.create(String(user._id), {
      bytes,
      mimeType: sample.mimeType,
      filename: sample.storageKey.split('/').pop()!,
    });
    // One voice per user, even if two requests got this far at once
    const saved = await User.updateOne(
      { _id: user._id, 'voiceClone.voiceId': { $exists: false } },
      { $set: { voiceClone: { voiceId, name, provider: provider.id, createdAt: new Date() } } }
    );
    if (saved.modifiedCount === 0) {
      await provider.ownVoices!.remove(voiceId).catch((e) => logger.error('Failed to delete duplicate voice', { voiceId, error: (e as Error).message }));
      throw ApiError.withCode(409, 'VOICE_EXISTS', 'You already have your own voice. Delete it to make a new one.');
    }
    logger.info('Own voice created', { userId: String(user._id), voiceId });
    res.status(201).json({ ownVoice: { id: voiceId, name, createdAt: new Date() } });
  } catch (error) {
    next(error);
  } finally {
    // The recording is never kept
    if (sample) {
      await deleteFromS3(sample.storageKey).catch((e) =>
        logger.warn('Failed to delete voice sample', { key: sample.storageKey, error: (e as Error).message })
      );
      await File.deleteOne({ _id: sample._id }).catch(() => undefined);
    }
  }
};

export const deleteOwnVoice = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await loadUser(req);
    // With the provider that made it, even if another one is in use now
    const madeWith = ownVoiceProvider(user);
    if (madeWith) {
      const voiceId = user.voiceClone!.voiceId;
      await getTtsProviderById(madeWith).ownVoices?.remove(voiceId);
      await User.updateOne({ _id: user._id, 'voiceClone.voiceId': voiceId }, { $unset: { voiceClone: '' } });
      logger.info('Own voice deleted', { userId: String(user._id), voiceId, provider: madeWith });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
