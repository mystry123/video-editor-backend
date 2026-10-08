import dns from 'dns';
import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, BlockedUrlError, isBlockedAddress, safeRequest } from '../../src/utils/safeRequest';
import { isTrustedMediaUrl } from '../../src/utils/media';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('assertPublicUrl', () => {
  it('rejects non-http schemes, credentials, local names and private literals', () => {
    for (const url of [
      'file:///etc/passwd', 'gopher://x', 'http://user:pass@example.com/', 'http://localhost:3000/',
      'http://redis.internal/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow(BlockedUrlError);
    }
  });

  it('accepts ordinary public URLs', () => {
    expect(assertPublicUrl('https://example.com/video.mp4').hostname).toBe('example.com');
  });
});

describe('safeRequest', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('internal secret'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses a literal internal IP', async () => {
    await expect(safeRequest(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('refuses a public-looking hostname that resolves to an internal address (DNS rebinding)', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _opts: any, cb: any) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }])) as any);
    try {
      await expect(safeRequest(`http://totally-public.example:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
    } finally {
      lookup.mockRestore();
    }
  });
});

describe('isTrustedMediaUrl', () => {
  it('only trusts our CDN and buckets', () => {
    expect(isTrustedMediaUrl('https://cdn.test/users/1/uploads/a.mp4')).toBe(true);
    expect(isTrustedMediaUrl('https://test-bucket.s3.us-east-1.amazonaws.com/a.mp4')).toBe(true);
    expect(isTrustedMediaUrl('https://cdn.test.evil.com/a.mp4')).toBe(false);
    expect(isTrustedMediaUrl('https://evil.com/https://cdn.test/a.mp4')).toBe(false);
    expect(isTrustedMediaUrl('http://169.254.169.254/latest/')).toBe(false);
    expect(isTrustedMediaUrl('file:///etc/passwd')).toBe(false);
  });
});
