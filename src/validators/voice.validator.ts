import { z } from 'zod';
/** The longest script per request (providers that take less are sent it in parts) */
export const TTS_MAX_CHARACTERS = 5000;
const LANGUAGE = z.string().trim().regex(/^[a-z]{2,3}-[A-Z]{2}$/, 'Pick a language');

export const createSpeechSchema = z.object({
  body: z.object({
    text: z
      .string()
      .trim()
      .min(1, 'Write something to turn into speech')
      .max(TTS_MAX_CHARACTERS, `Keep it under ${TTS_MAX_CHARACTERS.toLocaleString('en-US')} characters`),
    voiceId: z.string().trim().min(1, 'Pick a voice').max(64).regex(/^[A-Za-z0-9]+$/, 'Pick a voice'),
    // Each provider narrows this to its own range
    speed: z.number().min(0.5).max(2).optional(),
    language: LANGUAGE.optional(),
    voiceName: z.string().trim().max(80).optional(),
  }),
});

export const searchVoicesSchema = z.object({
  query: z.object({
    text: z.string().max(100).optional(),
    language: z.string().regex(/^[a-z]{2,3}$/).optional(),
    gender: z.enum(['male', 'female', 'neutral']).optional(),
    page: z.coerce.number().int().min(0).max(50).optional(),
  }),
});

export const createSampleUploadSchema = z.object({
  body: z.object({
    mimeType: z.string().min(1),
    size: z.number().int().positive(),
  }),
});

export const createOwnVoiceSchema = z.object({
  body: z.object({
    sampleId: z.string().regex(/^[a-f0-9]{24}$/, 'Record your voice sample again'),
    name: z.string().trim().min(1, 'Name your voice').max(40),
    consent: z.literal(true, { errorMap: () => ({ message: 'Confirm this is your own voice' }) }),
  }),
});

export const previewVoiceSchema = z.object({
  body: z.object({
    voiceId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_]+$/, 'Pick a voice'),
    language: LANGUAGE.optional(),
  }),
});

export const cleanUpAudioSchema = z.object({
  body: z.object({
    fileId: z.string().regex(/^[a-f0-9]{24}$/, 'Pick a video or audio clip'),
  }),
});

export const soundEffectSchema = z.object({
  body: z.object({
    prompt: z.string().trim().min(2, 'Describe the sound').max(300, 'Keep the description under 300 characters'),
    // seconds; left out, the model picks a length
    duration: z.number().min(0.5).max(22).optional(),
  }),
});

export const createDubSchema = z.object({
  body: z.object({
    fileId: z.string().regex(/^[a-f0-9]{24}$/, 'Pick a video or audio clip'),
    language: z.string().regex(/^[a-z]{2}$/, 'Pick a language'),
  }),
});

export const getDubSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/, 'Dub not found') }),
});
