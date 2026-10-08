import { z } from 'zod';
import { assertPublicUrl } from '../utils/safeRequest';

// Rejects private/local targets up front; delivery re-checks after DNS.
const webhookUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      assertPublicUrl(value);
      return true;
    } catch {
      return false;
    }
  }, 'Webhook URLs must be public http(s) addresses');

export const createWebhookSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    url: webhookUrl,
    events: z.array(z.string()).min(1),
  }),
});

export const updateWebhookSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    url: webhookUrl.optional(),
    events: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});
