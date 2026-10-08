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
    /** Template version the editor saved; a different current version is a 409. */
    version: z.number().int().positive().optional(),
    idempotencyKey: z.string().optional(),
    webhookUrl: z.string().url().optional().nullable(),
    variables: z.record(variableValueSchema).optional(),
  }),
});
