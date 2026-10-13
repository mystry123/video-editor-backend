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
export const signUploadPartsSchema = z.object({
  body: z.object({
    partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
  }),
});

export const importGiphySchema = z.object({
  body: z.object({
    url: z.string().url().max(500),
    title: z.string().max(200).optional(),
    width: z.number().int().min(0).max(10000).optional(),
    height: z.number().int().min(0).max(10000).optional(),
  }),
});

export const importStockSchema = z.object({
  body: z.object({ kind: z.enum(['photo', 'video']), id: z.union([z.string().regex(/^\d{1,12}$/), z.number().int().positive()]).transform(String) }),
});
