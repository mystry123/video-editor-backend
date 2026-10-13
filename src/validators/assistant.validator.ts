import { z } from 'zod';
import { IMAGE_ASPECTS } from '../services/ai/imageGen';
import { preferencesSchema } from '../services/ai/preferences';

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
        lottie: list(100),
      })
      .optional(),
  }),
});

export const addMemorySchema = z.object({ body: z.object({ note: z.string().trim().min(3).max(300) }) });
export const deleteMemorySchema = z.object({ params: z.object({ id: z.string().uuid() }) });

export const generateImageSchema = z.object({
  body: z.object({ prompt: z.string().trim().min(3).max(1000), aspect: z.enum(IMAGE_ASPECTS).optional() }),
});

export const updatePreferencesSchema = z.object({
  body: z.object({
    // Empty strings clear a field
    preferences: z.preprocess(
      (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== null)) : v),
      preferencesSchema
    ),
  }),
});

const sessionMessages = z
  .array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(8000), note: z.string().max(2000).optional(), at: z.string().datetime().optional() }))
  .max(200);
const objectId = z.string().regex(/^[0-9a-f]{24}$/);

export const listSessionsSchema = z.object({ query: z.object({ projectId: z.string().min(1).max(64) }) });
export const createSessionSchema = z.object({
  body: z.object({ projectId: z.string().min(1).max(64), title: z.string().max(80).optional(), messages: sessionMessages.optional() }),
});
export const sessionIdSchema = z.object({ params: z.object({ id: objectId }) });
export const updateSessionSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ title: z.string().max(80).optional(), messages: sessionMessages.optional() }),
});

export const startDirectorSchema = z.object({
  body: z.object({
    projectId: z.string().min(1).max(100),
    request: z.string().trim().min(3).max(4000),
    messages: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(8000) })).max(30).optional(),
    context: z.string().max(60_000),
    project: z.object({
      project: z.record(z.string(), z.any()),
      elements: z.array(z.record(z.string(), z.any())).max(2000),
    }),
  }),
});

export const directorRunSchema = z.object({ params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }) });
