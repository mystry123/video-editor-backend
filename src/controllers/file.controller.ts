import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { getUserQuota } from '../config/quotas';
import { createPresignedUpload, deleteFromS3 } from '../services/storage.service';
import { fileProcessingQueue } from '../queues';
import { quotaService } from '../services/quota.service';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

    const quota = getUserQuota(user.role);
    if (quota.maxStorage !== -1 && user.storageUsed + size > quota.maxStorage) {
      throw ApiError.forbidden('Storage quota exceeded');
    }

    const ext = filename.split('.').pop();
    const key = `users/${user._id}/uploads/${uuidv4()}.${ext}`;

    console.log({key})

    const { url, fields } = await createPresignedUpload({
      key,
      contentType: mimeType,
      maxSize: size,
    });

    console.log("response",{url,fields})


    const file = await File.create({
      userId: user._id,
      name: filename,
      originalName: filename,
      mimeType,
      size,
      storageKey: key,
      cdnUrl: `${env.cdnUrl}/${key}`,
      status: 'processing',
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
        const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_streams "${file.cdnUrl}"`);
        const probeData = JSON.parse(stdout);
        
        const videoStream = probeData.streams.find((stream: any) => stream.codec_type === 'video');
        const audioStream = probeData.streams.find((stream: any) => stream.codec_type === 'audio');
        
        metadata = {
          duration: videoStream?.duration || audioStream?.duration || 0,
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
        };
      } catch (error) {
        console.error('FFprobe failed', { fileId: file._id, error });
        metadata = {
          duration: 0,
          width: 0,
          height: 0,
        };
      }
    } else if (file.mimeType.startsWith('image/')) {
      metadata = {
        width: 1920, // TODO: Get actual dimensions using image processing
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

    console.log("files",files)

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

    // Set thumbnail extension to jpeg (always an image)
    const ext = 'jpeg';
    const thumbnailKey = file.storageKey.replace(/\.[^/.]+$/, `_thumb.${ext}`);

    // Upload the thumbnail file directly to S3
    // Note: The frontend sends the file in req.file or as multipart data
    // For now, we'll create a presigned URL for the frontend to upload directly
    const mimeType = 'image/jpeg';
    const size = 1024 * 1024; // 1MB default for thumbnails

    const { url, fields } = await createPresignedUpload({
      key: thumbnailKey,
      contentType: mimeType,
      maxSize: size,
    });

    // Update file with thumbnail info
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

    // Delete from S3
    await deleteFromS3(file.storageKey);

    // Update quota usage for storage removal
    await quotaService.removeStorageUsage(userId, file.size, file._id.toString());

    // Soft delete
    await File.updateOne({ _id: id }, { status: 'deleted' });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
