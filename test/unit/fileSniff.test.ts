import { describe, expect, it } from 'vitest';
import { findSvgActiveContent, matchesDeclaredType, sniffKind } from '../../src/utils/fileSniff';
import { contentDispositionFor, createPresignedUpload } from '../../src/services/storage.service';

const hex = (h: string) => Buffer.from(h.replace(/\s/g, ''), 'hex');

describe('sniffKind', () => {
  it('recognises containers by their magic bytes', () => {
    expect(sniffKind(hex('00000018 66747970 6d703432'))).toBe('isobmff');
    expect(sniffKind(hex('1a45dfa3 01'))).toBe('ebml');
    expect(sniffKind(Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00', 'latin1'))).toBe('heif');
    expect(matchesDeclaredType('a.avif', Buffer.from('\x00\x00\x00\x1cftypavif', 'latin1')).ok).toBe(true);
    expect(sniffKind(Buffer.from('RIFF\x00\x00\x00\x00AVI LIST', 'latin1'))).toBe('avi');
    expect(sniffKind(Buffer.from('fLaC\x00\x00\x00\x22', 'latin1'))).toBe('flac');
    expect(sniffKind(hex('000001ba 44000400'))).toBe('mpeg-ps');
    expect(sniffKind(Buffer.from('wOF2\x00\x01', 'latin1'))).toBe('font');
    expect(sniffKind(Buffer.from('  {"v":"5.7.4","layers":[]}'))).toBe('json');
  });

  it("doesn't mistake text or tiny files for media", () => {
    expect(sniffKind(Buffer.from('POST /upload'))).toBe('unknown');
    expect(sniffKind(Buffer.alloc(0))).toBe('unknown');
    expect(sniffKind(hex('fffe3c00'))).toBe('unknown'); // UTF-16 BOM, not an MPEG frame
  });

  it('ignores a storage extension it has no rule for', () => {
    expect(matchesDeclaredType('users/u/uploads/x.xyz', Buffer.from('anything')).ok).toBe(true);
  });
});

describe('findSvgActiveContent', () => {
  it('passes ordinary SVGs, including ones mentioning "on" in text', () => {
    expect(findSvgActiveContent('<svg><text x="1">Turn on the lights</text><path d="M0 0"/></svg>')).toBeNull();
    expect(findSvgActiveContent('<svg><style>.a{fill:red}</style><use href="#a"/></svg>')).toBeNull();
  });

  it('stays fast on hostile input', () => {
    const start = Date.now();
    findSvgActiveContent('<'.repeat(2_000_000));
    findSvgActiveContent(' on'.repeat(500_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('SVG Content-Disposition', () => {
  it('is attachment for SVG only', () => {
    expect(contentDispositionFor('image/svg+xml')).toBe('attachment');
    expect(contentDispositionFor('IMAGE/SVG+XML; charset=utf-8')).toBe('attachment');
    expect(contentDispositionFor('image/png')).toBeUndefined();
  });

  it('is signed into the presigned POST, so the browser must send it', async () => {
    const svg = await createPresignedUpload({ key: 'users/u/uploads/a.svg', contentType: 'image/svg+xml', maxSize: 10 });
    expect(svg.fields['Content-Disposition']).toBe('attachment');
    const policy = JSON.parse(Buffer.from(svg.fields.Policy, 'base64').toString('utf8'));
    expect(policy.conditions).toContainEqual({ 'Content-Disposition': 'attachment' });
    expect(policy.conditions).toContainEqual({ 'Content-Type': 'image/svg+xml' });

    const png = await createPresignedUpload({ key: 'users/u/uploads/a.png', contentType: 'image/png', maxSize: 10 });
    expect(png.fields['Content-Disposition']).toBeUndefined();
  });
});
