// The GCS storage layer: XML API multipart uploads, signed part URLs, reads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { Storage } from '@google-cloud/storage';
import { setGcsClient, parseGcsUrl } from '../../src/config/gcs';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  getObjectSize,
  listUploadedParts,
  presignUploadParts,
  readObjectStart,
  startMultipartUpload,
} from '../../src/services/storage.service';

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

/** A Storage stand-in whose XML API requests go to `request` */
function fakeStorage(request: (opts: any) => Promise<{ data: string }>, file: Record<string, any> = {}) {
  setGcsClient({ authClient: { request }, bucket: () => ({ file: () => file }) } as any);
}

afterEach(() => setGcsClient(null));

describe('multipart uploads (GCS XML API)', () => {
  it('starts an upload with the content type and SVG disposition', async () => {
    const request = vi.fn(async () => ({ data: '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>' }));
    fakeStorage(request);
    expect(await startMultipartUpload('users/u/uploads/a b.svg', 'image/svg+xml')).toBe('up-1');
    const opts = (request.mock.calls[0] as any[])[0];
    expect(opts.method).toBe('POST');
    expect(opts.url).toBe('https://storage.googleapis.com/test-bucket/users/u/uploads/a%20b.svg?uploads');
    expect(opts.headers).toMatchObject({ 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'attachment' });
  });

  it('lists parts across pages, and null once the upload is gone', async () => {
    const page1 = '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker>' +
      '<Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>8388608</Size></Part></ListPartsResult>';
    const page2 = '<ListPartsResult><IsTruncated>false</IsTruncated>' +
      '<Part><PartNumber>2</PartNumber><ETag>"e2"</ETag><Size>10</Size></Part></ListPartsResult>';
    const request = vi.fn().mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 });
    fakeStorage(request);
    expect(await listUploadedParts('k', 'up 1')).toEqual([
      { partNumber: 1, etag: '"e1"', size: 8388608 },
      { partNumber: 2, etag: '"e2"', size: 10 },
    ]);
    expect(request.mock.calls[0][0].url).toBe('https://storage.googleapis.com/test-bucket/k?uploadId=up%201');
    expect(request.mock.calls[1][0].url).toBe('https://storage.googleapis.com/test-bucket/k?uploadId=up%201&part-number-marker=1');

    fakeStorage(vi.fn().mockRejectedValue(httpError(404)));
    expect(await listUploadedParts('k', 'up-1')).toBeNull();
  });

  it('completes with the parts in an XML body, and treats an error body as a failure', async () => {
    const request = vi.fn(async () => ({ data: '<CompleteMultipartUploadResult/>' }));
    fakeStorage(request);
    await completeMultipartUpload('k', 'up-1', [{ partNumber: 1, etag: '"e1"', size: 1 }, { partNumber: 2, etag: '"e2"', size: 1 }]);
    const opts = (request.mock.calls[0] as any[])[0];
    expect(opts.method).toBe('POST');
    expect(opts.url).toBe('https://storage.googleapis.com/test-bucket/k?uploadId=up-1');
    expect(opts.data).toBe('<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>');

    fakeStorage(vi.fn(async () => ({ data: '<Error><Code>InvalidPart</Code></Error>' })));
    await expect(completeMultipartUpload('k', 'up-1', [])).rejects.toThrow(/InvalidPart/);
  });

  it('aborting an upload that is already gone is fine', async () => {
    const request = vi.fn().mockRejectedValue(httpError(404));
    fakeStorage(request);
    await expect(abortMultipartUpload('k', 'up-1')).resolves.toBeUndefined();
    expect(request.mock.calls[0][0].method).toBe('DELETE');
    fakeStorage(vi.fn().mockRejectedValue(httpError(500)));
    await expect(abortMultipartUpload('k', 'up-1')).rejects.toThrow();
  });

  it('signs a V4 PUT URL per part carrying partNumber and uploadId', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    setGcsClient(new Storage({ projectId: 'test', credentials: { client_email: 'signer@test.iam.gserviceaccount.com', private_key: privateKey } }));
    const urls = await presignUploadParts('users/u/uploads/v.mp4', 'up-1', [1, 2]);
    for (const n of [1, 2]) {
      const url = new URL(urls[n]);
      expect(`${url.origin}${url.pathname}`).toBe('https://storage.googleapis.com/test-bucket/users/u/uploads/v.mp4');
      expect(url.searchParams.get('partNumber')).toBe(String(n));
      expect(url.searchParams.get('uploadId')).toBe('up-1');
      expect(url.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
      expect(url.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe('reads', () => {
  it('readObjectStart: a ranged read; null when missing; empty for an empty object', async () => {
    const download = vi.fn(async () => [Buffer.from('abc')]);
    fakeStorage(vi.fn(), { download });
    expect(await readObjectStart('k', 16)).toEqual(Buffer.from('abc'));
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ start: 0, end: 15 }));

    fakeStorage(vi.fn(), { download: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 })) });
    expect(await readObjectStart('k', 16)).toBeNull();
    fakeStorage(vi.fn(), { download: vi.fn().mockRejectedValue(Object.assign(new Error('range'), { code: 416 })) });
    expect(await readObjectStart('k', 16)).toEqual(Buffer.alloc(0));
  });

  it('getObjectSize: the stored size, or null when missing', async () => {
    fakeStorage(vi.fn(), { getMetadata: vi.fn(async () => [{ size: '1234' }]) });
    expect(await getObjectSize('k')).toBe(1234);
    fakeStorage(vi.fn(), { getMetadata: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 })) });
    expect(await getObjectSize('k')).toBeNull();
  });
});

describe('parseGcsUrl', () => {
  it('reads path-style, virtual-hosted and gs:// URLs only', () => {
    expect(parseGcsUrl('https://storage.googleapis.com/b/users/1/a%20b.mp4')).toEqual({ bucket: 'b', key: 'users/1/a b.mp4' });
    expect(parseGcsUrl('https://b.storage.googleapis.com/x.mp4')).toEqual({ bucket: 'b', key: 'x.mp4' });
    expect(parseGcsUrl('gs://b/x.mp4')).toEqual({ bucket: 'b', key: 'x.mp4' });
    expect(parseGcsUrl('https://evil.com/storage.googleapis.com/b/x')).toBeNull();
    expect(parseGcsUrl('http://storage.googleapis.com/b/x')).toBeNull();
    expect(parseGcsUrl('not a url')).toBeNull();
  });
});
