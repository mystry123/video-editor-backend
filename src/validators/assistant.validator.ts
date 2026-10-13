import { z } from 'zod';
import { IMAGE_ASPECTS } from '../services/ai/imageGen';

const list = (max: number) => z.array(z.string().min(1).max(60)).max(max).optional();

export const chatSchema = z.object({
  body: z.object({
    mode: z.enum(['ask', 'edit', 'auto']).optional(),
    messages: z
      .array(z.object({ role: z.enum(['user', 'model']), text: z.string().min(1).max(8000) }))
      .min(1)
      .max(30)
      .refine((m) => m[m.length - 1].role === 'user', 'The last message must be from the user'),
    // The project summary (kept small by the editor)
    context: z.string().max(60_000),
    planStep: z.boolean().optional(),
    capabilities: z
      .object({
        animations: z.object({ in: list(200), out: list(200), loop: list(200) }).optional(),
        transitions: list(100),
        fonts: list(300),
        dubLanguages: list(50),
      })
      .optional(),
  }),
});

export const addMemorySchema = z.object({ body: z.object({ note: z.string().trim().min(3).max(300) }) });
export const deleteMemorySchema = z.object({ params: z.object({ id: z.string().uuid() }) });

export const generateImageSchema = z.object({
  body: z.object({ prompt: z.string().trim().min(3).max(1000), aspect: z.enum(IMAGE_ASPECTS).optional() }),
});
