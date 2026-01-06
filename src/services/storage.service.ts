import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { env } from '../config/env';

const s3Client = new S3Client({
  region: env.awsRegion,
  credentials: {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
  },
});

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
  // For now, return the S3 URL directly since the file is already in S3
  // In a real implementation, you might copy to a CDN bucket
  return `https://${env.s3Bucket}.s3.${env.awsRegion}.amazonaws.com/${destinationKey}`;
}