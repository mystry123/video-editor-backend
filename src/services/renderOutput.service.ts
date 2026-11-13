// services/renderOutput.service.ts
//
// Render outputs are private objects in the renders bucket (GCS_RENDERS_BUCKET).
// Users never see the bucket: every API response carries a stable Shotline link,
//   <PUBLIC_API_URL>/r/<jobId>?t=<shareToken>
// which redirects to a short-lived signed URL. Anyone with the link can
// open it (so links in emails, Zapier and webhooks work); deleting the render
// deletes the file and the link stops working.
//
// Renders from before the move to GCP (Nov 2026) point at S3 in an AWS account
// that no longer exists; they have no stored output here and get no link.

import crypto from 'crypto';
import { RenderJob } from '../models/RenderJob';
import { env } from '../config/env';
import { gcs, parseGcsUrl } from '../config/gcs';
import { logger } from '../utils/logger';

const PRESIGN_TTL_SECONDS = 60 * 60;
/** Cached presigned URLs are reused until this long before they expire. */
const PRESIGN_REUSE_MARGIN_MS = 10 * 60_000;

export function newShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export type StorageLocation = { bucket: string; key: string };

/** Where a stored render lives (a GCS URL or gs://), or null. */
export function parseStorageUrl(url: string | undefined): StorageLocation | null {
  return parseGcsUrl(url);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

interface LinkableJob {
  _id: any;
  status?: string;
  outputUrl?: string;
  shareToken?: string;
}

/** The Shotline link for a completed render (needs its shareToken loaded). */
export function renderLink(job: LinkableJob, { download = false } = {}): string | undefined {
  if (job.status !== 'completed' || !job.outputUrl || !job.shareToken) return undefined;
  const base = env.publicApiUrl.replace(/\/$/, '');
  return `${base}/r/${job._id}?t=${encodeURIComponent(job.shareToken)}${download ? '&download=1' : ''}`;
}

/**
 * Loads (and, for renders made before links existed, creates) share tokens
 * for completed renders, setting `shareToken` on each given job object.
 */
export async function ensureShareTokens<T extends LinkableJob>(jobs: T[]): Promise<T[]> {
  const completed = jobs.filter((j) => j.status === 'completed' && j.outputUrl);
  if (completed.length === 0) return jobs;
  const ids = completed.map((j) => j._id);
  const stored = await RenderJob.find({ _id: { $in: ids } }).select('+shareToken').lean();
  const byId = new Map(stored.map((s: any) => [String(s._id), s.shareToken as string | undefined]));
  for (const job of completed) {
    let token = byId.get(String(job._id));
    if (!token) {
      // Only set it if still missing, so parallel requests agree on one token.
      await RenderJob.updateOne({ _id: job._id, shareToken: { $exists: false } }, { $set: { shareToken: newShareToken() } });
      token = ((await RenderJob.findById(job._id).select('+shareToken').lean()) as any)?.shareToken;
    }
    job.shareToken = token;
  }
  return jobs;
}

/** The fields every API response uses for a render's output. */
export function outputFields(job: LinkableJob): { outputUrl?: string; downloadUrl?: string } {
  const outputUrl = renderLink(job);
  return outputUrl ? { outputUrl, downloadUrl: renderLink(job, { download: true }) } : {};
}

// ---------------------------------------------------------------------------
// Signed access
// ---------------------------------------------------------------------------

const presignCache = new Map<string, { url: string; expiresAt: number }>();

type StoredOutput = { outputUrl?: string; outputBucket?: string; outputKey?: string };

function outputLocation(job: StoredOutput): StorageLocation | null {
  // Only GCS outputs are ours; old S3 (Lambda) outputs are gone with that account.
  const fromUrl = parseStorageUrl(job.outputUrl);
  if (!fromUrl) return null;
  return job.outputBucket && job.outputKey ? { bucket: job.outputBucket, key: job.outputKey } : fromUrl;
}

/** A short-lived URL for the render's file, or null if it has no stored output. */
export async function presignOutput(
  job: { _id: any; outputFormat?: string } & StoredOutput,
  { download = false } = {}
): Promise<string | null> {
  const location = outputLocation(job);
  if (!location) return null;
  const cacheKey = `${job._id}:${download ? 'd' : 'v'}`;
  const cached = presignCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > PRESIGN_REUSE_MARGIN_MS) return cached.url;

  const extension = job.outputFormat || location.key.split('.').pop() || 'mp4';
  const disposition = `attachment; filename="shotline-${job._id}.${extension}"`;
  const [url] = await gcs()
    .bucket(location.bucket)
    .file(location.key)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + PRESIGN_TTL_SECONDS * 1000,
      ...(download ? { responseDisposition: disposition } : {}),
    });
  if (presignCache.size > 10_000) presignCache.clear();
  presignCache.set(cacheKey, { url, expiresAt: Date.now() + PRESIGN_TTL_SECONDS * 1000 });
  return url;
}

/** Deletes a render's file (cancelled or deleted renders). Never throws. */
export async function deleteOutput(job: { _id: any } & StoredOutput): Promise<void> {
  const location = outputLocation(job);
  presignCache.delete(`${job._id}:d`);
  presignCache.delete(`${job._id}:v`);
  if (!location) return;
  try {
    await gcs().bucket(location.bucket).file(location.key).delete({ ignoreNotFound: true });
  } catch (error: any) {
    logger.warn('Failed to delete render output', { jobId: String(job._id), error: error?.message });
  }
}

/**
 * A render as API clients see it: the Shotline link instead of the storage
 * URL, and none of the internal output fields. Call ensureShareTokens first.
 */
export function publicRender<T extends LinkableJob & Record<string, any>>(job: T): Omit<T, 'shareToken' | 'outputBucket' | 'outputKey'> & { outputUrl?: string; downloadUrl?: string } {
  const { shareToken: _token, outputBucket: _bucket, outputKey: _key, outputUrl: _raw, ...rest } = job;
  return { ...rest, ...outputFields(job) } as any;
}
