// services/stock.service.ts
//
// Free stock photos and videos from Pixabay (Pixabay Content License: free to
// use in videos, commercial included). Searches are cached for 24 hours, as
// Pixabay asks. Importing looks the item up again by id and copies the file
// into the user's media (Pixabay asks for no permanent hotlinking), so only
// Pixabay's own file links are ever fetched, never a URL from the client.

import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

export type StockKind = 'photo' | 'video';

export interface StockItem {
  /** Pixabay id */
  id: string;
  kind: StockKind;
  title: string;
  /** Small picture for the grid */
  preview: string;
  width: number;
  height: number;
  /** Videos: seconds */
  duration?: number;
  user: string;
  pageUrl: string;
}

/** What gets copied for an item */
export interface StockSource {
  item: StockItem;
  /** Where to copy it from, best first (another is tried if one fails) */
  urls: string[];
  thumbnail?: string;
}

/**
 * The same photo at another width on Pixabay's CDN (…_150.jpg → …_1280.jpg).
 * The CDN serves 640 and 1280 reliably; pixabay.com/get links are rate limited.
 */
export function cdnSized(previewUrl: string | undefined, width: 640 | 1280): string | null {
  if (!previewUrl || !/^https:\/\/cdn\.pixabay\.com\/.+_150\.(jpe?g|png)$/i.test(previewUrl)) return null;
  return previewUrl.replace(/_150\.(jpe?g|png)$/i, `_${width}.$1`);
}

export const STOCK_PAGE_SIZE = 24;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
/** The largest video copied: 1080p when it isn't huge, else the 720p copy */
export const STOCK_VIDEO_MAX_BYTES = 80 * 1024 * 1024;

const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function remember(key: string, value: unknown) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
}

/** Tests: start with an empty cache */
export function clearStockCache() {
  cache.clear();
}

export function stockEnabled(): boolean {
  return !!env.pixabayApiKey;
}

/** Pixabay hosts its files on pixabay.com and cdn.pixabay.com, over https */
export function isPixabayFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && /^(cdn\.)?pixabay\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

async function pixabay(kind: StockKind, params: Record<string, string>): Promise<any> {
  if (!stockEnabled()) throw ApiError.withCode(503, 'STOCK_UNAVAILABLE', "Stock photos and videos aren't set up yet.");
  const query = new URLSearchParams({ key: env.pixabayApiKey, safesearch: 'true', ...params });
  const url = `https://pixabay.com/api/${kind === 'video' ? 'videos/' : ''}?${query}`;
  const key = `${kind}:${new URLSearchParams(params)}`;
  const hit = cached<any>(key);
  if (hit) return hit;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    logger.warn('Pixabay unreachable', { error: (error as Error).message });
    throw ApiError.withCode(503, 'STOCK_UNAVAILABLE', "Stock search isn't available right now. Try again in a minute.");
  }
  if (response.status === 429) throw ApiError.withCode(429, 'STOCK_BUSY', 'Too many stock searches right now. Try again in a minute.');
  if (!response.ok) {
    logger.warn('Pixabay request failed', { status: response.status, body: (await response.text()).slice(0, 200) });
    throw ApiError.withCode(503, 'STOCK_UNAVAILABLE', "Stock search isn't available right now. Try again in a minute.");
  }
  const body = await response.json();
  remember(key, body);
  return body;
}

const titleOf = (hit: any) =>
  String(hit.tags || '')
    .split(',')
    .map((t: string) => t.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(', ') || 'Stock';

/** The file a video is copied from: 1080p-ish when it isn't huge, else smaller */
function videoFile(hit: any): { url: string; width: number; height: number; thumbnail?: string } | null {
  for (const size of ['medium', 'small', 'large', 'tiny']) {
    const v = hit.videos?.[size];
    if (v?.url && (!v.size || v.size <= STOCK_VIDEO_MAX_BYTES)) return { url: v.url, width: v.width, height: v.height, thumbnail: v.thumbnail };
  }
  return null;
}

function toSource(kind: StockKind, hit: any): StockSource | null {
  if (kind === 'photo') {
    const urls = [cdnSized(hit.previewURL, 1280), hit.largeImageURL, cdnSized(hit.previewURL, 640), hit.webformatURL].filter(
      (u): u is string => !!u && isPixabayFileUrl(u)
    );
    if (!urls.length || !hit.previewURL) return null;
    // largeImageURL is at most 1280 px on its longest side
    const scale = Math.min(1, 1280 / Math.max(hit.imageWidth || 1, hit.imageHeight || 1));
    return {
      urls: [...new Set(urls)],
      item: {
        id: String(hit.id),
        kind,
        title: titleOf(hit),
        preview: cdnSized(hit.previewURL, 640) || hit.previewURL,
        width: Math.round((hit.imageWidth || 0) * scale),
        height: Math.round((hit.imageHeight || 0) * scale),
        user: String(hit.user || ''),
        pageUrl: String(hit.pageURL || ''),
      },
    };
  }
  const file = videoFile(hit);
  if (!file) return null;
  return {
    urls: [file.url],
    thumbnail: file.thumbnail,
    item: {
      id: String(hit.id),
      kind,
      title: titleOf(hit),
      preview: file.thumbnail || hit.videos?.tiny?.thumbnail || '',
      width: file.width,
      height: file.height,
      duration: Number(hit.duration) || undefined,
      user: String(hit.user || ''),
      pageUrl: String(hit.pageURL || ''),
    },
  };
}

/** Searches photos or videos. `orientation` narrows to wide or tall results. */
export async function searchStock(
  kind: StockKind,
  q: string,
  page = 1,
  orientation?: 'horizontal' | 'vertical'
): Promise<{ items: StockItem[]; next: number | null }> {
  const params: Record<string, string> = { q: q.trim().slice(0, 100), page: String(page), per_page: String(STOCK_PAGE_SIZE) };
  if (orientation && kind === 'photo') params.orientation = orientation;
  const body = await pixabay(kind, params);
  const items = (body.hits ?? []).map((h: any) => toSource(kind, h)).filter(Boolean).map((s: StockSource) => s.item);
  const total = Number(body.totalHits) || 0;
  return { items, next: page * STOCK_PAGE_SIZE < total && page < 20 ? page + 1 : null };
}

/** The item with this id, and the file to copy */
export async function stockSource(kind: StockKind, id: string): Promise<StockSource> {
  if (!/^\d{1,12}$/.test(id)) throw ApiError.withCode(400, 'STOCK_NOT_FOUND', "That stock item wasn't found.");
  const body = await pixabay(kind, { id });
  const source = body.hits?.[0] ? toSource(kind, body.hits[0]) : null;
  if (source) source.urls = source.urls.filter(isPixabayFileUrl);
  if (!source || !source.urls.length) throw ApiError.withCode(404, 'STOCK_NOT_FOUND', "That stock item wasn't found.");
  return source;
}
