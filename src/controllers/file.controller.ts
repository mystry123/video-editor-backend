import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { assertPublicUrl, BlockedUrlError, safeRequest } from '../utils/safeRequest';
import { probeMedia, storageExtension, summarizeProbe } from '../utils/media';
import axios from 'axios';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { createPresignedUpload, deleteFromS3 } from '../services/storage.service';
import { quotaService } from '../services/quota.service';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getFileImportQueue } from '../queues';


// ============================================
// EXISTING METHODS
// ============================================

export const getUploadUrl = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { filename, mimeType, size } = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const quota = getEffectiveQuota(user);
    if (quota.maxStorage !== -1 && user.storageUsed + size > quota.maxStorage) {
      throw ApiError.forbidden('Storage quota exceeded');
    }

    // The extension comes from an allowlist, never from the client's filename:
    // it ends up in the storage key and CDN URL.
    const ext = storageExtension(mimeType, filename);
    if (!ext) {
      throw ApiError.withCode(400, 'UNSUPPORTED_FILE_TYPE', `Files of type "${mimeType}" can't be uploaded.`);
    }
    const key = `users/${user._id}/uploads/${uuidv4()}.${ext}`;

    const { url, fields } = await createPresignedUpload({
      key,
      contentType: mimeType,
      maxSize: size,
    });

    const file = await File.create({
      userId: user._id,
      name: filename,
      originalName: filename,
      mimeType,
      size,
      storageKey: key,
      cdnUrl: `${env.cdnUrl}/${key}`,
      status: 'processing',
      source: 'upload',
    });

    res.json({
      uploadUrl: url,
      fields,
      fileId: file._id,
      cdnUrl: file.cdnUrl,
    });
  } catch (error) {
    next(error);
  }
};

export const completeUpload = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file = await File.findOne({ _id: id, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    // Extract metadata using ffprobe
    let metadata: any = {};
    
    if (file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/')) {
      try {
        if (!file.cdnUrl) {
          throw new Error('CDN URL not found for file');
        }
        const { duration, width, height, hasAudio } = summarizeProbe(await probeMedia(file.cdnUrl));
        metadata = { duration, width, height, hasAudio };
      } catch (error) {
        // Keep the upload usable, but record that its details are unknown so
        // features that need duration (captions, quota) can say why.
        logger.error('FFprobe failed', { fileId: file._id, error: (error as Error).message });
        metadata = {
          duration: 0,
          width: 0,
          height: 0,
          hasAudio: false,
          metadataError: "We couldn't read this file's video details.",
        };
      }
    } else if (file.mimeType.startsWith('image/')) {
      metadata = {
        width: 1920,
        height: 1080,
      };
    }

    // Update file with metadata and status
    await File.updateOne(
      { _id: id },
      {
        status: 'ready',
        metadata,
      }
    );

    // Update quota usage for storage
    await quotaService.addStorageUsage(userId, file.size, file._id.toString());

    res.json({ success: true, metadata });
  } catch (error) {
    next(error);
  }
};

