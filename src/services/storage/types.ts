// services/storage/types.ts
//
// What a storage backend (GCS or S3) does. services/storage.service.ts picks
// one per call from STORAGE_PROVIDER and keeps the exports callers use.

import type { Readable } from 'stream';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface PresignedUploadParams {
  key: string;
  contentType: string;
  maxSize: number;
}

/** Which bucket: media (public uploads) or renders (private outputs) */
export type BucketKind = 'media' | 'renders';

export interface StorageBackend {
  /** A browser form POST upload: post `fields` plus "file" (last) to `url` */
  createPresignedUpload(params: PresignedUploadParams): Promise<{ url: string; fields: Record<string, string> }>;
  startMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadParts(key: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>>;
  listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  readObjectStart(key: string, bytes: number): Promise<Buffer | null>;
  getObjectSize(key: string): Promise<number | null>;
  deleteObject(key: string): Promise<void>;
  /** Number of objects deleted */
  deletePrefix(prefix: string, bucket: BucketKind): Promise<number>;
  /** Whether this backend has a bucket of that kind configured */
  hasBucket(bucket: BucketKind): boolean;
  publicUrl(key: string): string;
  uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string>;
  uploadStream(stream: Readable, key: string, contentType: string, onProgress?: (loaded: number) => void): Promise<string>;
  /** Uploads a finished render file to the private renders bucket; returns its storage URL */
  uploadRenderFile(localPath: string, key: string, contentType: string): Promise<string>;
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

export function assertSafePrefix(prefix: string): void {
  if (!prefix || prefix === '/' || !prefix.endsWith('/')) {
    throw new Error(`Refusing to delete unsafe prefix "${prefix}"`);
  }
}
