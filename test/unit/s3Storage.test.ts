// The S3 storage backend (STORAGE_PROVIDER=s3) and S3 render outputs, with a
// real S3Client whose network calls (`send`) are faked. Presigning is real:
// it is local maths with the (fake) static keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../../src/config/env';
import { setS3Clients } from '../../src/config/aws';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  copyToCDN,
  createPresignedUpload,
  deleteFromS3,
  deleteS3Prefix,
  getObjectSize,
  listUploadedParts,
  presignUploadParts,
  readObjectStart,
  startMultipartUpload,
  uploadBufferToS3,
  uploadRenderFile,
} from '../../src/services/storage.service';
import { deleteOutput, parseStorageUrl, presignOutput } from '../../src/services/renderOutput.service';

const saved = { ...env };
const credentials = { accessKeyId: 'AKIATESTTESTTEST', secretAccessKey: 'test-secret-key' };

function s3Error(name: string, status: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

let client: S3Client;
let send: ReturnType<typeof vi.fn>;
const commands = () => send.mock.calls.map(([cmd]: any[]) => ({ name: cmd.constructor.name, input: cmd.input }));

beforeEach(() => {
  Object.assign(env, {
    storageProvider: 's3',
    awsRegion: 'us-east-1',
    s3Bucket: 'shotline-media',
    s3RendersBucket: 'shotline-renders',
    cdnUrl: 'https://cdn.test',
  });
  client = new S3Client({ region: 'us-east-1', credentials });
  send = vi.fn(async () => ({}));
  (client as any).send = send;
  setS3Clients({ app: client, presign: new S3Client({ region: 'us-east-1', credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }) });
});
afterEach(() => {
  Object.assign(env, saved);
  setS3Clients(null);
});

describe('S3 uploads', () => {
  it('signs a browser POST upload with the size range, type and SVG disposition', async () => {
    const { url, fields } = await createPresignedUpload({ key: 'users/u/a.svg', contentType: 'image/svg+xml', maxSize: 1000 });
    expect(url).toBe('https://shotline-media.s3.us-east-1.amazonaws.com/');
    expect(fields).toMatchObject({ key: 'users/u/a.svg', 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'attachment' });
    const policy = JSON.parse(Buffer.from(fields.Policy, 'base64').toString());
    expect(policy.conditions).toEqual(
      expect.arrayContaining([['content-length-range', 0, 1000], ['starts-with', '$Content-Type', 'image'], { bucket: 'shotline-media' }])
    );
  });

  it('runs a multipart upload: start, part URLs without a body checksum, list, complete', async () => {
    send.mockImplementation(async (cmd: any) => {
      switch (cmd.constructor.name) {
        case 'CreateMultipartUploadCommand':
          return { UploadId: 'up-1' };
        case 'ListPartsCommand':
          return cmd.input.PartNumberMarker
            ? { Parts: [{ PartNumber: 1, ETag: '"e1"', Size: 8 }], IsTruncated: false }
            : { Parts: [{ PartNumber: 2, ETag: '"e2"', Size: 3 }], IsTruncated: true, NextPartNumberMarker: '2' };
        default:
          return {};
      }
    });

    expect(await startMultipartUpload('users/u/v.mp4', 'video/mp4')).toBe('up-1');
    expect(commands()[0].input).toEqual({ Bucket: 'shotline-media', Key: 'users/u/v.mp4', ContentType: 'video/mp4' });

    const urls = await presignUploadParts('users/u/v.mp4', 'up-1', [1, 2]);
    const part = new URL(urls[2]);
    expect(part.host).toBe('shotline-media.s3.us-east-1.amazonaws.com');
    expect(part.searchParams.get('partNumber')).toBe('2');
    expect(part.searchParams.get('uploadId')).toBe('up-1');
    expect(part.searchParams.get('X-Amz-Expires')).toBe('3600');
    // A signed checksum of the empty body would make S3 reject the real part.
    expect([...part.searchParams.keys()].some((k) => /checksum/i.test(k))).toBe(false);

    const parts = await listUploadedParts('users/u/v.mp4', 'up-1');
    expect(parts).toEqual([
      { partNumber: 1, etag: '"e1"', size: 8 },
      { partNumber: 2, etag: '"e2"', size: 3 },
    ]);

    await completeMultipartUpload('users/u/v.mp4', 'up-1', parts!);
    expect(commands().at(-1)).toEqual({
      name: 'CompleteMultipartUploadCommand',
      input: {
        Bucket: 'shotline-media',
        Key: 'users/u/v.mp4',
        UploadId: 'up-1',
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"e1"' }, { PartNumber: 2, ETag: '"e2"' }] },
      },
    });
  });

  it('treats a missing upload as finished: list gives null, abort is fine', async () => {
    send.mockRejectedValue(s3Error('NoSuchUpload', 404));
    expect(await listUploadedParts('k', 'gone')).toBeNull();
    await expect(abortMultipartUpload('k', 'gone')).resolves.toBeUndefined();
    send.mockRejectedValue(s3Error('AccessDenied', 403));
    await expect(abortMultipartUpload('k', 'x')).rejects.toThrow('AccessDenied');
  });

  it('uploads buffers with a long cache and returns the CDN URL', async () => {
    expect(await uploadBufferToS3(Buffer.from('x'), 'generated/a.png', 'image/png')).toBe('https://cdn.test/generated/a.png');
    expect(commands()[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: { Bucket: 'shotline-media', Key: 'generated/a.png', ContentType: 'image/png', CacheControl: 'public, max-age=31536000' },
    });
    expect(await copyToCDN('a', 'b/c.png')).toBe('https://cdn.test/b/c.png');
  });
});

describe('S3 reads and deletes', () => {
  it('reads the start of an object with a range; missing is null, empty is empty', async () => {
    send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    expect(await readObjectStart('k', 16)).toEqual(Buffer.from([1, 2, 3]));
    expect(commands()[0].input).toEqual({ Bucket: 'shotline-media', Key: 'k', Range: 'bytes=0-15' });

    send.mockRejectedValueOnce(s3Error('NoSuchKey', 404));
    expect(await readObjectStart('k', 16)).toBeNull();
    send.mockRejectedValueOnce(s3Error('InvalidRange', 416));
    expect(await readObjectStart('k', 16)).toEqual(Buffer.alloc(0));
  });

  it('reports sizes; missing objects are null', async () => {
    send.mockResolvedValueOnce({ ContentLength: 42 });
    expect(await getObjectSize('k')).toBe(42);
    send.mockRejectedValueOnce(s3Error('NotFound', 404));
    expect(await getObjectSize('k')).toBeNull();
  });

  it('deletes single objects and whole prefixes page by page, in either bucket', async () => {
    await deleteFromS3('users/u/a.mp4');
    expect(commands()[0]).toEqual({ name: 'DeleteObjectCommand', input: { Bucket: 'shotline-media', Key: 'users/u/a.mp4' } });

    send.mockReset();
    send.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return cmd.input.ContinuationToken
          ? { Contents: [{ Key: 'renders/u/3.mp4' }], IsTruncated: false }
          : { Contents: [{ Key: 'renders/u/1.mp4' }, { Key: 'renders/u/2.mp4' }], IsTruncated: true, NextContinuationToken: 't2' };
      }
      return {};
    });
    expect(await deleteS3Prefix('renders/u/', 'renders')).toBe(3);
    const deletes = commands().filter((c) => c.name === 'DeleteObjectsCommand');
    expect(deletes.map((d) => d.input.Bucket)).toEqual(['shotline-renders', 'shotline-renders']);
    expect(deletes[0].input.Delete.Objects).toEqual([{ Key: 'renders/u/1.mp4' }, { Key: 'renders/u/2.mp4' }]);

    await expect(deleteS3Prefix('users')).rejects.toThrow(/unsafe prefix/);
  });

  it('fails a prefix delete when S3 reports per-object errors', async () => {
    send.mockImplementation(async (cmd: any) =>
      cmd.constructor.name === 'ListObjectsV2Command'
        ? { Contents: [{ Key: 'users/u/a' }] }
        : { Errors: [{ Key: 'users/u/a', Message: 'Access Denied' }] }
    );
    await expect(deleteS3Prefix('users/u/')).rejects.toThrow(/Failed to delete 1 objects.*Access Denied/);
  });
});

