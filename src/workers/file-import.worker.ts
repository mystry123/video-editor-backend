import { Job, Worker } from 'bullmq';
import axios from 'axios';
import { Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { File } from '../models/File';
import { quotaService } from '../services/quota.service';
import { env } from '../config/env';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';
import { redisConnectionOptions } from '../config/redis';
import { registerWorker } from '../queues';

const execAsync = promisify(exec);

// S3 Client
const s3Client = new S3Client({
  region: env.awsRegion,
  credentials: {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
  },
});

// ============================================================================
// Job Processors
// ============================================================================

/**
 * Process URL import job
 */
async function processUrlImport(job: Job): Promise<void> {
  const { fileId, url, key, userId, contentType, contentLength } = job.data;

  logger.info(`[file-import] Starting URL import`, { fileId, url });

  try {
    // Update progress
    await updateFileProgress(fileId, 5);

    // Download file as stream
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 600000, // 10 minutes
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShotlineBot/1.0)',
      },
    });

    const stream = response.data as Readable;
    const totalSize = contentLength || parseInt(response.headers['content-length'] || '0', 10);
    const finalContentType = contentType || response.headers['content-type'] || 'video/mp4';

    // Upload to S3 with progress tracking
    let uploadedBytes = 0;
    const upload = createS3Upload(key, stream, finalContentType);

    upload.on('httpUploadProgress', async (progress) => {
      if (totalSize > 0 && progress.loaded) {
        uploadedBytes = progress.loaded;
        const percent = calculateProgress(progress.loaded, totalSize);
        await updateFileProgress(fileId, percent);
        await job.updateProgress(percent);
      }
    });

    await upload.done();
    logger.info(`[file-import] S3 upload completed`, { fileId });

    // Extract metadata and finalize
    await finalizeImport(fileId, key, userId, totalSize || uploadedBytes);

    logger.info(`[file-import] URL import completed`, { fileId });
  } catch (error: any) {
    logger.error(`[file-import] URL import failed`, { fileId, error: error.message });
    await markImportFailed(fileId, error.message || 'Import failed');
    throw error;
  }
}

/**
 * Process Google Drive import job
 */
async function processGoogleDriveImport(job: Job): Promise<void> {
  const { fileId, driveFileId, accessToken, key, userId, contentType, contentLength } = job.data;

  logger.info(`[file-import] Starting Google Drive import`, { fileId, driveFileId });

  try {
    // Update progress
    await updateFileProgress(fileId, 5);

    // Download from Google Drive
    const response = await axios({
      method: 'get',
      url: `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: 'stream',
      timeout: 600000, // 10 minutes
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const stream = response.data as Readable;
    const totalSize = contentLength || parseInt(response.headers['content-length'] || '0', 10);
    const finalContentType = contentType || 'video/mp4';

    // Upload to S3 with progress tracking
    let uploadedBytes = 0;
    const upload = createS3Upload(key, stream, finalContentType);

    upload.on('httpUploadProgress', async (progress) => {
      if (totalSize > 0 && progress.loaded) {
        uploadedBytes = progress.loaded;
        const percent = calculateProgress(progress.loaded, totalSize);
        await updateFileProgress(fileId, percent);
        await job.updateProgress(percent);
      }
    });

    await upload.done();
    logger.info(`[file-import] S3 upload completed`, { fileId });

    // Extract metadata and finalize
    await finalizeImport(fileId, key, userId, totalSize || uploadedBytes);

    logger.info(`[file-import] Google Drive import completed`, { fileId });
  } catch (error: any) {
    logger.error(`[file-import] Google Drive import failed`, { fileId, error: error.message });

    // Map error to user-friendly message
    const errorMessage = mapGoogleDriveError(error);
    await markImportFailed(fileId, errorMessage);
    throw error;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createS3Upload(key: string, stream: Readable, contentType: string): Upload {
  return new Upload({
    client: s3Client,
    params: {
      Bucket: env.s3Bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
  });
}

function calculateProgress(loaded: number, total: number): number {
  // Reserve 5% for start and 5% for metadata extraction
  return Math.min(Math.round((loaded / total) * 90) + 5, 95);
}

async function updateFileProgress(fileId: string, progress: number): Promise<void> {
  try {
    await File.updateOne({ _id: fileId }, { importProgress: progress });
  } catch (error) {
    logger.warn(`[file-import] Failed to update progress`, { fileId, progress });
  }
}

async function markImportFailed(fileId: string, errorMessage: string): Promise<void> {
  try {
    await File.updateOne(
      { _id: fileId },
      {
        status: 'failed',
        importError: errorMessage,
      }
    );
  } catch (error) {
    logger.error(`[file-import] Failed to mark import as failed`, { fileId });
  }
}

async function finalizeImport(
  fileId: string,
  key: string,
  userId: string,
  fileSize: number
): Promise<void> {
  // Extract metadata
  const cdnUrl = `${env.cdnUrl}/${key}`;
  const metadata = await extractMetadata(cdnUrl);

  // Update file record
  await File.updateOne(
    { _id: fileId },
    {
      status: 'ready',
      size: fileSize,
      metadata,
      importProgress: 100,
    }
  );

  // Update quota
  if (fileSize > 0) {
    await quotaService.addStorageUsage(userId, fileSize, fileId);
  }
}

async function extractMetadata(url: string): Promise<{
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${url}"`,
      { timeout: 60000 }
    );

    const probeData = JSON.parse(stdout);
    const videoStream = probeData.streams?.find((s: any) => s.codec_type === 'video');
    const audioStream = probeData.streams?.find((s: any) => s.codec_type === 'audio');

    return {
      duration: parseFloat(
        videoStream?.duration || audioStream?.duration || probeData.format?.duration || '0'
      ),
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      hasAudio: !!audioStream,
    };
  } catch (error) {
    logger.error(`[file-import] Metadata extraction failed`, { url, error });
    return {
      duration: 0,
      width: 0,
      height: 0,
      hasAudio: false,
    };
  }
}

function mapGoogleDriveError(error: any): string {
  if (error.response?.status === 401) {
    return 'Google Drive access token expired. Please try again.';
  }
  if (error.response?.status === 403) {
    return 'Access denied to Google Drive file. Please check permissions.';
  }
  if (error.response?.status === 404) {
    return 'File not found in Google Drive.';
  }
  return error.message || 'Import failed';
}

// ============================================================================
// Worker Setup
// ============================================================================

const worker = new Worker(
  'file-import',
  async (job: Job) => {
    logger.info(`[file-import] Processing job: ${job.name}`, { jobId: job.id });

    switch (job.name) {
      case 'import-from-url':
        await processUrlImport(job);
        break;
      case 'import-from-google-drive':
        await processGoogleDriveImport(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  },
  {
    connection: { ...redisConnectionOptions },
    concurrency: 3,
  }
);

// Event handlers
worker.on('completed', (job) => {
  logger.info(`[file-import] Job completed`, { jobId: job.id, name: job.name });
});

worker.on('failed', (job, error) => {
  logger.error(`[file-import] Job failed`, {
    jobId: job?.id,
    name: job?.name,
    error: error.message,
  });
});

worker.on('error', (error) => {
  logger.error(`[file-import] Worker error`, { error: error.message });
});

// Register worker
registerWorker(worker);

logger.info(`[file-import] Worker ready (concurrency: 3)`);

export default worker;