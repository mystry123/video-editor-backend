// controllers/aiImage.controller.ts
//
//   POST /ai/image { prompt, aspect? }   make an image and save it to the user's media
//
// One generated image per request, metered as aiImages (reserved first,
// refunded if nothing was made). The image is stored like an upload.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { uploadBufferToS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { releaseUsage, reserveUsage, settleUsage } from '../services/usage.service';
import { getImageGenerator, type ImageAspect } from '../services/ai/imageGen';
import { assertCanStore } from './file.controller';
import { sniffMedia } from './stock.controller';

/** "A neon city at night, rain" → "A neon city at night rain" (a file name) */
const nameFrom = (prompt: string) =>
  prompt.replace(/[\\/:*?"<>|,.;]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ').slice(0, 60) || 'Generated image';

export const generateImage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { prompt, aspect = '16:9' } = req.body as { prompt: string; aspect?: ImageAspect };
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');
    // Room for a typical image before spending anything
    assertCanStore(user, 2 * 1024 * 1024, 'image/png');

    const jobId = uuidv4();
    await reserveUsage(user._id, 'aiImages', jobId, 1, getEffectiveQuota(user).maxAiImages);
    try {
      const image = await getImageGenerator()(prompt, aspect);
      const sniffed = sniffMedia(image.bytes);
      if (!sniffed?.type.startsWith('image/')) throw ApiError.withCode(502, 'IMAGE_NOT_MADE', "That image couldn't be made. Try again.");
      assertCanStore(user, image.bytes.length, sniffed.type);
      const key = `users/${user._id}/uploads/${uuidv4()}.${sniffed.ext}`;
      const cdnUrl = await uploadBufferToS3(image.bytes, key, sniffed.type);
      const size = imageSize(image.bytes, sniffed.type);
      const name = `${nameFrom(prompt)}.${sniffed.ext}`;
      const file = await File.create({
        userId: user._id,
        name,
        originalName: name,
        mimeType: sniffed.type,
        size: image.bytes.length,
        storageKey: key,
        cdnUrl,
        status: 'ready',
        source: 'ai_image',
        metadata: size,
      });
      await quotaService.addStorageUsage(String(user._id), image.bytes.length, String(file._id));
      await settleUsage(user._id, 'aiImages', jobId, 1);
      logger.info('Image generated', { userId: String(user._id), fileId: String(file._id), aspect, bytes: image.bytes.length });
      res.status(201).json({
        file: { fileId: String(file._id), name, url: cdnUrl, mimeType: sniffed.type, size: image.bytes.length, width: size.width, height: size.height },
      });
    } catch (error) {
      await releaseUsage('aiImages', jobId, 'image_failed').catch(() => undefined);
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/** Pixel size from a PNG or JPEG header (0×0 if unknown) */
export function imageSize(bytes: Buffer, type: string): { width: number; height: number } {
  try {
    if (type === 'image/png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (type === 'image/jpeg') {
      let i = 2;
      while (i < bytes.length) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1];
        const len = bytes.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    // fall through
  }
  return { width: 0, height: 0 };
}
