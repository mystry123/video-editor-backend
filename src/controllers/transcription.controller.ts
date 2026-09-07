import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { Transcription, ITranscriptionWord } from '../models/Transcription';
import { File } from '../models/File';
import { User } from '../models/User';
import { transcriptionQueue } from '../queues';
import { ApiError } from '../utils/ApiError';

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
        existing.status = 'pending';
        existing.error = undefined;
        await existing.save();

        await transcriptionQueue.add('transcribe', {
          transcriptionId: existing._id.toString(),
          fileUrl: file.cdnUrl,
        });

        res.status(202).json(existing);
        return;
      }

      res.status(200).json(existing);
      return;
    }

    const transcription = await Transcription.create({
      userId: user._id,
      fileId,
      status: 'pending',
    });

    await transcriptionQueue.add('transcribe', {
      transcriptionId: transcription._id.toString(),
      fileUrl: file.cdnUrl,
    });

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

    const normalized: ITranscriptionWord[] = words.map((w) => ({
      text: w.text,
      start: w.start,
      end: Math.max(w.end, w.start),
      type: w.type || 'word',
      ...(w.speaker_id ? { speaker_id: w.speaker_id } : {}),
    }));

    transcription.words = normalized;
    transcription.text = normalized
      .filter((w) => w.type === 'word')
      .map((w) => w.text)
      .join(' ');
    // The corrected list is authoritative even if the original run failed.
    transcription.status = 'completed';

    await transcription.save();

    res.json(transcription);
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
