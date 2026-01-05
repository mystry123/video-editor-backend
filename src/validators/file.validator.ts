import { z } from 'zod';

export const getUploadUrlSchema = z.object({
  body: z.object({
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().positive(),
  }),
});
