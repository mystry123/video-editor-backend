// config/aws.ts
//
// S3 clients for STORAGE_PROVIDER=s3 and for Remotion Lambda's render outputs
// (RENDER_PROVIDER=lambda). Clients are created on first use, so a GCP-only
// deploy never builds one. With AWS_ACCESS_KEY_ID/SECRET unset the SDK's
// default credential chain is used (an instance role, AWS_PROFILE, ...).

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { env } from './env';

type Credentials = { accessKeyId: string; secretAccessKey: string };

function appCredentials(): Credentials | undefined {
  return env.awsAccessKeyId && env.awsSecretAccessKey
    ? { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey }
    : undefined;
}

/** Remotion's own keys when set (its bucket may live in another account), else the app's. */
function remotionCredentials(): Credentials | undefined {
  return env.remotionAwsAccessKeyID && env.remotionAwsSecretAccessKey
    ? { accessKeyId: env.remotionAwsAccessKeyID, secretAccessKey: env.remotionAwsSecretAccessKey }
    : appCredentials();
}

function build(credentials: Credentials | undefined, extra: Partial<S3ClientConfig> = {}): S3Client {
  if (!env.awsRegion) throw new Error('AWS_REGION is not set');
  return new S3Client({ region: env.awsRegion, ...(credentials ? { credentials } : {}), ...extra });
}

const clients: { app?: S3Client; presign?: S3Client; remotion?: S3Client } = {};

/** The app's S3 client (media and render buckets) */
export function s3(): S3Client {
  return (clients.app ??= build(appCredentials()));
}

/**
 * For presigned part URLs. By default the SDK signs a checksum of the (empty)
 * body into the URL, so the browser's real part would be rejected; only add
 * checksums S3 requires.
 */
export function s3Presigner(): S3Client {
  return (clients.presign ??= build(appCredentials(), { requestChecksumCalculation: 'WHEN_REQUIRED' }));
}

/** The client for an S3 bucket that holds render outputs */
export function s3ForBucket(bucket: string): S3Client {
  if (bucket && bucket === env.remotionBucket) return (clients.remotion ??= build(remotionCredentials()));
  return s3();
}

/** Tests: use these clients (null: build real ones again) */
export function setS3Clients(next: { app?: S3Client; presign?: S3Client; remotion?: S3Client } | null): void {
  clients.app = next?.app;
  clients.presign = next?.presign ?? next?.app;
  clients.remotion = next?.remotion ?? next?.app;
}

/** The media bucket (STORAGE_PROVIDER=s3) */
export function s3MediaBucket(): string {
  if (!env.s3Bucket) throw new Error('S3_BUCKET is not set');
  return env.s3Bucket;
}

/** The bucket the worker uploads render outputs to (STORAGE_PROVIDER=s3, RENDER_PROVIDER=local) */
export function s3RendersBucket(): string {
  if (!env.s3RendersBucket) throw new Error('S3_RENDERS_BUCKET is not set');
  return env.s3RendersBucket;
}

/** The URL S3 serves an object at (virtual-hosted style) */
export function s3ObjectUrl(bucket: string, key: string): string {
  return `https://${bucket}.s3.${env.awsRegion}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Bucket and key of an S3 object URL (virtual-hosted or path style, or s3://), or null. */
export function parseS3Url(url: string | undefined): { bucket: string; key: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const key = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed.protocol === 's3:') return parsed.hostname && key ? { bucket: parsed.hostname, key } : null;
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const virtual = host.match(/^(.+)\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/);
  if (virtual && key) return { bucket: virtual[1], key };
  const pathStyle = host.match(/^s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/);
  if (pathStyle) {
    const [bucket, ...rest] = key.split('/');
    if (bucket && rest.length > 0) return { bucket, key: rest.join('/') };
  }
  return null;
}

/**
 * The S3 buckets this deploy is configured with. Render outputs elsewhere on
 * S3 (e.g. the pre-GCP account's, which no longer exists) get no link. A
 * bucket stays here after switching provider, so older renders keep working.
 */
export function ownS3Buckets(): string[] {
  return [env.s3Bucket, env.s3RendersBucket, env.remotionBucket].filter(Boolean);
}
