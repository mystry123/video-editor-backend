// controllers/voice.controller.ts
//
//   GET    /voice/voices            stock voices, plus the user's own voice
//   POST   /voice/speech            text to speech: a new MP3 in their media
//   POST   /voice/own/sample-url    where to upload a sample for their own voice
//   POST   /voice/own               make their own voice from that sample
//   DELETE /voice/own               delete their own voice
//
// Speech is metered in characters (ttsCharacters, plan limit maxTtsCharacters)
// and the MP3 counts toward storage like any upload. An own voice needs
// voiceCloneAllowed, is one per user, and is made only from a sample recorded
// in the editor (source 'voice_sample', uploaded in the last hour), which is
// deleted once the voice is made.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { probeMedia, summarizeProbe } from '../utils/media';
import { createPresignedUpload, deleteFromS3, readObjectStart, uploadBufferToS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { releaseUsage, reserveUsage, settleUsage } from '../services/usage.service';
import { cloneVoice, deleteVoice, findStockVoice, listStockVoices, textToSpeech } from '../services/voice.service';
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

function ownVoiceView(user: any) {
  return user?.voiceClone?.voiceId
    ? { id: user.voiceClone.voiceId, name: user.voiceClone.name, createdAt: user.voiceClone.createdAt }
    : null;
}

async function loadUser(req: AuthRequest) {
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** "Hey everyone, welcome back to…" from a script, for the file's name. */
export function speechFileName(text: string, voiceName: string): string {
  const words = text.replace(/\s+/g, ' ').trim();
  const snippet = words.length > 40 ? `${words.slice(0, 40).replace(/\s+\S*$/, '')}…` : words;
  const safe = `${snippet} - ${voiceName}`.replace(/[\\/:*?"<>|]/g, '').trim();
  return `${safe || 'Voiceover'}.mp3`;
}

export const listVoices = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await loadUser(req);
    const quota = getEffectiveQuota(user);
    res.json({
      voices: await listStockVoices(),
      ownVoice: ownVoiceView(user),
      ownVoiceAllowed: !!quota.voiceCloneAllowed,
    });
  } catch (error) {
    next(error);
  }
};

export const createSpeech = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const jobId = uuidv4();
  let reserved = false;
  try {
    const { text, voiceId, speed } = req.body as { text: string; voiceId: string; speed?: number };
    const user = await loadUser(req);
    const quota = getEffectiveQuota(user);

    // Only stock voices and their own voice: never another user's
    const own = ownVoiceView(user);
    const isOwn = own?.id === voiceId;
    const voiceName = isOwn ? own!.name : (await findStockVoice(voiceId))?.name;
    if (!voiceName) throw ApiError.withCode(404, 'VOICE_NOT_FOUND', "That voice isn't available. Pick another one.");

    const characters = text.length;
    assertCanStore(user, characters * BYTES_PER_CHARACTER, 'audio/mpeg');
    await reserveUsage(user._id, 'ttsCharacters', jobId, characters, quota.maxTtsCharacters);
    reserved = true;

    const audio = await textToSpeech(voiceId, text, { speed, ownVoice: isOwn });
    assertCanStore(user, audio.length, 'audio/mpeg');

    const key = `users/${user._id}/uploads/${uuidv4()}.mp3`;
    const cdnUrl = await uploadBufferToS3(audio, key, 'audio/mpeg');
    let duration = audio.length / 16_000;
    try {
      duration = summarizeProbe(await probeMedia(cdnUrl)).duration || duration;
    } catch (error) {
      logger.warn('Could not probe speech audio; using its size', { key, error: (error as Error).message });
    }

    const file = await File.create({
      userId: user._id,
      name: speechFileName(text, voiceName),
      originalName: speechFileName(text, voiceName),
      mimeType: 'audio/mpeg',
      size: audio.length,
      storageKey: key,
      cdnUrl,
      status: 'ready',
      source: 'tts',
      metadata: { duration, width: 0, height: 0, hasAudio: true },
    });
    await quotaService.addStorageUsage(String(user._id), audio.length, String(file._id));
    await settleUsage(user._id, 'ttsCharacters', jobId, characters);

    res.status(201).json({
      file: { fileId: String(file._id), name: file.name, url: cdnUrl, mimeType: 'audio/mpeg', size: audio.length, duration },
      characters,
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

function assertOwnVoiceAllowed(user: any) {
  if (!getEffectiveQuota(user).voiceCloneAllowed) {
    throw ApiError.withCode(403, 'VOICE_CLONE_NOT_ALLOWED', 'Using your own voice is available on paid plans.');
  }
  if (ownVoiceView(user)) {
    throw ApiError.withCode(409, 'VOICE_EXISTS', 'You already have your own voice. Delete it to make a new one.');
  }
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
    assertOwnVoiceAllowed(user);

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

    const voiceId = await cloneVoice(String(user._id), {
      bytes,
      mimeType: sample.mimeType,
      filename: sample.storageKey.split('/').pop()!,
    });
    // One voice per user, even if two requests got this far at once
    const saved = await User.updateOne(
      { _id: user._id, 'voiceClone.voiceId': { $exists: false } },
      { $set: { voiceClone: { voiceId, name, createdAt: new Date() } } }
    );
    if (saved.modifiedCount === 0) {
      await deleteVoice(voiceId).catch((e) => logger.error('Failed to delete duplicate voice', { voiceId, error: (e as Error).message }));
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
    const own = ownVoiceView(user);
    if (own) {
      await deleteVoice(own.id);
      await User.updateOne({ _id: user._id, 'voiceClone.voiceId': own.id }, { $unset: { voiceClone: '' } });
      logger.info('Own voice deleted', { userId: String(user._id), voiceId: own.id });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
