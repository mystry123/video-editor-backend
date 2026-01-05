import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { File } from '../models/File';
import { User } from '../models/User';
import { getUserQuota } from '../config/quotas';
import { createPresignedUpload, deleteFromS3 } from '../services/storage.service';
import { fileProcessingQueue } from '../queues';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

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

    // Add to processing queue
    await fileProcessingQueue.add('process', { fileId: file._id.toString() });

    // Update user storage
    await User.updateOne({ _id: user._id }, { $inc: { storageUsed: file.size } });

    res.json({ success: true });
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

    console.log("type",type)

    if (type) {
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
    const { filename, mimeType, size } = req.body;

    const file = await File.findOne({ _id: id, userId });
    if (!file) throw ApiError.notFound('File not found');

    // Generate thumbnail key based on parent file
    const ext = filename.split('.').pop();
    const thumbnailKey = file.storageKey.replace(/\.[^/.]+$/, `_thumb.${ext}`);

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

    // Update user storage
    await User.updateOne({ _id: user._id }, { $inc: { storageUsed: -file.size } });

    // Soft delete
    await File.updateOne({ _id: id }, { status: 'deleted' });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
