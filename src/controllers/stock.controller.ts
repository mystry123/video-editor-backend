// controllers/stock.controller.ts
//
//   GET  /stock/search?kind=photo|video&q=&page=&orientation=   Pixabay search (signed in)
//   POST /files/import/stock { kind, id }                       copy one into the user's media
//
// The import copies the file (and a video's thumbnail) to our storage like an
// upload, so projects and exports never depend on Pixabay's links. The bytes
// are checked (JPEG/PNG/WebP or MP4/WebM), capped, and counted toward storage.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { probeMedia, summarizeProbe } from '../utils/media';
import { uploadBufferToS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { assertCanStore } from './file.controller';
import { isPixabayFileUrl, searchStock, stockSource, STOCK_VIDEO_MAX_BYTES, type StockKind } from '../services/stock.service';

const PHOTO_MAX_BYTES = 25 * 1024 * 1024;

/** The file's real type from its first bytes */
export function sniffMedia(bytes: Buffer): { type: string; ext: string } | null {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return { type: 'video/mp4', ext: 'mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: 'video/webm', ext: 'webm' };
  return null;
}

/** Downloads at most `max` bytes; redirects must stay on Pixabay */
export async function downloadCapped(url: string, max: number, tooLarge: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (response.redirected && !isPixabayFileUrl(response.url)) throw ApiError.withCode(502, 'STOCK_FETCH_FAILED', "Couldn't get that file. Try another one.");
  if (!response.ok || !response.body) throw ApiError.withCode(502, 'STOCK_FETCH_FAILED', "Couldn't get that file. Try another one.");
  if ((Number(response.headers.get('content-length')) || 0) > max) throw ApiError.withCode(400, 'STOCK_TOO_LARGE', tooLarge);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw ApiError.withCode(400, 'STOCK_TOO_LARGE', tooLarge);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

export const searchStockItems = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { kind, q, page, orientation } = req.query as { kind: StockKind; q: string; page?: string; orientation?: 'horizontal' | 'vertical' };
    res.json(await searchStock(kind, q, Math.max(1, Number(page) || 1), orientation));
  } catch (error) {
    next(error);
  }
};

export const importStock = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { kind, id } = req.body as { kind: StockKind; id: string };
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');
    res.status(201).json({ file: await copyStockToMedia(user, kind, String(id)) });
  } catch (error) {
    next(error);
  }
};

/** Copies Pixabay item `id` into the user's media (like an upload) and returns it */
export async function copyStockToMedia(user: any, kind: StockKind, id: string) {
  const source = await stockSource(kind, String(id));

  // The first copy that downloads (Pixabay rate-limits some links)
  let bytes: Buffer | null = null;
  let lastError: unknown;
  for (const url of source.urls) {
    try {
      bytes = await downloadCapped(
        url,
        kind === 'video' ? STOCK_VIDEO_MAX_BYTES : PHOTO_MAX_BYTES,
        kind === 'video' ? 'That video is too large. Pick a shorter one.' : 'That photo is too large.'
      );
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && error.code === 'STOCK_TOO_LARGE') break;
      logger.warn('Stock download failed; trying the next copy', { url, error: (error as Error).message });
    }
  }
  if (!bytes) throw lastError instanceof ApiError ? lastError : ApiError.withCode(502, 'STOCK_FETCH_FAILED', "Couldn't get that file. Try another one.");
  const sniffed = sniffMedia(bytes);
  if (!sniffed || !sniffed.type.startsWith(kind === 'video' ? 'video/' : 'image/')) {
    throw ApiError.withCode(422, 'STOCK_UNREADABLE', "That file couldn't be read. Try another one.");
  }
  assertCanStore(user, bytes.length, sniffed.type);

  const key = `users/${user._id}/uploads/${uuidv4()}.${sniffed.ext}`;
  const cdnUrl = await uploadBufferToS3(bytes, key, sniffed.type);
  let metadata: Record<string, unknown> = { width: source.item.width, height: source.item.height };
  if (kind === 'video') {
    try {
      const probed = summarizeProbe(await probeMedia(cdnUrl));
      metadata = { ...probed };
    } catch (error) {
      logger.warn('Could not probe stock video; using Pixabay sizes', { error: (error as Error).message });
      metadata = { ...metadata, duration: source.item.duration ?? 0, hasAudio: false };
    }
  }

  // A video's poster, so the media panel shows it like an upload
  let thumbnailKey: string | undefined;
  let thumbnailUrl: string | undefined;
  if (kind === 'video' && source.thumbnail) {
    try {
      const thumb = await downloadCapped(source.thumbnail, 2 * 1024 * 1024, 'thumbnail too large');
      const t = sniffMedia(thumb);
      if (t?.type.startsWith('image/')) {
        thumbnailKey = `users/${user._id}/thumbnails/${uuidv4()}.${t.ext}`;
        thumbnailUrl = await uploadBufferToS3(thumb, thumbnailKey, t.type);
      }
    } catch {
      // no poster; the editor draws a frame
    }
  }

  const name = `${safeName(source.item.title) || 'Stock'}.${sniffed.ext}`;
  const file = await File.create({
    userId: user._id,
    name,
    originalName: name,
    mimeType: sniffed.type,
    size: bytes.length,
    storageKey: key,
    cdnUrl,
    thumbnailKey,
    thumbnailUrl,
    status: 'ready',
    source: 'stock',
    sourceUrl: source.item.pageUrl,
    sourceId: `pixabay:${kind}:${source.item.id}`,
    metadata,
  });
  await quotaService.addStorageUsage(String(user._id), bytes.length, String(file._id));
  logger.info('Stock item imported', { userId: String(user._id), fileId: String(file._id), kind, pixabayId: source.item.id, bytes: bytes.length });
  return {
    fileId: String(file._id),
    name,
    url: cdnUrl,
    thumbnailUrl,
    mimeType: sniffed.type,
    size: bytes.length,
    width: Number(metadata.width) || source.item.width,
    height: Number(metadata.height) || source.item.height,
    duration: Number(metadata.duration) || undefined,
    hasAudio: metadata.hasAudio === true,
  };
}
