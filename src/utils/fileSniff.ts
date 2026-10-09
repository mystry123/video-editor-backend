// utils/fileSniff.ts
//
// Checks that an upload's first bytes look like the kind of file it was
// declared as, so a renamed executable, HTML page or archive can't sit in the
// media bucket posing as a video or image (and be handed to ffmpeg, Lambda or
// another user's browser).
//
// The check is by category, not exact format, and deliberately lenient: a
// browser that labels an .mkv as video/mp4 or a .png as image/jpeg is common,
// and those files still play. What must match is the family — a "video" has
// to start like a video container, an "image" like an image.

/** What the bytes look like. */
export type SniffedKind =
  | 'isobmff' // MP4, MOV, M4A, 3GP (ftyp box or classic QuickTime atoms)
  | 'heif' // AVIF / HEIC images: ISO BMFF with an image major brand
  | 'ebml' // WebM, Matroska
  | 'avi'
  | 'wav'
  | 'webp'
  | 'ogg'
  | 'mp3' // MPEG audio frame, or an ID3 tag (MP3s and some AAC files carry one)
  | 'aac' // ADTS
  | 'flac'
  | 'mpeg-ps'
  | 'mpeg-ts'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'svg'
  | 'font'
  | 'json'
  | 'unknown';

/** Bytes to read from the start of an upload for sniffing. */
export const SNIFF_BYTES = 4096;

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

// Classic QuickTime files may start with one of these atoms instead of ftyp.
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid']);
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1']);

export function sniffKind(buf: Buffer): SniffedKind {
  if (buf.length < 4) return 'unknown';
  const b = buf;

  if (b.length >= 8) {
    const box = ascii(b, 4, 8);
    if (box === 'ftyp' && b.length >= 12 && IMAGE_BRANDS.has(ascii(b, 8, 12))) return 'heif';
    if (box === 'ftyp' || QUICKTIME_ATOMS.has(box)) return 'isobmff';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'ebml';
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    const form = ascii(b, 8, 12);
    if (form === 'WAVE') return 'wav';
    if (form === 'AVI ') return 'avi';
    if (form === 'WEBP') return 'webp';
  }
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (ascii(b, 0, 4) === 'fLaC') return 'flac';
  if (ascii(b, 0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0x89 && ascii(b, 1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xba || b[3] === 0xb3)) return 'mpeg-ps';
  if (b[0] === 0x47 && b.length >= 189 && b[188] === 0x47) return 'mpeg-ts';
  const frame = audioFrameKind(b);
  if (frame) return frame;

  const magic = ascii(b, 0, 4);
  if (magic === 'wOFF' || magic === 'wOF2' || magic === 'OTTO' || magic === 'true' || magic === 'ttcf') return 'font';
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'font';

  // Text formats: skip a UTF-8 BOM and leading whitespace.
  const text = b.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (looksLikeSvg(text)) return 'svg';
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  return 'unknown';
}

/**
 * MPEG audio or ADTS (AAC) frame header: 11 sync bits, then fields that must
 * not hold their reserved values (which also rules out a UTF-16 BOM, FF FE).
 */
function audioFrameKind(b: Buffer): 'mp3' | 'aac' | null {
  if (b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return null;
  const layer = (b[1] >> 1) & 0x03;
  if (layer === 0) {
    // ADTS: MPEG version bit, layer 00, sampling-frequency index 0..12.
    return (b[1] & 0xf6) === 0xf0 && ((b[2] >> 2) & 0x0f) <= 12 ? 'aac' : null;
  }
  const version = (b[1] >> 3) & 0x03;
  const bitrate = b[2] >> 4;
  const sampleRate = (b[2] >> 2) & 0x03;
  return version !== 1 && bitrate !== 0x0f && sampleRate !== 0x03 ? 'mp3' : null;
}

/** An XML declaration, comments or a doctype may come before the <svg> root. */
function looksLikeSvg(text: string): boolean {
  if (!text.startsWith('<')) return false;
  const rest = text
    .replace(/^<\?xml[\s\S]*?\?>/i, '')
    .replace(/^(\s*(<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>|<\?[\s\S]*?\?>))*/i, '')
    .trimStart();
  return /^<svg[\s>]/i.test(rest);
}

type Category = 'video' | 'audio' | 'image' | 'svg' | 'font' | 'json';

const CATEGORY_BY_EXTENSION: Record<string, Category> = {
  mp4: 'video', m4v: 'video', mov: 'video', '3gp': 'video', avi: 'video', mkv: 'video', webm: 'video', mpeg: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', aac: 'audio', flac: 'audio', m4a: 'audio', weba: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', avif: 'image',
  svg: 'svg',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  json: 'json',
};

const ACCEPTED: Record<Category, SniffedKind[]> = {
  video: ['isobmff', 'ebml', 'avi', 'ogg', 'mpeg-ps', 'mpeg-ts'],
  // Audio-only files in video containers (an .m4a, a .weba) are normal.
  audio: ['isobmff', 'ebml', 'ogg', 'mp3', 'aac', 'wav', 'flac'],
  // Any raster format: browsers mislabel PNG/JPEG/WebP often.
  image: ['png', 'jpeg', 'gif', 'webp', 'heif'],
  svg: ['svg'],
  font: ['font'],
  json: ['json'],
};

export interface SniffResult {
  ok: boolean;
  /** What the bytes looked like. */
  detected: SniffedKind;
  /** What the storage extension promised; null when there's no rule for it (then ok is true). */
  expected: Category | null;
}

/**
 * Does `head` (the first bytes of an upload) match the category of its
 * storage extension? Extensions come from media.ts's allowlist, so an
 * extension without a rule here is a new type nobody has added yet: allowed.
 */
export function matchesDeclaredType(storageKey: string, head: Buffer): SniffResult {
  const ext = storageKey.toLowerCase().split('.').pop() || '';
  const expected = CATEGORY_BY_EXTENSION[ext] ?? null;
  const detected = sniffKind(head);
  if (!expected) return { ok: true, detected, expected };
  return { ok: ACCEPTED[expected].includes(detected), detected, expected };
}

// ---------------------------------------------------------------------------
// SVG active content
// ---------------------------------------------------------------------------

/** Bytes of an SVG scanned for scripts. Larger SVGs are scanned up to this. */
export const SVG_SCAN_BYTES = 2 * 1024 * 1024;

const SVG_ACTIVE_CONTENT: Array<[string, RegExp]> = [
  ['script element', /<(?:[a-z0-9_-]+:)?script[\s>/]/i],
  // Anywhere, not just inside a tag: simpler, linear-time, and an attribute
  // value may legally contain ">". Plain text rarely reads " onfoo=".
  ['event handler attribute', /[\s"'/]on[a-z]+\s*=/i],
  ['javascript: URL', /(?:java|vb)script\s*:/i],
  ['embedded HTML document', /data:\s*text\/html/i],
  ['embedded frame or object', /<(?:[a-z0-9_-]+:)?(?:iframe|embed|object)[\s>/]/i],
];

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}

/**
 * Why an SVG could run code if opened as a page, or null if it looks static.
 * Numeric character references are decoded first, so "&#106;avascript:"
 * doesn't slip past. SVGs used as images never run scripts, but a user (or an
 * attacker sending a link) can open the file directly.
 */
export function findSvgActiveContent(svg: string): string | null {
  const decoded = svg
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_, dec) => codePoint(Number(dec)))
    .replace(/&(?:tab|newline);/gi, '');
  for (const [reason, pattern] of SVG_ACTIVE_CONTENT) {
    if (pattern.test(decoded)) return reason;
  }
  return null;
}
