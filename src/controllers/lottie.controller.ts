// controllers/lottie.controller.ts
//
//   POST /files/import/lottie { url } | { data (base64), name? }
//
// Adds a Lottie animation to the user's media: from a LottieFiles asset link
// (lottie.host…, .json or .lottie) or an uploaded .json / .lottie file. It's
// checked and made safe (services/lottie.service) and saved as JSON.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { uploadBufferToS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { assertCanStore } from './file.controller';
import { isLottieFilesUrl, LOTTIE_MAX_BYTES, meaningfulName, prepareLottie } from '../services/lottie.service';

async function download(url: string): Promise<Buffer> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw ApiError.withCode(502, 'LOTTIE_FETCH_FAILED', "Couldn't get that animation from LottieFiles. Check the link.");
  }
  if (!response.ok || !response.body) throw ApiError.withCode(502, 'LOTTIE_FETCH_FAILED', "Couldn't get that animation from LottieFiles. Check the link.");
  if ((Number(response.headers.get('content-length')) || 0) > LOTTIE_MAX_BYTES) throw ApiError.withCode(400, 'LOTTIE_TOO_LARGE', 'That animation is too large (10 MB at most).');
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LOTTIE_MAX_BYTES) {
      await reader.cancel();
      throw ApiError.withCode(400, 'LOTTIE_TOO_LARGE', 'That animation is too large (10 MB at most).');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const safeName = (name: string) => name.replace(/\.(json|lottie)$/i, '').replace(/[\\/:*?"<>|]/g, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

export const importLottie = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { url, data, name } = req.body as { url?: string; data?: string; name?: string };
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');

    let bytes: Buffer;
    if (url) {
      if (!isLottieFilesUrl(url)) {
        throw ApiError.withCode(400, 'NOT_LOTTIEFILES', 'Paste a LottieFiles asset link (it starts with https://lottie.host/ and ends in .json or .lottie).');
      }
      // The same link again: the copy already in their media
      const existing = await File.findOne({ userId: user._id, source: 'lottie', sourceUrl: url, status: 'ready' }).lean();
      if (existing) {
        const m: any = existing.metadata ?? {};
        res.status(200).json({
          file: { fileId: String(existing._id), name: existing.name, url: existing.cdnUrl, mimeType: 'application/json', size: existing.size, width: m.width || 0, height: m.height || 0, duration: m.duration || 0 },
        });
        return;
      }
      bytes = await download(url);
    } else {
      bytes = Buffer.from(String(data), 'base64');
    }
    const lottie = prepareLottie(bytes);
    assertCanStore(user, lottie.json.length, 'application/json');

    const key = `users/${user._id}/uploads/${uuidv4()}.json`;
    const cdnUrl = await uploadBufferToS3(lottie.json, key, 'application/json');
    const fromUrl = url ? meaningfulName(decodeURIComponent(new URL(url).pathname.split('/').pop() || '')) : undefined;
    const fileName = `${safeName((name && meaningfulName(name)) || lottie.name || fromUrl || '') || 'Lottie animation'}.json`;
    const file = await File.create({
      userId: user._id,
      name: fileName,
      originalName: fileName,
      mimeType: 'application/json',
      size: lottie.json.length,
      storageKey: key,
      cdnUrl,
      status: 'ready',
      source: 'lottie',
      ...(url ? { sourceUrl: url } : {}),
      metadata: { width: lottie.width, height: lottie.height, duration: lottie.duration },
    });
    await quotaService.addStorageUsage(String(user._id), lottie.json.length, String(file._id));
    logger.info('Lottie imported', { userId: String(user._id), fileId: String(file._id), from: url ? 'link' : 'upload', bytes: lottie.json.length });
    res.status(201).json({
      file: { fileId: String(file._id), name: fileName, url: cdnUrl, mimeType: 'application/json', size: lottie.json.length, width: lottie.width, height: lottie.height, duration: lottie.duration },
    });
  } catch (error) {
    next(error);
  }
};
