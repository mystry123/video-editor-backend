// controllers/audioTools.controller.ts
//
//   POST /voice/cleanup        { fileId }              the file's sound with background noise removed
//   POST /voice/sound-effect   { prompt, duration? }   a sound effect from a description
//
// Both make a new MP3 in the user's media (counted toward storage). Clean-up
// is metered in minutes of the source (audioCleanupMinutes), sound effects per
// effect (soundEffects); a failed request is refunded.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { probeMedia, summarizeProbe } from '../utils/media';
import { extractAudioMp3 } from '../utils/audioEncode';
import { uploadBufferToS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { releaseUsage, reserveUsage, settleUsage } from '../services/usage.service';
import { getAudioTools } from '../services/audio';
import { assertCanStore } from './file.controller';

/** The longest source cleaned in one go (the request waits for it) */
export const CLEANUP_MAX_SECONDS = 10 * 60;

/** A file name without characters that trouble downloads */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/** Saves generated audio as a new MP3 in the user's media. */
async function saveAudio(user: any, audio: Buffer, name: string, source: 'audio_cleanup' | 'sound_effect') {
  assertCanStore(user, audio.length, 'audio/mpeg');
  const key = `users/${user._id}/uploads/${uuidv4()}.mp3`;
  const cdnUrl = await uploadBufferToS3(audio, key, 'audio/mpeg');
  let duration = audio.length / 16_000;
  try {
    duration = summarizeProbe(await probeMedia(cdnUrl)).duration || duration;
  } catch (error) {
    logger.warn('Could not probe generated audio; using its size', { key, error: (error as Error).message });
  }
  const file = await File.create({
    userId: user._id,
    name,
    originalName: name,
    mimeType: 'audio/mpeg',
    size: audio.length,
    storageKey: key,
    cdnUrl,
    status: 'ready',
    source,
    metadata: { duration, width: 0, height: 0, hasAudio: true },
  });
  await quotaService.addStorageUsage(String(user._id), audio.length, String(file._id));
  return { fileId: String(file._id), name, url: cdnUrl, mimeType: 'audio/mpeg', size: audio.length, duration };
}

async function loadUser(req: AuthRequest) {
  const user = await User.findById(req.userId);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** Runs `work` with `amount` reserved; settles on success, refunds on failure. */
async function metered<T>(
  userId: Types.ObjectId,
  kind: 'audioCleanupMinutes' | 'soundEffects',
  amount: number,
  limit: number,
  work: () => Promise<T>
): Promise<T> {
  const jobId = uuidv4();
  await reserveUsage(userId, kind, jobId, amount, limit);
  try {
    const result = await work();
    await settleUsage(userId, kind, jobId, amount);
    return result;
  } catch (error) {
    await releaseUsage(kind, jobId, 'request_failed').catch((e) =>
      logger.error('Failed to release usage', { kind, jobId, error: (e as Error).message })
    );
    throw error;
  }
}

export const cleanUpAudio = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { fileId } = req.body as { fileId: string };
    const user = await loadUser(req);
    const file = await File.findOne({ _id: fileId, userId: user._id, status: 'ready' });
    if (!file || !file.cdnUrl) throw ApiError.notFound('File not found');
    if (!/^(audio|video)\//.test(file.mimeType)) throw ApiError.withCode(400, 'NOT_AUDIO', 'Only video and audio can be cleaned up.');
    if (file.metadata && (file.metadata as any).hasAudio === false) {
      throw ApiError.withCode(400, 'NO_AUDIO', "This video has no sound to clean up.");
    }

    const seconds = Number((file.metadata as any)?.duration) || 0;
    if (seconds > CLEANUP_MAX_SECONDS) {
      throw ApiError.withCode(400, 'AUDIO_TOO_LONG', `Clean-up works on up to ${CLEANUP_MAX_SECONDS / 60} minutes at a time.`);
    }

    const result = await metered(user._id, 'audioCleanupMinutes', Math.max(1, seconds), getEffectiveQuota(user).maxAudioCleanupMinutes, async () => {
      let source: Buffer;
      try {
        source = await extractAudioMp3(file.cdnUrl!);
      } catch (error) {
        if ((error as Error).message === 'NO_AUDIO') throw ApiError.withCode(400, 'NO_AUDIO', 'This file has no sound to clean up.');
        logger.error('Could not read audio for clean-up', { fileId, error: (error as Error).message });
        throw ApiError.withCode(422, 'AUDIO_UNREADABLE', "We couldn't read this file's sound.");
      }
      const clean = await getAudioTools().isolateVoice(source, 'source.mp3');
      const base = safeName(file.name.replace(/\.[^.]+$/, '')) || 'Audio';
      return saveAudio(user, clean, `${base} (clean).mp3`, 'audio_cleanup');
    });
    res.status(201).json({ file: result });
  } catch (error) {
    next(error);
  }
};

export const createSoundEffect = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { prompt, duration } = req.body as { prompt: string; duration?: number };
    const user = await loadUser(req);
    const result = await metered(user._id, 'soundEffects', 1, getEffectiveQuota(user).maxSoundEffects, async () => {
      const audio = await getAudioTools().soundEffect(prompt, duration);
      if (audio.length === 0) throw ApiError.withCode(503, 'VOICE_UNAVAILABLE', "Sound effects aren't available right now.");
      const label = safeName(prompt).slice(0, 40) || 'Sound effect';
      return saveAudio(user, audio, `SFX - ${label}.mp3`, 'sound_effect');
    });
    res.status(201).json({ file: result });
  } catch (error) {
    next(error);
  }
};
