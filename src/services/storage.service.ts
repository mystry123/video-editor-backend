import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
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

export async function createPresignedUpload({
  key,
  contentType,
  maxSize,
}: PresignedUploadParams) {
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: env.s3Bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 0, maxSize],
      ['starts-with', '$Content-Type', contentType.split('/')[0]],
    ],
    Fields: {
      'Content-Type': contentType,
    },
    Expires: 3600, // 1 hour
  });

  return { url, fields };
}

export async function deleteFromS3(key: string) {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
    })
  );
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