describe('S3 render outputs', () => {
  it('uploads a render file to the private renders bucket and returns its S3 URL', async () => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(os.tmpdir(), `s3-render-${Date.now()}.mp4`);
    await fs.writeFile(file, 'video');
    try {
      expect(await uploadRenderFile(file, 'renders/u/j.mp4', 'video/mp4')).toBe('https://shotline-renders.s3.us-east-1.amazonaws.com/renders/u/j.mp4');
      expect(commands()[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'shotline-renders', Key: 'renders/u/j.mp4', ContentType: 'video/mp4' } });
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('signs outputs in our S3 buckets (with a download name) and deletes them', async () => {
    const outputUrl = 'https://shotline-renders.s3.us-east-1.amazonaws.com/renders/u/j1.mp4';
    expect(parseStorageUrl(outputUrl)).toEqual({ provider: 's3', bucket: 'shotline-renders', key: 'renders/u/j1.mp4' });

    const view = new URL((await presignOutput({ _id: 's3-view-1', outputUrl, outputFormat: 'mp4' }))!);
    expect(view.host).toBe('shotline-renders.s3.us-east-1.amazonaws.com');
    expect(view.pathname).toBe('/renders/u/j1.mp4');
    expect(view.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(view.searchParams.get('response-content-disposition')).toBeNull();

    const download = new URL((await presignOutput({ _id: 's3-dl-1', outputUrl, outputFormat: 'mp4' }, { download: true }))!);
    expect(download.searchParams.get('response-content-disposition')).toBe('attachment; filename="shotline-s3-dl-1.mp4"');

    await deleteOutput({ _id: 's3-view-1', outputUrl });
    expect(commands().at(-1)).toEqual({ name: 'DeleteObjectCommand', input: { Bucket: 'shotline-renders', Key: 'renders/u/j1.mp4' } });
  });

  it('gives no link to S3 outputs in buckets this deploy does not have', async () => {
    const foreign = 'https://remotionlambda-old.s3.ap-south-1.amazonaws.com/renders/u/j.mp4';
    expect(parseStorageUrl(foreign)).toBeNull();
    expect(await presignOutput({ _id: 'old', outputUrl: foreign })).toBeNull();
  });
});
