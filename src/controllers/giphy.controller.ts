// controllers/giphy.controller.ts
//
//   POST /files/import/giphy { url, title?, width?, height? }
//
// Copies a GIF or sticker from GIPHY into the user's media, so projects (and
// exports) never depend on GIPHY's links. Only GIPHY's media hosts are
// fetched (no open proxy); at most 20 MB; counts toward storage like any
// upload. Synchronous: GIFs are small.

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

export const GIPHY_MAX_BYTES = 20 * 1024 * 1024;

/** https://media0-4.giphy.com/… or https://i.giphy.com/…, a .gif or .webp */
export function isGiphyMediaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    /^(media\d?\.giphy\.com|i\.giphy\.com)$/.test(url.hostname) &&
    /\.(gif|webp)$/i.test(url.pathname)
  );
}

async function download(url: string): Promise<{ bytes: Buffer; type: string }> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw ApiError.withCode(502, 'GIPHY_FETCH_FAILED', "Couldn't get that GIF from GIPHY. Try another one.");
  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared > GIPHY_MAX_BYTES) throw ApiError.withCode(400, 'GIF_TOO_LARGE', 'That GIF is too large. Pick a smaller one.');
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > GIPHY_MAX_BYTES) {
      await reader.cancel();
      throw ApiError.withCode(400, 'GIF_TOO_LARGE', 'That GIF is too large. Pick a smaller one.');
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  // Trust the bytes, not the header: GIF87a/GIF89a or RIFF…WEBP
  const head = bytes.subarray(0, 12).toString('latin1');
  const type = head.startsWith('GIF8') ? 'image/gif' : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!type) throw ApiError.withCode(422, 'NOT_A_GIF', "That file isn't a GIF.");
  return { bytes, type };
}

export const importGiphy = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { url, title, width, height } = req.body as { url: string; title?: string; width?: number; height?: number };
    if (!isGiphyMediaUrl(url)) throw ApiError.withCode(400, 'NOT_GIPHY', 'Only GIPHY GIFs and stickers can be added here.');
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');

    const { bytes, type } = await download(url);
    assertCanStore(user, bytes.length, type);
    const ext = type === 'image/gif' ? 'gif' : 'webp';
    const key = `users/${user._id}/uploads/${uuidv4()}.${ext}`;
    const cdnUrl = await uploadBufferToS3(bytes, key, type);
    const name = `${(title || 'GIPHY').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80) || 'GIPHY'}.${ext}`;
    const file = await File.create({
      userId: user._id,
      name,
      originalName: name,
      mimeType: type,
      size: bytes.length,
      storageKey: key,
      cdnUrl,
      status: 'ready',
      source: 'giphy',
      sourceUrl: url,
      metadata: { width: Number(width) || 0, height: Number(height) || 0 },
    });
    await quotaService.addStorageUsage(String(user._id), bytes.length, String(file._id));
    logger.info('GIPHY item imported', { userId: String(user._id), fileId: String(file._id), bytes: bytes.length });
    res.status(201).json({ file: { fileId: String(file._id), name, url: cdnUrl, mimeType: type, size: bytes.length, width: Number(width) || 0, height: Number(height) || 0 } });
  } catch (error) {
    next(error);
  }
};
