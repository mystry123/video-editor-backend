import { z } from 'zod';

const variableValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.any()),
]);

export const startRenderSchema = z.object({
  body: z.object({
    templateId: z.string(),
    webhookUrl: z.string().url().optional().nullable(),
    variables: z.record(variableValueSchema).optional(),
  }),
});
