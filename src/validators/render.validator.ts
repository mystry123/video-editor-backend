import { z } from 'zod';

export const startRenderSchema = z.object({
  body: z.object({
    templateId: z.string(),
    webhookUrl: z.string().url().optional().nullable(),
  }),
});
