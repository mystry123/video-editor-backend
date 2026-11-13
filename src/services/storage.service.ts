// services/storage.service.ts
//
// Media storage on Google Cloud Storage (the media bucket, GCS_MEDIA_BUCKET).
// The function names still say S3 so callers didn't have to change; they all
// work on GCS. Credentials: Application Default Credentials (config/gcs.ts).

import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { gcs, mediaBucket, publicMediaUrl } from '../config/gcs';
import { env } from '../config/env';

interface PresignedUploadParams {
  key: string;
  contentType: string;
  maxSize: number;
}

/**
 * Content-Disposition to store with an object. SVGs are images that can carry
 * scripts: opened directly (a link to the CDN URL) they'd run as a page on the
 * media origin. "attachment" makes a direct visit download the file instead;
 * <img>, CSS and canvas ignore the header, so the editor still shows them.
 */
export function contentDispositionFor(contentType: string | undefined): string | undefined {
  return (contentType || '').toLowerCase().split(';')[0].trim() === 'image/svg+xml' ? 'attachment' : undefined;
}

export async function createPresignedUpload({
  key,
  contentType,
  maxSize,
}: PresignedUploadParams) {
  // A V4 POST policy: the browser posts a form with these fields plus "file"
  // to `url`. Every field is signed into the policy as an exact match, so the
  // browser can't change the type or drop the Content-Disposition.
  const disposition = contentDispositionFor(contentType);
  const [policy] = await mediaBucket()
    .file(key)
    .generateSignedPostPolicyV4({
      expires: Date.now() + 3600 * 1000, // 1 hour
      conditions: [
        ['content-length-range', 0, maxSize],
        ['starts-with', '$Content-Type', contentType.split('/')[0]],
      ],
      fields: {
        'Content-Type': contentType,
        ...(disposition ? { 'Content-Disposition': disposition } : {}),
      },
    });

  return { url: policy.url, fields: policy.fields as Record<string, string> };
}

// ---------------------------------------------------------------------------
// Multipart uploads: the browser sends a big file in parts, each to its own
// signed URL, so a dropped connection costs one part, not the whole file,
// and an upload can resume after a reload. The server asks storage which
// parts arrived (ListParts) instead of trusting the browser's list.
//
// This is GCS's XML API multipart upload, which speaks the S3 protocol:
// POST ?uploads starts one, PUT ?partNumber&uploadId sends a part (the
// browser does this with a V4 signed URL), GET ?uploadId lists parts,
// POST ?uploadId completes and DELETE ?uploadId aborts.
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;
/** At most 10,000 parts, each at least 5 MiB except the last */
const MAX_PARTS = 10_000;
const MIN_PART_SIZE = 8 * MiB;

/** The part size for a file: 8 MiB, larger for files over ~78 GiB */
export function multipartPartSize(size: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

function objectXmlUrl(key: string, query: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://storage.googleapis.com/${encodeURIComponent(env.gcsMediaBucket)}/${path}?${query}`;
}

function statusOf(error: any): number | undefined {
  return error?.response?.status ?? (typeof error?.code === 'number' ? error.code : undefined);
}

async function xmlRequest(
  method: 'GET' | 'POST' | 'DELETE',
  key: string,
  query: string,
  { headers, body }: { headers?: Record<string, string>; body?: string } = {}
): Promise<string> {
  if (!env.gcsMediaBucket) throw new Error('GCS_MEDIA_BUCKET is not set');
  const res = await gcs().authClient.request<string>({
    url: objectXmlUrl(key, query),
    method,
    headers: { ...(body === undefined ? { 'Content-Length': '0' } : {}), ...headers },
    data: body,
    responseType: 'text',
  });
  const text = typeof res.data === 'string' ? res.data : '';
  // Like S3, an error can come back inside a 200 reply.
  const error = text.match(/<Error>[\s\S]*?<Code>([^<]*)<\/Code>/);
  if (error) throw Object.assign(new Error(`GCS ${method} failed: ${error[1]}`), { code: error[1] });
  return text;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : undefined;
}

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const isNoSuchUpload = (error: any) => statusOf(error) === 404 || error?.code === 'NoSuchUpload';

export async function startMultipartUpload(key: string, contentType: string): Promise<string> {
  const disposition = contentDispositionFor(contentType);
  const xml = await xmlRequest('POST', key, 'uploads', {
    headers: { 'Content-Type': contentType, ...(disposition ? { 'Content-Disposition': disposition } : {}) },
  });
  const uploadId = xmlValue(xml, 'UploadId');
  if (!uploadId) throw new Error('GCS did not return an upload id');
  return uploadId;
}

/** Signed PUT URLs for these parts (valid for an hour) */
export async function presignUploadParts(key: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>> {
  const file = mediaBucket().file(key);
  const urls: Record<number, string> = {};
  await Promise.all(
    partNumbers.map(async (partNumber) => {
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + 3600 * 1000,
        queryParams: { partNumber: String(partNumber), uploadId },
      });
      urls[partNumber] = url;
    })
  );
  return urls;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** The parts storage has for an upload, in order. Null if the upload doesn't exist (finished or aborted). */
export async function listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[] | null> {
  const parts: UploadedPart[] = [];
  let marker: string | undefined;
  try {
    do {
      const query = `uploadId=${encodeURIComponent(uploadId)}${marker ? `&part-number-marker=${encodeURIComponent(marker)}` : ''}`;
      const xml = await xmlRequest('GET', key, query);
      for (const [, part] of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
        const partNumber = Number(xmlValue(part, 'PartNumber'));
        const etag = xmlValue(part, 'ETag');
        if (partNumber && etag) parts.push({ partNumber, etag, size: Number(xmlValue(part, 'Size')) || 0 });
      }
      marker = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextPartNumberMarker') : undefined;
    } while (marker);
  } catch (error: any) {
    if (isNoSuchUpload(error)) return null;
    throw error;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
  const body =
    '<CompleteMultipartUpload>' +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  await xmlRequest('POST', key, `uploadId=${encodeURIComponent(uploadId)}`, {
    headers: { 'Content-Type': 'application/xml' },
    body,
  });
}

/** Drops an unfinished upload and the parts storage kept for it. Fine if it's already gone. */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await xmlRequest('DELETE', key, `uploadId=${encodeURIComponent(uploadId)}`);
  } catch (error: any) {
    if (isNoSuchUpload(error)) return;
    throw error;
  }
}