export const listFiles = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { type, page = '1', limit = '50' } = req.query;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const query: any = {
      userId: user._id,
      status: 'ready',
    };

    if (type && String(type).toLowerCase() !== "all") {
      query.mimeType = { $regex: `^${String(type).toLowerCase()}/` };
    }

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const [files, total] = await Promise.all([
      File.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      File.countDocuments(query),
    ]);

    res.json({
      data: files,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getFile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file = await File.findOne({ _id: id, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    res.json(file);
  } catch (error) {
    next(error);
  }
};

export const uploadThumbnail = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const file = await File.findOne({ _id: id, userId });
    if (!file) throw ApiError.notFound('File not found');

    const ext = 'jpeg';
    const thumbnailKey = file.storageKey.replace(/\.[^/.]+$/, `_thumb.${ext}`);

    const mimeType = 'image/jpeg';
    const size = 1024 * 1024;

    const { url, fields } = await createPresignedUpload({
      key: thumbnailKey,
      contentType: mimeType,
      maxSize: size,
    });

    await File.updateOne(
      { _id: id },
      {
        thumbnailKey,
        thumbnailUrl: `${env.cdnUrl}/${thumbnailKey}`,
      }
    );

    res.json({
      uploadUrl: url,
      fields,
      thumbnailUrl: `${env.cdnUrl}/${thumbnailKey}`,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteFile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const file = await File.findOne({ _id: id, userId: user._id });
    if (!file) throw ApiError.notFound('File not found');

    await deleteFromS3(file.storageKey);
    await quotaService.removeStorageUsage(userId, file.size, file._id.toString());
    await File.updateOne({ _id: id }, { status: 'deleted' });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ============================================
// NEW IMPORT METHODS
// ============================================

/**
 * Import file from direct URL
 */
export const importFromUrl = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { url, filename } = req.body;

    if (!url) {
      throw ApiError.badRequest('URL is required');
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    // Validate URL format
    try {
      assertPublicUrl(url);
    } catch (error) {
      throw ApiError.withCode(400, 'URL_NOT_ALLOWED', (error as Error).message === 'That address is not allowed'
        ? "That link points to a private or local address, which can't be imported."
        : (error as Error).message);
    }

    // Get file info from URL using HEAD request
    let contentType: string;
    let contentLength: number;
    let finalFilename = '';

    try {
      const headResponse = await safeRequest(url, {
        method: 'HEAD',
        timeout: 15000,
        maxRedirects: 3,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ShotlineBot/1.0)',
        },
      });

      contentType = headResponse.headers['content-type'] || 'video/mp4';
      contentLength = parseInt(headResponse.headers['content-length'] || '0', 10);

      // Extract filename from Content-Disposition header or URL
      const contentDisposition = headResponse.headers['content-disposition'];
      if (contentDisposition) {
        const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        finalFilename = match ? match[1].replace(/['"]/g, '') : '';
      }

      if (!finalFilename) {
        finalFilename = filename || extractFilenameFromUrl(url) || `imported-${Date.now()}.mp4`;
      }
    } catch (error: any) {
      if (error instanceof BlockedUrlError) {
        throw ApiError.withCode(400, 'URL_NOT_ALLOWED', "That link redirects to a private or local address, which can't be imported.");
      }
      logger.warn('Failed to fetch URL metadata', { error: error.message });
      throw ApiError.badRequest('Could not access URL. Please check if the URL is valid and publicly accessible.');
    }

    // Validate content type
    if (!contentType.startsWith('video/') && !contentType.startsWith('audio/')) {
      throw ApiError.badRequest('URL must point to a video or audio file');
    }

    // Check quota
    const quota = getEffectiveQuota(user);
    if (quota.maxStorage !== -1 && contentLength > 0 && user.storageUsed + contentLength > quota.maxStorage) {
      throw ApiError.forbidden('Storage quota exceeded');
    }

    // Generate storage key
    // Allowlisted extension; an unknown video/audio subtype keeps the old
    // fixed fallback (a constant, so it's still safe in the key).
    const ext = storageExtension(contentType, finalFilename) || (contentType.startsWith('audio/') ? 'm4a' : 'mp4');
    const key = `users/${user._id}/uploads/${uuidv4()}.${ext}`;

    // Create file record with processing status
    const file = await File.create({
      userId: user._id,
      name: finalFilename,
      originalName: finalFilename,
      mimeType: contentType,
      size: contentLength || 0,
      storageKey: key,
      cdnUrl: `${env.cdnUrl}/${key}`,
      status: 'processing',
      source: 'url',
      sourceUrl: url,
      importProgress: 0,
    });

    // Add to processing queue for background download
    const queue = await getFileImportQueue();
    await queue.add(
      'import-from-url',
      {
        fileId: file._id.toString(),
        url,
        key,
        userId: userId.toString(),
        contentType,
        contentLength,
      },
      {
        jobId: `url-import-${file._id}`,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      }
    );

    logger.info('URL import job queued', { fileId: file._id, url });

    res.status(202).json({
      success: true,
      fileId: file._id,
      status: 'processing',
      message: 'File import started. Processing in background.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Import file from Google Drive
 */
export const importFromGoogleDrive = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { fileId: driveFileId, accessToken, fileName, mimeType, size } = req.body;

    if (!driveFileId || !accessToken) {
      throw ApiError.badRequest('Google Drive file ID and access token are required');
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    // Validate the file exists and get metadata from Google Drive
    let driveFileInfo: any;
    try {
      const response = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?fields=id,name,mimeType,size`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        }
      );
      driveFileInfo = response.data;
    } catch (error: any) {
      logger.error('Failed to fetch Google Drive file info', { driveFileId, error: error.message });
      if (error.response?.status === 401) {
        throw ApiError.withCode(400, 'GDRIVE_TOKEN_EXPIRED', 'Your Google Drive connection expired. Pick the file again to reconnect.');
      }
      if (error.response?.status === 404) {
        throw ApiError.notFound('File not found in Google Drive');
      }
      throw ApiError.badRequest('Could not access Google Drive file');
    }

    const finalFileName = fileName || driveFileInfo.name;
    const finalMimeType = mimeType || driveFileInfo.mimeType;
    const finalSize = size || parseInt(driveFileInfo.size || '0', 10);

    // Validate content type
    if (!finalMimeType.startsWith('video/') && !finalMimeType.startsWith('audio/')) {
      throw ApiError.badRequest('File must be a video or audio file');
    }

    // Check quota
    const quota = getEffectiveQuota(user);
    if (quota.maxStorage !== -1 && finalSize > 0 && user.storageUsed + finalSize > quota.maxStorage) {
      throw ApiError.forbidden('Storage quota exceeded');
    }

    // Generate storage key
    const ext = storageExtension(finalMimeType, finalFileName);
    if (!ext) {
      throw ApiError.withCode(400, 'UNSUPPORTED_FILE_TYPE', `Files of type "${finalMimeType}" can't be imported.`);
    }
    const key = `users/${user._id}/uploads/${uuidv4()}.${ext}`;

    // Create file record
    const file = await File.create({
      userId: user._id,
      name: finalFileName,
      originalName: finalFileName,
      mimeType: finalMimeType,
      size: finalSize,
      storageKey: key,
      cdnUrl: `${env.cdnUrl}/${key}`,
      status: 'processing',
      source: 'google_drive',
      sourceId: driveFileId,
      importProgress: 0,
    });

    // Add to processing queue for background download
    const queue = await getFileImportQueue();
    await queue.add(
      'import-from-google-drive',
      {
        fileId: file._id.toString(),
        driveFileId,
        accessToken,
        key,
        userId: userId.toString(),
        contentType: finalMimeType,
        contentLength: finalSize,
      },
      {
        jobId: `gdrive-import-${file._id}`,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      }
    );

    logger.info('Google Drive import job queued', { fileId: file._id, driveFileId });

    res.status(202).json({
      success: true,
      fileId: file._id,
      status: 'processing',
      message: 'Google Drive import started. Processing in background.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get import status for a file
 */
export const getImportStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const file = await File.findOne({ _id: id, userId });
    if (!file) throw ApiError.notFound('File not found');

    const response: any = {
      fileId: file._id,
      status: file.status,
      progress: file.importProgress || 0,
    };

    if (file.importError) {
      response.error = file.importError;
    }

    // Include file details if ready
    if (file.status === 'ready') {
      response.file = {
        _id: file._id,
        name: file.name,
        cdnUrl: file.cdnUrl,
        thumbnailUrl: file.thumbnailUrl,
        mimeType: file.mimeType,
        size: file.size,
        metadata: file.metadata,
      };
    }

    res.json(response);
  } catch (error) {
    next(error);
  }
};

// ============================================
// HELPER FUNCTIONS
// ============================================


function extractFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop();
    // Remove query parameters if any
    return filename?.split('?')[0] || '';
  } catch {
    return '';
  }
}
