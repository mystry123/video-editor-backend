import { Job, Worker } from 'bullmq';
import { probeMedia, summarizeProbe } from '../utils/media';
import { limitStream, safeRequest } from '../utils/safeRequest';
import { isFinalAttempt } from '../utils/jobs';
import { getObjectSize } from '../services/storage.service';

// Largest file a URL import may download (bytes). Overridable for bigger plans later.
const MAX_IMPORT_BYTES = Number(process.env.MAX_IMPORT_BYTES) || 5 * 1024 * 1024 * 1024;
import axios from 'axios';
import { Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { File } from '../models/File';
import { quotaService } from '../services/quota.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { redisConnectionOptions } from '../config/redis';
import { registerWorker } from '../queues';


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
    // safeRequest refuses internal addresses on this request and on every redirect.
    const response = await safeRequest(url, {
      method: 'get',
      responseType: 'stream',
      timeout: 600000, // 10 minutes
      maxRedirects: 3,
      maxResponseBytes: Infinity,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShotlineBot/1.0)',
      },
    });

    // The size from the HEAD request is only a claim; cap the bytes actually streamed.
    const maxBytes = Math.min(MAX_IMPORT_BYTES, Number(job.data.maxBytes) || MAX_IMPORT_BYTES);
    const stream = limitStream(response.data as Readable, maxBytes);
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
    logger.error(`[file-import] URL import failed`, { fileId, attempt: job.attemptsMade + 1, error: error.message });
    // Earlier attempts keep the file "processing" so the UI keeps waiting for the retry.
    if (isFinalAttempt(job)) {
      await markImportFailed(fileId, error.message?.includes('limit') ? error.message : "We couldn't download that file. Check the link and try again.");
    }
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
    if (isFinalAttempt(job)) await markImportFailed(fileId, mapGoogleDriveError(error));
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
      { _id: fileId, status: 'processing' },
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

  // Charge the bytes that actually landed in S3 (the HEAD size or a
  // client-supplied Drive size is only a claim), once, on processing → ready.
  const actualSize = (await getObjectSize(key).catch(() => null)) ?? fileSize;
  const finished = await File.findOneAndUpdate(
    { _id: fileId, status: 'processing' },
    { status: 'ready', size: actualSize, metadata, importProgress: 100 },
    { new: true }
  );

  if (finished && actualSize > 0) {
    await quotaService.addStorageUsage(userId, actualSize, fileId);
  }
}

async function extractMetadata(url: string): Promise<{
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}> {
  try {
    const { duration, width, height, hasAudio } = summarizeProbe(await probeMedia(url, { timeoutMs: 60_000 }));
    return { duration, width, height, hasAudio };
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
  // Crashed or stalled for good (the processor's own catch didn't run): don't
  // leave the file "processing" forever.
  if (job && job.attemptsMade >= (job.opts?.attempts ?? 1) && job.data?.fileId) {
    markImportFailed(job.data.fileId, 'The import stopped unexpectedly. Try again.').catch(() => undefined);
  }
});

worker.on('error', (error) => {
  logger.error(`[file-import] Worker error`, { error: error.message });
});

// Register worker
registerWorker(worker);

logger.info(`[file-import] Worker ready (concurrency: 3)`);

export default worker;