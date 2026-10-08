// utils/media.ts
//
// Safe ffprobe/ffmpeg and file-type handling.
//
// - Commands run with execFile (no shell), so nothing in a URL or filename can
//   be interpreted as shell syntax.
// - URLs must be http(s), so they can't be mistaken for an ffprobe option.
// - Storage extensions come from the allowlists below, never from the client's
//   filename, so storage keys and CDN URLs only contain characters we chose.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { env } from '../config/env';

const execFileAsync = promisify(execFile);

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

const EXTENSION_BY_MIME: Record<string, string> = {
  // video
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/mpeg': 'mpeg',
  'video/3gpp': '3gp',
  // audio
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'weba',
  // images
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  // fonts
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf',
  'application/font-woff': 'woff',
  'application/vnd.ms-opentype': 'otf',
  // Lottie animations
  'application/json': 'json',
};

/**
 * Browsers often send fonts with no type, and some servers send media as
 * octet-stream. Only for those generic types is the filename consulted, and
 * only an extension we'd have chosen ourselves is accepted.
 */
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const EXTENSION_FROM_FILENAME_ALLOWLIST = new Set([...Object.values(EXTENSION_BY_MIME), 'jpeg', 'm4v']);

/**
 * The storage extension for an upload, or null if the type isn't allowed.
 * The result only ever comes from the allowlists above.
 */
export function storageExtension(mimeType: string | undefined, filename?: string): string | null {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  const byMime = EXTENSION_BY_MIME[mime];
  if (byMime) return byMime;

  if (GENERIC_MIME_TYPES.has(mime) && filename) {
    const fromName = filename.toLowerCase().split('.').pop() || '';
    if (EXTENSION_FROM_FILENAME_ALLOWLIST.has(fromName)) return fromName;
  }
  return null;
}

export function isProbeableMedia(mimeType: string | undefined): boolean {
  return !!mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'));
}

// ---------------------------------------------------------------------------
// ffprobe / ffmpeg
// ---------------------------------------------------------------------------

/**
 * URL prefixes media tools may open: our CDN and our two buckets (both S3 URL
 * styles), plus any extra prefixes in MEDIA_TRUSTED_PREFIXES (comma-separated).
 * ffmpeg follows playlists and can read local files, so it must never be
 * pointed at a URL a user chose.
 */
function trustedMediaPrefixes(): string[] {
  const region = env.awsRegion;
  const prefixes: string[] = [];
  if (env.cdnUrl) prefixes.push(`${env.cdnUrl.replace(/\/$/, '')}/`);
  for (const bucket of [env.s3Bucket, env.remotionBucket].filter(Boolean)) {
    prefixes.push(`https://${bucket}.s3.${region}.amazonaws.com/`);
    prefixes.push(`https://${bucket}.s3.amazonaws.com/`);
    prefixes.push(`https://s3.${region}.amazonaws.com/${bucket}/`);
    prefixes.push(`https://s3.amazonaws.com/${bucket}/`);
  }
  for (const extra of (process.env.MEDIA_TRUSTED_PREFIXES || '').split(',')) {
    if (extra.trim()) prefixes.push(extra.trim());
  }
  return prefixes;
}

export function isTrustedMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  // Compare the normalized form so tricks like "https://cdn/../" or encoded hosts don't slip through.
  const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  return trustedMediaPrefixes().some((prefix) => normalized.startsWith(prefix));
}

export class UntrustedMediaUrlError extends Error {
  constructor() {
    super('Media URL is not on a trusted host');
    this.name = 'UntrustedMediaUrlError';
  }
}

function assertMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid media URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Media URL must be http(s)');
  }
  if (!isTrustedMediaUrl(url)) throw new UntrustedMediaUrlError();
}

export interface ProbeResult {
  streams?: Array<Record<string, any>>;
  format?: Record<string, any>;
}

/** Runs ffprobe on a URL and returns its parsed JSON output. */
export async function probeMedia(
  url: string,
  options: { args?: string[]; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  assertMediaUrl(url);
  const args = options.args || ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format'];
  const { stdout } = await execFileAsync(FFPROBE, [...args, url], {
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** Runs ffmpeg reading from a URL. Returns stderr, where ffmpeg writes its analysis. */
export async function runFfmpegOnUrl(
  url: string,
  argsBeforeInput: string[],
  argsAfterInput: string[],
  options: { timeoutMs?: number } = {}
): Promise<string> {
  assertMediaUrl(url);
  try {
    const { stderr } = await execFileAsync(FFMPEG, [...argsBeforeInput, '-i', url, ...argsAfterInput], {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stderr;
  } catch (error: any) {
    // Analysis filters (e.g. volumedetect with `-f null -`) can exit non-zero
    // while still printing the numbers we need.
    if (typeof error?.stderr === 'string' && error.stderr.length > 0 && !error.killed) return error.stderr;
    throw error;
  }
}

export interface BasicMediaMetadata {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec?: string;
  audioCodec?: string;
}

/** Duration, size and audio presence from an ffprobe result. */
export function summarizeProbe(probe: ProbeResult): BasicMediaMetadata {
  const video = probe.streams?.find((s) => s.codec_type === 'video');
  const audio = probe.streams?.find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(video?.duration || audio?.duration || probe.format?.duration || '0') || 0,
    width: video?.width || 0,
    height: video?.height || 0,
    hasAudio: !!audio,
    codec: video?.codec_name,
    audioCodec: audio?.codec_name,
  };
}

/** True if ffprobe can be run at all (used as a startup check). */
export async function ffprobeAvailable(): Promise<boolean> {
  try {
    await execFileAsync(FFPROBE, ['-version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
