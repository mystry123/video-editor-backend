// services/storage.service.ts
//
// Media storage. STORAGE_PROVIDER picks the backend: Google Cloud Storage
// (`gcs`, the default; services/storage/gcs.ts) or Amazon S3 (`s3`;
// services/storage/s3.ts). The function names still say S3 for historical
// reasons; callers never need to know which backend is active.

import type { Readable } from 'stream';
import { env } from '../config/env';
import { gcsStorage } from './storage/gcs';
import { s3Storage } from './storage/s3';
import type { BucketKind, PresignedUploadParams, StorageBackend, UploadedPart } from './storage/types';

export { contentDispositionFor } from './storage/types';
export type { BucketKind, UploadedPart } from './storage/types';

/** The active backend (read per call, so tests can switch env.storageProvider) */
export function storageBackend(): StorageBackend {
  return env.storageProvider === 's3' ? s3Storage : gcsStorage;
}

export async function createPresignedUpload(params: PresignedUploadParams) {
  return storageBackend().createPresignedUpload(params);
}

// ---------------------------------------------------------------------------
// Multipart uploads: the browser sends a big file in parts, each to its own
// signed URL, so a dropped connection costs one part, not the whole file,
// and an upload can resume after a reload. The server asks storage which
// parts arrived (ListParts) instead of trusting the browser's list. S3 and
// GCS's XML API speak the same protocol, so the browser's side is identical.
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;
/** At most 10,000 parts, each at least 5 MiB except the last */
const MAX_PARTS = 10_000;
const MIN_PART_SIZE = 8 * MiB;

/** The part size for a file: 8 MiB, larger for files over ~78 GiB */
export function multipartPartSize(size: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

export async function startMultipartUpload(key: string, contentType: string): Promise<string> {
  return storageBackend().startMultipartUpload(key, contentType);
}

/** Signed PUT URLs for these parts (valid for an hour) */
export async function presignUploadParts(key: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>> {
  return storageBackend().presignUploadParts(key, uploadId, partNumbers);
}

/** The parts storage has for an upload, in order. Null if the upload doesn't exist (finished or aborted). */
export async function listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[] | null> {
  return storageBackend().listUploadedParts(key, uploadId);
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
  return storageBackend().completeMultipartUpload(key, uploadId, parts);
}

/** Drops an unfinished upload and the parts storage kept for it. Fine if it's already gone. */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  return storageBackend().abortMultipartUpload(key, uploadId);
}

/**
 * The first `bytes` bytes of an object in the media bucket (fewer if it's
 * smaller), via a ranged read. Null if the object doesn't exist.
 */
export async function readObjectStart(key: string, bytes: number): Promise<Buffer | null> {
  return storageBackend().readObjectStart(key, bytes);
}

/** Size in bytes of an object in the media bucket, or null if it doesn't exist. */
export async function getObjectSize(key: string): Promise<number | null> {
  return storageBackend().getObjectSize(key);
}

export async function deleteFromS3(key: string): Promise<void> {
  return storageBackend().deleteObject(key);
}

/**
 * Deletes every object under `prefix` in the media bucket (or the renders
 * bucket). Safe to call again after a partial failure. Returns the number of
 * objects deleted.
 */
export async function deleteS3Prefix(prefix: string, bucket: BucketKind = 'media'): Promise<number> {
  return storageBackend().deletePrefix(prefix, bucket);
}

/** Whether the active backend has that bucket configured */
export function hasStorageBucket(bucket: BucketKind): boolean {
  return storageBackend().hasBucket(bucket);
}

export async function copyToCDN(_sourceKey: string, destinationKey: string): Promise<string> {
  return storageBackend().publicUrl(destinationKey);
}

export async function uploadBufferToS3(buffer: Buffer, key: string, contentType: string): Promise<string> {
  return storageBackend().uploadBuffer(buffer, key, contentType);
}

/**
 * Upload a stream to the media bucket with progress tracking
 */
export async function uploadStreamToS3(
  stream: Readable,
  key: string,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<string> {
  return storageBackend().uploadStream(stream, key, contentType, onProgress);
}

/**
 * Uploads a finished render (a local file) to the private renders bucket and
 * returns its storage URL; users only ever get /r/<id> links to it.
 */
export async function uploadRenderFile(localPath: string, key: string, contentType: string): Promise<string> {
  return storageBackend().uploadRenderFile(localPath, key, contentType);
}

/**
 * Upload thumbnail specifically
 */
export async function uploadThumbnail(buffer: Buffer, renderId: string): Promise<string> {
  const key = `thumbnails/${renderId}.jpg`;
  return uploadBufferToS3(buffer, key, 'image/jpeg');
}