/**
 * The first `bytes` bytes of an object in the media bucket (fewer if it's
 * smaller), via a ranged read. Null if the object doesn't exist.
 */
export async function readObjectStart(key: string, bytes: number): Promise<Buffer | null> {
  try {
    const [data] = await mediaBucket().file(key).download({ start: 0, end: Math.max(0, bytes - 1), validation: false });
    return data;
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) return null;
    // An empty object can't satisfy any range.
    if (status === 416) return Buffer.alloc(0);
    throw error;
  }
}

/** Size in bytes of an object in the media bucket, or null if it doesn't exist. */
export async function getObjectSize(key: string): Promise<number | null> {
  try {
    const [metadata] = await mediaBucket().file(key).getMetadata();
    const size = Number(metadata.size);
    return Number.isFinite(size) ? size : null;
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

export async function deleteFromS3(key: string) {
  await mediaBucket().file(key).delete({ ignoreNotFound: true });
}

/**
 * Deletes every object under `prefix` in the media bucket. Safe to call again
 * after a partial failure. Returns the number of objects deleted.
 */
export async function deleteS3Prefix(prefix: string): Promise<number> {
  if (!prefix || prefix === '/' || !prefix.endsWith('/')) {
    throw new Error(`Refusing to delete unsafe prefix "${prefix}"`);
  }

  const bucket = mediaBucket();
  let deleted = 0;
  let pageToken: string | undefined;
  do {
    const [files, next] = await bucket.getFiles({ prefix, maxResults: 1000, autoPaginate: false, pageToken });
    // A few at a time: GCS has no batch delete in this client.
    for (let i = 0; i < files.length; i += 25) {
      await Promise.all(files.slice(i, i + 25).map((f) => f.delete({ ignoreNotFound: true })));
    }
    deleted += files.length;
    pageToken = (next as { pageToken?: string } | null)?.pageToken;
  } while (pageToken);

  return deleted;
}

export async function copyToCDN(_sourceKey: string, destinationKey: string): Promise<string> {
  return publicMediaUrl(destinationKey);
}

export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  await mediaBucket()
    .file(key)
    .save(buffer, {
      resumable: false,
      contentType,
      metadata: {
        contentType,
        cacheControl: 'public, max-age=31536000',
        ...(contentDispositionFor(contentType) ? { contentDisposition: contentDispositionFor(contentType) } : {}),
      },
    });

  return publicMediaUrl(key);
}

/**
 * Upload a stream to the media bucket (a resumable upload) with progress tracking
 */
export async function uploadStreamToS3(
  stream: Readable,
  key: string,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<string> {
  let loaded = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      loaded += chunk.length;
      onProgress?.(loaded);
      callback(null, chunk);
    },
  });
  const disposition = contentDispositionFor(contentType);
  await pipeline(
    stream,
    counter,
    mediaBucket()
      .file(key)
      .createWriteStream({
        resumable: true,
        contentType,
        metadata: { contentType, ...(disposition ? { contentDisposition: disposition } : {}) },
      })
  );

  return publicMediaUrl(key);
}

/**
 * Upload thumbnail specifically
 */
export async function uploadThumbnail(
  buffer: Buffer,
  renderId: string
): Promise<string> {
  const key = `thumbnails/${renderId}.jpg`;
  return uploadBufferToS3(buffer, key, 'image/jpeg');
}
