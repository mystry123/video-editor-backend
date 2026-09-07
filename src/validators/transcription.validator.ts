import { z } from 'zod';

export const createTranscriptionSchema = z.object({
  body: z.object({
    fileId: z.string(),
    language: z.string().optional(),
  }),
});

export const updateTranscriptionWordsSchema = z.object({
  params: z.object({
    id: z.string(),
  }),
  body: z.object({
    words: z
      .array(
        z.object({
          text: z.string(),
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          type: z.enum(['word', 'spacing', 'punctuation']).optional(),
          speaker_id: z.string().optional(),
        })
      )
      .min(1, 'At least one word is required'),
  }),
});
