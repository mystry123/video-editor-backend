import { z } from 'zod';

export const createWebhookSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    url: z.string().url(),
    events: z.array(z.string()).min(1),
  }),
});

export const updateWebhookSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    url: z.string().url().optional(),
    events: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});
