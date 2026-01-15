import { z } from 'zod';

export const getUploadUrlSchema = z.object({
  body: z.object({
    filename: z.string().min(1, 'Filename is required'),
    mimeType: z.string().min(1, 'MIME type is required'),
    size: z.number().positive('Size must be positive'),
  }),
});

export const importFromUrlSchema = z.object({
  body: z.object({
    url: z.string().url('Invalid URL format'),
    filename: z.string().optional(),
  }),
});

export const importFromGoogleDriveSchema = z.object({
  body: z.object({
    fileId: z.string().min(1, 'Google Drive file ID is required'),
    accessToken: z.string().min(1, 'Access token is required'),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
  }),
});