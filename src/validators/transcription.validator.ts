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
          text: z.string().max(200),
          start: z.number().finite().nonnegative(),
          end: z.number().finite().nonnegative(),
          type: z.enum(['word', 'spacing', 'punctuation']).optional(),
          speaker_id: z.string().optional(),
        })
      )
      .min(1, 'At least one word is required')
      // About 8 hours of speech; protects the document size limit.
      .max(100_000, 'The transcript is too long'),
  }),
});
