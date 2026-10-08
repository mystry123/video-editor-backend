import { Response, NextFunction } from 'express';
import { enqueueJob } from '../utils/jobs';
import { AuthRequest } from '../types';
import { Transcription, ITranscriptionWord } from '../models/Transcription';
import { File } from '../models/File';
import { User } from '../models/User';
import { transcriptionQueue } from '../queues';
import { ApiError } from '../utils/ApiError';
import { Types } from 'mongoose';
import { getEffectiveQuota } from '../config/quotas';
import { releaseUsage, reserveUsage } from '../services/usage.service';

/** Queues a transcription; if the queue is unreachable, marks it failed and returns 503. */
async function queueTranscription(transcriptionId: string, fileUrl: string): Promise<void> {
  try {
    await enqueueJob(transcriptionQueue, 'transcribe', { transcriptionId, fileUrl }, { jobId: `transcription-${transcriptionId}` });
  } catch (error) {
    await Transcription.updateOne(
      { _id: transcriptionId, status: 'pending' },
      { status: 'failed', error: 'Transcription is temporarily unavailable. Try again in a minute.' }
    );
    await releaseUsage('transcriptionMinutes', transcriptionId, 'enqueue_failed');
    throw error;
  }
}

/**
 * Reserves the file's length in transcription minutes for this transcription
 * (atomic against the monthly limit). Settled with the real audio length when
 * it finishes, refunded if it fails.
 */
async function reserveTranscription(user: any, file: any, transcriptionId: string): Promise<void> {
  const seconds = Number(file.metadata?.duration) || 0;
  await reserveUsage(user._id, 'transcriptionMinutes', transcriptionId, seconds, getEffectiveQuota(user).maxTranscriptionMinutes);
}

export const createTranscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { fileId } = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file = await File.findOne({ _id: fileId, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    if (!file.mimeType.startsWith('audio/') && !file.mimeType.startsWith('video/')) {
      throw ApiError.badRequest('File must be audio or video');
    }

    const existing = await Transcription.findOne({ fileId });

    if (existing) {
      // A previous run that failed should be retryable - otherwise the only
      // way back is deleting the document by hand.
      if (existing.status === 'failed') {
        await reserveTranscription(user, file, existing._id.toString());
        existing.status = 'pending';
        existing.error = undefined;
        await existing.save();

        await queueTranscription(existing._id.toString(), file.cdnUrl!);

        res.status(202).json(existing);
        return;
      }

      res.status(200).json(existing);
      return;
    }

    const transcriptionId = new Types.ObjectId();
    await reserveTranscription(user, file, String(transcriptionId));

    let transcription;
    try {
      transcription = await Transcription.create({ _id: transcriptionId, userId: user._id, fileId, status: 'pending' });
    } catch (error: any) {
      await releaseUsage('transcriptionMinutes', String(transcriptionId), 'create_failed');
      // A parallel request created it first: return that one.
      if (error?.code === 11000) {
        res.status(200).json(await Transcription.findOne({ fileId }));
        return;
      }
      throw error;
    }

    await queueTranscription(transcription._id.toString(), file.cdnUrl!);

    res.status(201).json(transcription);
  } catch (error) {
    next(error);
  }
};

export const getTranscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const transcription = await Transcription.findOne({
      _id: id,
      userId: user._id,
    }).populate('fileId');

    if (!transcription) {
      throw ApiError.notFound('Transcription not found');
    }

    res.json(transcription);
  } catch (error) {
    next(error);
  }
};

export const getTranscriptionByFile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { fileId } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const transcription = await Transcription.findOne({
      fileId,
      userId: user._id,
    });

    if (!transcription) {
      throw ApiError.notFound('Transcription not found');
    }

    res.json(transcription);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/transcriptions/:id/words
 *
 * Replace the word list after the user has corrected it in the editor, so the
 * render uses exactly the captions they previewed.
 */
export const updateTranscriptionWords = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const { words } = req.body as {
      words: Array<{
        text: string;
        start: number;
        end: number;
        type?: ITranscriptionWord['type'];
        speaker_id?: string;
      }>;
    };

    const transcription = await Transcription.findOne({ _id: id, userId });
    if (!transcription) {
      throw ApiError.notFound('Transcription not found');
    }

    // Timing must stay usable for captions: in order, inside the media.
    const limit = Number(transcription.duration) > 0 ? Number(transcription.duration) + 0.5 : Infinity;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (i > 0 && word.start + 0.001 < words[i - 1].start) {
        throw ApiError.withCode(422, 'INVALID_WORD_TIMING', `Word ${i + 1} ("${word.text}") starts before the word before it.`, { index: i });
      }
      if (word.start > limit) {
        throw ApiError.withCode(422, 'INVALID_WORD_TIMING', `Word ${i + 1} ("${word.text}") starts after the end of the media.`, { index: i });
      }
    }

    const normalized: ITranscriptionWord[] = words.map((w, i) => {
      const next = words[i + 1];
      // Small overlaps (from edits) are trimmed so the next word starts cleanly.
      const end = Math.min(Math.max(w.end, w.start), limit, next ? Math.max(next.start, w.start) : Infinity);
      return {
        text: w.text,
        start: w.start,
        end,
        type: w.type || 'word',
        ...(w.speaker_id ? { speaker_id: w.speaker_id } : {}),
      };
    });
    const wasTranscribing = transcription.status === 'pending' || transcription.status === 'processing';

    transcription.words = normalized;
    transcription.text = normalized
      .filter((w) => w.type === 'word')
      .map((w) => w.text)
      .join(' ');
    // The corrected list is authoritative even if the original run failed,
    // and a run still in progress won't replace it (isEdited).
    transcription.status = 'completed';
    transcription.isEdited = true;
    transcription.editedAt = new Date();
    transcription.error = undefined;

    await transcription.save();

    res.json({
      ...transcription.toObject(),
      // The editor tells the user their edit was kept over the running transcription.
      ...(wasTranscribing ? { keptOverRunningTranscription: true } : {}),
    });
  } catch (error) {
    next(error);
  }
};

export const deleteTranscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    await Transcription.deleteOne({ _id: id, userId: user._id });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
