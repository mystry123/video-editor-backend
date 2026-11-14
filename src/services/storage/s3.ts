// services/storage/s3.ts
//
// Storage on Amazon S3 (STORAGE_PROVIDER=s3): media in S3_BUCKET (public-read,
// or behind CDN_URL), render outputs made on the worker in S3_RENDERS_BUCKET
// (private). Restored from the pre-GCP code (before commit b1a9bde).

import { createReadStream } from 'fs';
import type { Readable } from 'stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Upload } from '@aws-sdk/lib-storage';
import { env } from '../../config/env';
import { s3, s3MediaBucket, s3ObjectUrl, s3Presigner, s3RendersBucket } from '../../config/aws';
import {
  assertSafePrefix,
  contentDispositionFor,
  type BucketKind,
  type PresignedUploadParams,
  type StorageBackend,
  type UploadedPart,
} from './types';

function statusOf(error: any): number | undefined {
  return error?.$metadata?.httpStatusCode;
}

const isNoSuchUpload = (error: any) => error?.name === 'NoSuchUpload' || statusOf(error) === 404;

function publicUrl(key: string): string {
  return `${env.cdnUrl}/${key}`;
}

async function createPresignedUpload({ key, contentType, maxSize }: PresignedUploadParams) {
  // Every field is signed into the policy as an exact match, so the browser
  // can't change the type or drop the Content-Disposition.
  const disposition = contentDispositionFor(contentType);
  const { url, fields } = await createPresignedPost(s3(), {
    Bucket: s3MediaBucket(),
    Key: key,
    Conditions: [
      ['content-length-range', 0, maxSize],
      ['starts-with', '$Content-Type', contentType.split('/')[0]],
    ],
    Fields: {
      'Content-Type': contentType,
      ...(disposition ? { 'Content-Disposition': disposition } : {}),
    },
    Expires: 3600, // 1 hour
  });
  return { url, fields };
}

async function startMultipartUpload(key: string, contentType: string): Promise<string> {
  const disposition = contentDispositionFor(contentType);
  const out = await s3().send(
    new CreateMultipartUploadCommand({
      Bucket: s3MediaBucket(),
      Key: key,
      ContentType: contentType,
      ...(disposition ? { ContentDisposition: disposition } : {}),
    })
  );
  if (!out.UploadId) throw new Error('S3 did not return an upload id');
  return out.UploadId;
}

/** Presigned PUT URLs for these parts (valid for an hour) */
async function presignUploadParts(key: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>> {
  const bucket = s3MediaBucket();
  const urls: Record<number, string> = {};
  await Promise.all(
    partNumbers.map(async (partNumber) => {
      urls[partNumber] = await getSignedUrl(
        s3Presigner(),
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 3600 }
      );
    })
  );
  return urls;
}

async function listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[] | null> {
  const parts: UploadedPart[] = [];
  let marker: string | undefined;
  try {
    do {
      const out = await s3().send(
        new ListPartsCommand({ Bucket: s3MediaBucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker })
      );
      for (const p of out.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
      }
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
  } catch (error: any) {
    if (isNoSuchUpload(error)) return null;
    throw error;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

async function completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: s3MediaBucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    })
  );
}

async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await s3().send(new AbortMultipartUploadCommand({ Bucket: s3MediaBucket(), Key: key, UploadId: uploadId }));
  } catch (error: any) {
    if (isNoSuchUpload(error)) return;
    throw error;
  }
}

async function readObjectStart(key: string, bytes: number): Promise<Buffer | null> {
  try {
    const result = await s3().send(
      new GetObjectCommand({ Bucket: s3MediaBucket(), Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` })
    );
    if (!result.Body) return Buffer.alloc(0);
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error: any) {
    const status = statusOf(error);
    if (status === 404 || error?.name === 'NoSuchKey') return null;
    // An empty object can't satisfy any range.
    if (status === 416 || error?.name === 'InvalidRange') return Buffer.alloc(0);
    throw error;
  }
}

async function getObjectSize(key: string): Promise<number | null> {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: s3MediaBucket(), Key: key }));
    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch (error: any) {
    if (statusOf(error) === 404 || error?.name === 'NotFound') return null;
    throw error;
  }
}

async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: s3MediaBucket(), Key: key }));
}

async function deletePrefix(prefix: string, kind: BucketKind): Promise<number> {
  assertSafePrefix(prefix);
  const bucket = kind === 'renders' ? s3RendersBucket() : s3MediaBucket();
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    const objects = (page.Contents || []).filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
    if (objects.length > 0) {
      const result = await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      if (result.Errors?.length) {
        throw new Error(`Failed to delete ${result.Errors.length} objects under ${prefix}: ${result.Errors[0].Message}`);
      }
      deleted += objects.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

async function uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
  await s3().send(
    new PutObjectCommand({
      Bucket: s3MediaBucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: contentDispositionFor(contentType),
      CacheControl: 'public, max-age=31536000',
    })
  );
  return publicUrl(key);
}

async function uploadStream(stream: Readable, key: string, contentType: string, onProgress?: (loaded: number) => void): Promise<string> {
  const upload = new Upload({
    client: s3(),
    params: {
      Bucket: s3MediaBucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentDisposition: contentDispositionFor(contentType),
    },
  });
  if (onProgress) {
    upload.on('httpUploadProgress', (progress) => {
      if (progress.loaded) onProgress(progress.loaded);
    });
  }
  await upload.done();
  return publicUrl(key);
}

async function uploadRenderFile(localPath: string, key: string, contentType: string): Promise<string> {
  const bucket = s3RendersBucket();
  // Multipart for big files; private (the bucket has no public access).
  await new Upload({
    client: s3(),
    params: { Bucket: bucket, Key: key, Body: createReadStream(localPath), ContentType: contentType },
  }).done();
  return s3ObjectUrl(bucket, key);
}

export const s3Storage: StorageBackend = {
  createPresignedUpload,
  startMultipartUpload,
  presignUploadParts,
  listUploadedParts,
  completeMultipartUpload,
  abortMultipartUpload,
  readObjectStart,
  getObjectSize,
  deleteObject,
  deletePrefix,
  hasBucket: (kind) => Boolean(kind === 'renders' ? env.s3RendersBucket : env.s3Bucket),
  publicUrl,
  uploadBuffer,
  uploadStream,
  uploadRenderFile,
};
