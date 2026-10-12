// utils/audioEncode.ts
//
// WAV to MP3 with ffmpeg (stdin to stdout): about a fifth of the size, which
// is what users' storage is charged for.

import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegInstaller.path;

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
    child.on('close', (code) => {
      clearTimeout(timer);
      const mp3 = Buffer.concat(out);
      if (code === 0 && mp3.length > 0) resolve(mp3);
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.on('error', () => undefined); // ffmpeg may exit before reading everything
    child.stdin.end(wav);
  });
}
