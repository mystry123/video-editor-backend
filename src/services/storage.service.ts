import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
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