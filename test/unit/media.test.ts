import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ffprobeAvailable, probeMedia, storageExtension } from '../../src/utils/media';

describe('storageExtension', () => {
  it('derives the extension from the MIME type, ignoring the filename', () => {
    expect(storageExtension('video/mp4', 'a.$(curl evil|sh)')).toBe('mp4');
    expect(storageExtension('video/mp4', 'x";rm -rf /;"')).toBe('mp4');
    expect(storageExtension('image/jpeg; charset=binary', 'photo.exe')).toBe('jpg');
  });

  it('uses an allowlisted filename extension only for generic types', () => {
    expect(storageExtension('', 'Inter.woff2')).toBe('woff2');
    expect(storageExtension('application/octet-stream', 'clip.MOV')).toBe('mov');
    expect(storageExtension('application/octet-stream', 'shell.$(id)')).toBeNull();
    expect(storageExtension('application/octet-stream', 'run.sh')).toBeNull();
  });

  it('rejects types that are not allowed', () => {
    expect(storageExtension('text/html', 'x.html')).toBeNull();
    expect(storageExtension('application/x-sh', 'x.sh')).toBeNull();
    expect(storageExtension(undefined)).toBeNull();
  });
});

describe('probeMedia', () => {
  it('only accepts http(s) URLs, so a value can never be read as an option or local path', async () => {
    await expect(probeMedia('-version')).rejects.toThrow(/Invalid media URL|http/);
    await expect(probeMedia('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(probeMedia('concat:a|b')).rejects.toThrow();
  });

  it('never runs shell syntax embedded in a URL', async () => {
    if (!(await ffprobeAvailable())) return; // ffprobe isn't installed on every machine
    // Trust the test target so the URL actually reaches ffprobe.
    process.env.MEDIA_TRUSTED_PREFIXES = 'http://127.0.0.1:9/';
    const marker = join(tmpdir(), `shotline-injection-${process.pid}`);
    rmSync(marker, { force: true });
    await expect(
      probeMedia(`http://127.0.0.1:9/a.mp4";touch ${marker};"$(touch ${marker})`, { timeoutMs: 5_000 })
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    delete process.env.MEDIA_TRUSTED_PREFIXES;
  });

  it('refuses URLs outside our storage, before running anything', async () => {
    await expect(probeMedia('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/trusted/);
    await expect(probeMedia('https://evil.example/video.m3u8')).rejects.toThrow(/trusted/);
  });
});
