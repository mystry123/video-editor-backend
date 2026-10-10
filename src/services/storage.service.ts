import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import { env } from '../config/env';

const s3Client = new S3Client({
  region: env.awsRegion,
  credentials: {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
  },
});

// Export s3Client for use in workers
export { s3Client };

// For presigned part URLs. By default the SDK signs a checksum of the (empty)
// body into the URL, so the browser's real part would be rejected; only add
// checksums S3 requires.
const presignClient = new S3Client({
  region: env.awsRegion,
  credentials: {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

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
  // Every field is signed into the policy as an exact match, so the browser
  // can't change the type or drop the Content-Disposition.
  const disposition = contentDispositionFor(contentType);
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: env.s3Bucket,
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

// ---------------------------------------------------------------------------
// Multipart uploads: the browser sends a big file in parts, each to its own
// presigned URL, so a dropped connection costs one part, not the whole file,
// and an upload can resume after a reload. The server asks S3 which parts
// arrived (ListParts) instead of trusting the browser's list.
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;
/** S3: at most 10,000 parts, each at least 5 MiB except the last */
const MAX_PARTS = 10_000;
const MIN_PART_SIZE = 8 * MiB;

/** The part size for a file: 8 MiB, larger for files over ~78 GiB */
export function multipartPartSize(size: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

export async function startMultipartUpload(key: string, contentType: string): Promise<string> {
  const disposition = contentDispositionFor(contentType);
  const out = await s3Client.send(
    new CreateMultipartUploadCommand({
      Bucket: env.s3Bucket,
      Key: key,
      ContentType: contentType,
      ...(disposition ? { ContentDisposition: disposition } : {}),
    })
  );
  if (!out.UploadId) throw new Error('S3 did not return an upload id');
  return out.UploadId;
}

/** Presigned PUT URLs for these parts (valid for an hour) */
export async function presignUploadParts(key: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>> {
  const urls: Record<number, string> = {};
  await Promise.all(
    partNumbers.map(async (partNumber) => {
      urls[partNumber] = await getSignedUrl(
        presignClient,
        new UploadPartCommand({ Bucket: env.s3Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 3600 }
      );
    })
  );
  return urls;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** The parts S3 has for an upload, in order. Null if the upload doesn't exist (finished or aborted). */
export async function listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[] | null> {
  const parts: UploadedPart[] = [];
  let marker: string | undefined;
  try {
    do {
      const out = await s3Client.send(
        new ListPartsCommand({ Bucket: env.s3Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker })
      );
      for (const p of out.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
      }
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
  } catch (error: any) {
    if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
  await s3Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: env.s3Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    })
  );
}

/** Drops an unfinished upload and the parts S3 kept for it. Fine if it's already gone. */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await s3Client.send(new AbortMultipartUploadCommand({ Bucket: env.s3Bucket, Key: key, UploadId: uploadId }));
  } catch (error: any) {
    if (error?.name === 'NoSuchUpload' || error?.$metadata?.httpStatusCode === 404) return;
    throw error;
  }
}

/**
 * The first `bytes` bytes of an object in the media bucket (fewer if it's
 * smaller), via a ranged GET. Null if the object doesn't exist.
 */
export async function readObjectStart(key: string, bytes: number): Promise<Buffer | null> {
  try {
    const result = await s3Client.send(
      new GetObjectCommand({ Bucket: env.s3Bucket, Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` })
    );
    if (!result.Body) return Buffer.alloc(0);
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NoSuchKey') return null;
    // An empty object can't satisfy any range.
    if (status === 416 || err?.name === 'InvalidRange') return Buffer.alloc(0);
    throw error;
  }
}

/** Size in bytes of an object in the media bucket, or null if it doesn't exist. */
export async function getObjectSize(key: string): Promise<number | null> {
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return null;
    throw error;
  }
}

export async function deleteFromS3(key: string) {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
    })
  );
}

/**
 * Deletes every object under `prefix` in the media bucket. Safe to call again
 * after a partial failure. Returns the number of objects deleted.
 */
export async function deleteS3Prefix(prefix: string): Promise<number> {
  if (!prefix || prefix === '/' || !prefix.endsWith('/')) {
    throw new Error(`Refusing to delete unsafe prefix "${prefix}"`);
  }

  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({ Bucket: env.s3Bucket, Prefix: prefix, ContinuationToken: continuationToken })
    );
    const objects = (page.Contents || []).filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
    if (objects.length > 0) {
      const result = await s3Client.send(
        new DeleteObjectsCommand({ Bucket: env.s3Bucket, Delete: { Objects: objects, Quiet: true } })
      );
      if (result.Errors?.length) {
        throw new Error(`Failed to delete ${result.Errors.length} objects under ${prefix}: ${result.Errors[0].Message}`);
      }
      deleted += objects.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

export async function copyToCDN(sourceKey: string, destinationKey: string): Promise<string> {
  return `https://${env.s3Bucket}.s3.${env.awsRegion}.amazonaws.com/${destinationKey}`;
}

export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: contentDispositionFor(contentType),
      CacheControl: 'public, max-age=31536000',
    })
  );

  return `${env.cdnUrl}/${key}`;
}

/**
 * Upload a stream to S3 with progress tracking
 */
export async function uploadStreamToS3(
  stream: Readable,
  key: string,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<string> {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: env.s3Bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentDisposition: contentDispositionFor(contentType),
    },
  });

  if (onProgress) {
    upload.on('httpUploadProgress', (progress) => {
      if (progress.loaded) {
        onProgress(progress.loaded);
      }
    });
  }

  await upload.done();

  return `${env.cdnUrl}/${key}`;
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