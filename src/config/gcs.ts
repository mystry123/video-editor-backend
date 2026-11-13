// config/gcs.ts
//
// One Google Cloud Storage client for the app. It authenticates with
// Application Default Credentials: on the VM, the attached service account
// via the metadata server (no key files: the org disables them). Signed URLs
// and POST policies are then signed by the IAM Credentials API (signBlob), so
// the service account needs roles/iam.serviceAccountTokenCreator on itself.
// Locally, sign in with
//   gcloud auth application-default login \
//     --impersonate-service-account=shotline-backend@shotline-511017.iam.gserviceaccount.com
// (plain user credentials can read and write but cannot sign URLs).

import { Storage } from '@google-cloud/storage';
import { env } from './env';

let client: Storage | null = null;

export function gcs(): Storage {
  if (!client) client = new Storage({ projectId: env.gcpProjectId });
  return client;
}

/** Tests: use this client instead (null: back to the default) */
export function setGcsClient(storage: Storage | null): void {
  client = storage;
}

export function mediaBucket() {
  if (!env.gcsMediaBucket) throw new Error('GCS_MEDIA_BUCKET is not set');
  return gcs().bucket(env.gcsMediaBucket);
}

export function rendersBucket() {
  if (!env.gcsRendersBucket) throw new Error('GCS_RENDERS_BUCKET is not set');
  return gcs().bucket(env.gcsRendersBucket);
}

/** The public URL of an object in the media bucket */
export function publicMediaUrl(key: string): string {
  return `${env.cdnUrl}/${key}`;
}

/** Bucket and object name of a GCS URL (path or virtual-hosted style, or gs://), or null */
export function parseGcsUrl(url: string | undefined): { bucket: string; key: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed.protocol === 'gs:') {
    return parsed.hostname && path ? { bucket: parsed.hostname, key: path } : null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'storage.googleapis.com' || host === 'storage.cloud.google.com') {
    const [bucket, ...rest] = path.split('/');
    return bucket && rest.length > 0 && rest.join('/') ? { bucket, key: rest.join('/') } : null;
  }
  const virtual = host.match(/^(.+)\.storage\.googleapis\.com$/);
  if (virtual && path) return { bucket: virtual[1], key: path };
  return null;
}
