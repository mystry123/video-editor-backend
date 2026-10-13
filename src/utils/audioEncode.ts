// utils/audioEncode.ts
//
// WAV to MP3 with ffmpeg (stdin to stdout): about a fifth of the size, which
// is what users' storage is charged for.

import { spawn } from 'node:child_process';
import { assertMediaUrl } from './media';

import { FFMPEG_PATH as FFMPEG } from './ffmpegPath';

export function wavToMp3(wav: Buffer, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const mp3 = Buffer.concat(out);
      if (code === 0 && mp3.length > 0) resolve(mp3);
      else reject(new Error(`ffmpeg (${FFMPEG}) exited ${code ?? signal}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.on('error', () => undefined); // ffmpeg may exit before reading everything
    child.stdin.end(wav);
  });
}

/**
 * The sound of a media file (audio or video) on our storage as a mono MP3:
 * what voice tools are sent, smaller than the source and the same length.
 */
export function extractAudioMp3(url: string, { timeoutMs = 5 * 60_000 }: { timeoutMs?: number } = {}): Promise<Buffer> {
  assertMediaUrl(url);
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', url, '-vn', '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const mp3 = Buffer.concat(out);
      if (code === 0 && mp3.length > 0) resolve(mp3);
      else reject(new Error(/does not contain any stream|Output file .* does not contain/i.test(err) ? 'NO_AUDIO' : `ffmpeg (${FFMPEG}) exited ${code ?? signal}: ${err.trim().slice(0, 300)}`));
    });
  });
}
