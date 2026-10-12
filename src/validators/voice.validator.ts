import { z } from 'zod';
import { TTS_MAX_CHARACTERS, TTS_SPEED } from '../services/voice.service';

export const createSpeechSchema = z.object({
  body: z.object({
    text: z
      .string()
      .trim()
      .min(1, 'Write something to turn into speech')
      .max(TTS_MAX_CHARACTERS, `Keep it under ${TTS_MAX_CHARACTERS.toLocaleString('en-US')} characters`),
    voiceId: z.string().trim().min(1, 'Pick a voice').max(64).regex(/^[A-Za-z0-9]+$/, 'Pick a voice'),
    speed: z.number().min(TTS_SPEED.min).max(TTS_SPEED.max).optional(),
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
