// services/dubbing.service.ts
//
// Dubbing a video or audio file into another language. The file's sound
// (audio only: no watermark, smaller upload) goes to the provider; a new
// media file waits in 'processing' (source 'dubbing', `dub` says which job)
// until the dub is ready, then holds the dubbed MP3. Minutes are reserved when
// it starts (job id = the new file's id), charged when it's ready, refunded if
// it fails. Whoever looks first moves it on: the editor polling, or the
// maintenance sweep (so a dub finishes even if the editor was closed).

import { v4 as uuidv4 } from 'uuid';
import { File, type IFile } from '../models/File';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { probeMedia, summarizeProbe } from '../utils/media';
import { extractAudioMp3 } from '../utils/audioEncode';
import { getAudioTools } from './audio';
import { uploadBufferToS3 } from './storage.service';
import { quotaService } from './quota.service';
import { releaseUsage, reserveUsage, settleUsage } from './usage.service';

/** Languages offered for dubbing (ISO 639-1 → name) */
export const DUB_LANGUAGES: Record<string, string> = {
  hi: 'Hindi',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ta: 'Tamil',
  id: 'Indonesian',
  ru: 'Russian',
  tr: 'Turkish',
};

/** The longest source dubbed at once */
export const DUB_MAX_SECONDS = 5 * 60;
/** A dub still not ready after this has failed */
const DUB_GIVE_UP_MS = 2 * 60 * 60 * 1000;

export interface DubView {
  fileId: string;
  status: 'processing' | 'ready' | 'failed';
  language: string;
  expectedSeconds?: number;
  error?: string;
  file?: { fileId: string; name: string; url: string; mimeType: string; size: number; duration: number };
}

export function dubView(file: IFile): DubView {
  const view: DubView = {
    fileId: String(file._id),
    status: file.status === 'ready' ? 'ready' : file.status === 'failed' ? 'failed' : 'processing',
    language: file.dub?.language ?? '',
    expectedSeconds: file.dub?.expectedSeconds,
  };
  if (file.status === 'failed') view.error = file.importError || "The dub didn't work. Try again.";
  if (file.status === 'ready') {
    view.file = {
      fileId: String(file._id),
      name: file.name,
      url: file.cdnUrl!,
      mimeType: file.mimeType,
      size: file.size,
      duration: Number((file.metadata as any)?.duration) || 0,
    };
  }
  return view;
}

/** Starts a dub of `source` (the user's audio or video file) into `language`. */
export async function startDub(user: any, source: IFile, language: string, limitMinutes: number): Promise<IFile> {
  const seconds = Number((source.metadata as any)?.duration) || 0;
  if (seconds > DUB_MAX_SECONDS) {
    throw ApiError.withCode(400, 'AUDIO_TOO_LONG', `Dubbing works on up to ${DUB_MAX_SECONDS / 60} minutes at a time.`);
  }
  const base = (source.name.replace(/\.[^.]+$/, '') || 'Audio').replace(/[\\/:*?"<>|]/g, '').trim();
  const name = `${base} (${DUB_LANGUAGES[language]}).mp3`;
  const key = `users/${user._id}/uploads/${uuidv4()}.mp3`;
  const file = await File.create({
    userId: user._id,
    name,
    originalName: name,
    mimeType: 'audio/mpeg',
    size: 0,
    storageKey: key,
    cdnUrl: `${env.cdnUrl}/${key}`,
    status: 'processing',
    source: 'dubbing',
    dub: { id: '', language, sourceFileId: String(source._id) },
  });
  const jobId = String(file._id);
  try {
    await reserveUsage(user._id, 'dubbingMinutes', jobId, Math.max(1, seconds), limitMinutes);
  } catch (error) {
    await File.deleteOne({ _id: file._id });
    throw error;
  }
  try {
    let audio: Buffer;
    try {
      audio = await extractAudioMp3(source.cdnUrl!);
    } catch (error) {
      if ((error as Error).message === 'NO_AUDIO') throw ApiError.withCode(400, 'NO_AUDIO', 'This file has no sound to dub.');
      throw ApiError.withCode(422, 'AUDIO_UNREADABLE', "We couldn't read this file's sound.");
    }
    const job = await getAudioTools().startDub(audio, `${base}.mp3`, language);
    await File.updateOne({ _id: file._id }, { $set: { 'dub.id': job.id, 'dub.expectedSeconds': job.expectedSeconds } });
    logger.info('Dub started', { fileId: jobId, dubbingId: job.id, language, seconds });
    return (await File.findById(file._id))!;
  } catch (error) {
    await File.deleteOne({ _id: file._id });
    await releaseUsage('dubbingMinutes', jobId, 'start_failed').catch(() => undefined);
    throw error;
  }
}

async function failDub(file: IFile, reason: string) {
  const moved = await File.updateOne({ _id: file._id, status: 'processing' }, { status: 'failed', importError: reason });
  if (moved.modifiedCount) {
    await releaseUsage('dubbingMinutes', String(file._id), 'dub_failed').catch(() => undefined);
    if (file.dub?.id) await getAudioTools().deleteDub(file.dub.id);
    logger.warn('Dub failed', { fileId: String(file._id), reason });
  }
}

/** Checks a processing dub with the provider and finishes or fails it. Returns the file as it is now. */
export async function advanceDub(file: IFile): Promise<IFile> {
  if (file.status !== 'processing' || file.source !== 'dubbing') return file;
  if (!file.dub?.id) {
    // Starting crashed half-way
    if (Date.now() - new Date(file.createdAt).getTime() > 10 * 60 * 1000) await failDub(file, "The dub didn't start. Try again.");
    return (await File.findById(file._id)) ?? file;
  }
  let status;
  try {
    status = await getAudioTools().dubStatus(file.dub.id);
  } catch (error) {
    logger.warn('Could not check dub', { fileId: String(file._id), error: (error as Error).message });
    return file; // try again later
  }
  if (status.state === 'failed') {
    await failDub(file, "The dub didn't work. Try a clip with clearer speech.");
  } else if (status.state === 'dubbed') {
    const audio = await getAudioTools().dubbedAudio(file.dub.id, file.dub.language);
    const cdnUrl = await uploadBufferToS3(audio, file.storageKey, 'audio/mpeg');
    let duration = audio.length / 16_000;
    try {
      duration = summarizeProbe(await probeMedia(cdnUrl)).duration || duration;
    } catch {
      // keep the estimate
    }
    const done = await File.findOneAndUpdate(
      { _id: file._id, status: 'processing' },
      { status: 'ready', size: audio.length, cdnUrl, metadata: { duration, width: 0, height: 0, hasAudio: true } },
      { new: true }
    );
    if (done) {
      await quotaService.addStorageUsage(String(file.userId), audio.length, String(file._id));
      await settleUsage(file.userId, 'dubbingMinutes', String(file._id));
      await getAudioTools().deleteDub(file.dub.id);
      logger.info('Dub ready', { fileId: String(file._id), language: file.dub.language });
    }
  } else if (Date.now() - new Date(file.createdAt).getTime() > DUB_GIVE_UP_MS) {
    await failDub(file, 'The dub took too long. Try again.');
  }
  return (await File.findById(file._id)) ?? file;
}
