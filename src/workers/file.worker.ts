// workers/file.worker.ts

import { Job } from 'bullmq';
import { exec } from 'child_process';
import { promisify } from 'util';
import { File } from '../models/File';
import { createWorker, createJobLogger, retryWithBackoff } from '../utils/worker.utils';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

interface FileJobData {
  fileId: string;
}

interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
  audioCodec?: string;
}

// ============================================================================
// Helper: Extract Metadata
// ============================================================================

async function extractMetadata(
  cdnUrl: string,
  mimeType: string,
  log: ReturnType<typeof createJobLogger>
): Promise<MediaMetadata> {
  if (!cdnUrl) {
    throw new Error('CDN URL required');
  }

  // Only process video/audio
  if (!mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
    return {};
  }

  try {
    const { stdout } = await Promise.race([
      execAsync(`ffprobe -v quiet -print_format json -show_streams -show_format "${cdnUrl}"`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ffprobe timeout')), 30000)
      ),
    ]);

    const data = JSON.parse(stdout);
    const video = data.streams?.find((s: any) => s.codec_type === 'video');
    const audio = data.streams?.find((s: any) => s.codec_type === 'audio');

    const metadata: MediaMetadata = {
      duration: parseFloat(video?.duration || audio?.duration || data.format?.duration) || 0,
      width: video?.width || 0,
      height: video?.height || 0,
      codec: video?.codec_name,
      audioCodec: audio?.codec_name,
    };

    log.info(`Metadata: ${metadata.width}x${metadata.height}, ${metadata.duration}s`);
    return metadata;
  } catch (error: any) {
    log.warn(`ffprobe failed: ${error.message}`);
    return { duration: 0, width: 0, height: 0 };
  }
}

// ============================================================================
// Main Processor
// ============================================================================

async function processFileJob(job: Job<FileJobData>) {
  const { fileId } = job.data;
  const log = createJobLogger('File', fileId);

  log.info('Processing');

  const file = await File.findById(fileId);
  if (!file) {
    log.warn('File not found');
    return { skipped: true, reason: 'not_found' };
  }

  // Skip if already processed
  if (file.status === 'ready') {
    log.info('Already ready');
    return { skipped: true, reason: 'already_ready' };
  }

  try {
    let metadata: MediaMetadata = {};

    if (file.mimeType.startsWith('image/')) {
      // For images, try to get dimensions
      try {
        const result = await extractMetadata(file.cdnUrl, 'video/mp4', log);
        metadata = { width: result.width, height: result.height };
      } catch {
        metadata = { width: 0, height: 0 };
      }
    } else if (file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/')) {
      metadata = await retryWithBackoff(
        () => extractMetadata(file.cdnUrl, file.mimeType, log),
        {
          maxRetries: 2,
          initialDelay: 1000,
          onRetry: (err, attempt) => log.warn(`Retry ${attempt}: ${err.message}`),
        }
      );
    }

    await File.updateOne(
      { _id: fileId },
      { status: 'ready', metadata, processedAt: new Date() }
    );

    log.info('Processed');
    return { success: true, metadata };
  } catch (error: any) {
    log.error(`Failed: ${error.message}`);
    await File.updateOne({ _id: fileId }, { status: 'error', error: error.message });
    throw error;
  }
}

// ============================================================================
// Create Worker
// ============================================================================

const fileWorker = createWorker({
  name: 'file-processing',
  processor: processFileJob,
  concurrency: 10,
  lockDuration: 60000,
});

export default fileWorker;