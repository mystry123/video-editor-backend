// utils/ffmpegPath.ts
//
// Which ffmpeg to run: FFMPEG_PATH if set, else the system's (the EC2 box has
// /usr/bin/ffmpeg, the same one ffprobe calls use), else the bundled
// @ffmpeg-installer binary. The bundled one alone failed in production (it
// was killed on start), which silently broke audio clean-up and dubbing.

import { accessSync, constants } from 'node:fs';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const SYSTEM_PATHS = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const system = SYSTEM_PATHS.find(executable);
  if (system) return system;
  return ffmpegInstaller.path;
}

export const FFMPEG_PATH = resolveFfmpegPath();
