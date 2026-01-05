import { z } from 'zod';

export const createTranscriptionSchema = z.object({
  body: z.object({
    fileId: z.string(),
    language: z.string().optional(),
  }),
});
