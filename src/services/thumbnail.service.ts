// services/thumbnail.service.ts

import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { uploadThumbnail } from './storage.service';
import { logger } from '../utils/logger';

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface ThumbnailOptions {
  videoUrl: string;
  renderId: string;
  timestamp?: number;
  width?: number;
}

interface ThumbnailResult {
  success: boolean;
  thumbnailUrl?: string;
  error?: string;
}

/**
 * Generate thumbnail from video URL using FFmpeg and upload to S3
 */
export async function generateThumbnailFromVideo(options: ThumbnailOptions): Promise<ThumbnailResult> {
  const { 
    videoUrl, 
    renderId,
    timestamp = 1, 
    width = 640,
  } = options;

  const tempDir = os.tmpdir();
  const tempFileName = `thumb_${renderId}_${Date.now()}.jpg`;
  const tempFilePath = path.join(tempDir, tempFileName);

  try {
    logger.info('Generating thumbnail', { videoUrl, renderId, timestamp, width });

    // Check if video URL is accessible
    logger.info('Checking video URL accessibility...');
    const response = await fetch(videoUrl, { method: 'HEAD' });
    if (!response.ok) {
      throw new Error(`Video URL not accessible: ${response.status} ${response.statusText}`);
    }
    logger.info('Video URL is accessible', { contentType: response.headers.get('content-type') });

    // Generate thumbnail using FFmpeg
    await new Promise<void>((resolve, reject) => {
      const ffmpegProcess = ffmpeg(videoUrl)
        .seekInput(timestamp)
        .frames(1)
        .outputOptions([
          '-vf', `scale=${width}:-1`, // Maintain aspect ratio
          '-q:v', '2', // High quality JPEG
          '-y', // Overwrite output file
        ])
        .output(tempFilePath)
        .on('start', (commandLine) => {
          logger.info('FFmpeg command started', { commandLine });
        })
        .on('end', () => {
          logger.info('Thumbnail generated locally', { tempFilePath });
          resolve();
        })
        .on('error', (err: any) => {
          logger.error('FFmpeg error', { error: err.message, stdout: err.stdout, stderr: err.stderr });
          reject(err);
        })
        .on('progress', (progress) => {
          logger.debug('FFmpeg progress', { progress });
        });

      ffmpegProcess.run();
    });

    // Verify thumbnail was created
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('Thumbnail file was not created');
    }

    const stats = fs.statSync(tempFilePath);
    logger.info('Thumbnail file stats', { size: stats.size, path: tempFilePath });

    if (stats.size === 0) {
      throw new Error('Thumbnail file is empty');
    }

    // Read and upload to S3
    const thumbnailBuffer = fs.readFileSync(tempFilePath);
    const thumbnailUrl = await uploadThumbnail(thumbnailBuffer, renderId);

    // Cleanup temp file
    fs.unlinkSync(tempFilePath);

    logger.info('Thumbnail uploaded successfully', { renderId, thumbnailUrl });

    return {
      success: true,
      thumbnailUrl,
    };

  } catch (error: any) {
    // Cleanup temp file on error
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        logger.error('Failed to cleanup temp file', { error: cleanupError });
      }
    }

    logger.error('Thumbnail generation failed', { 
      error: error.message, 
      stack: error.stack,
      videoUrl, 
      renderId,
      timestamp,
      width 
    });
    return {
      success: false,
      error: error.message,
    };
  }
}