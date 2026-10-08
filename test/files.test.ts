import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return {
    ...actual,
    createPresignedUpload: vi.fn(async ({ key }: { key: string }) => ({ url: 'https://s3.test/', fields: { key } })),
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
