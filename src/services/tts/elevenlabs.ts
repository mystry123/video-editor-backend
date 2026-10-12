// services/tts/elevenlabs.ts
//
// ElevenLabs: stock voices in many accents (one multilingual model that works
// out the language from the text), and users' own voices made from a sample
// they recorded (instant voice cloning, paid ElevenLabs plans). The API key
// needs Text to Speech and Voices (write) permissions; without them every
// call here fails with VOICE_UNAVAILABLE.

import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { voiceUnavailable } from './errors';
import type { OwnVoiceSample, SpeakRequest, SpeechAudio, TtsProvider, TtsVoice } from './types';

const API = 'https://api.elevenlabs.io';
/** Best quality and 29 languages; billed 1 credit per character. */
export const TTS_MODEL = 'eleven_multilingual_v2';
const SPEED = { min: 0.7, max: 1.2 } as const;

const unavailable = voiceUnavailable;

/** An ElevenLabs error as ours: our own setup or credits problems never reach the user as-is. */
async function failure(response: Response, what: string): Promise<ApiError> {
  let detail: any = null;
  try {
    detail = ((await response.json()) as any)?.detail;
  } catch {
    // not JSON
  }
  const status = typeof detail === 'object' ? detail?.status : undefined;
  const message = typeof detail === 'object' ? detail?.message : detail;
  logger.error(`ElevenLabs ${what} failed`, { httpStatus: response.status, status, message });
  if (status === 'voice_not_found' || response.status === 404) {
    return ApiError.withCode(404, 'VOICE_NOT_FOUND', "That voice isn't available any more. Pick another one.");
  }
  if (what === 'voice clone' && response.status === 400 && status !== 'quota_exceeded' && status !== 'voice_limit_reached') {
    return ApiError.withCode(422, 'VOICE_SAMPLE_REJECTED', message || "We couldn't make a voice from that recording. Record it again somewhere quiet.");
  }
  // Missing permissions, out of credits, voice slots full, rate limits, outages
  return unavailable();
}

async function call(path: string, init: RequestInit, what: string): Promise<Response> {
  if (!env.elevenLabsApiKey) throw unavailable();
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { 'xi-api-key': env.elevenLabsApiKey, ...(init.headers || {}) },
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    logger.error(`ElevenLabs ${what} unreachable`, { error: (error as Error).message });
    throw unavailable();
  }
  if (!response.ok) throw await failure(response, what);
  return response;
}

// Stock voices change rarely: one fetch per 6 hours
const VOICES_TTL = 6 * 60 * 60 * 1000;
let voicesCache: { at: number; voices: TtsVoice[] } | null = null;

export function clearVoicesCache(): void {
  voicesCache = null;
}

/** ElevenLabs' stock voices, best known first. */
async function listStockVoices(): Promise<TtsVoice[]> {
  if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL) return voicesCache.voices;
  const response = await call('/v2/voices?voice_type=default&page_size=100', { method: 'GET' }, 'voice list');
  const body = (await response.json()) as { voices?: any[] };
  const voices: TtsVoice[] = (body.voices || [])
    .filter((v) => v?.voice_id && v?.name)
    .map((v) => ({
      id: String(v.voice_id),
      // "Rachel - Calm narrator" style names: the first part is the name
      name: String(v.name).split(' - ')[0].trim(),
      gender: v.labels?.gender,
      accent: v.labels?.accent,
      age: v.labels?.age,
      description: v.labels?.description || v.description || undefined,
      useCase: v.labels?.use_case || v.labels?.['use case'],
      previewUrl: v.preview_url || undefined,
    }));
  voicesCache = { at: Date.now(), voices };
  return voices;
}

/** Speech for `text` as an MP3. */
async function textToSpeech({ voiceId, text, speed, ownVoice = false }: SpeakRequest): Promise<SpeechAudio> {
  const response = await call(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: TTS_MODEL,
        voice_settings: {
          stability: 0.5,
          // An own voice should sound as much like them as possible
          similarity_boost: ownVoice ? 0.9 : 0.75,
          use_speaker_boost: true,
          speed: Math.min(SPEED.max, Math.max(SPEED.min, speed)),
        },
      }),
    },
    'text to speech'
  );
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw unavailable();
  return { audio, mimeType: 'audio/mpeg', ext: 'mp3' };
}

/** Makes a voice from a recording; returns its ElevenLabs id. */
async function cloneVoice(userId: string, sample: OwnVoiceSample): Promise<string> {
  const form = new FormData();
  // Our own label; the user's name for the voice stays in our database
  form.append('name', `shotline-${userId}`);
  form.append('description', 'A Shotline user\'s own voice');
  form.append('labels', JSON.stringify({ app: 'shotline', user: userId }));
  form.append('remove_background_noise', 'true');
  form.append('files', new Blob([new Uint8Array(sample.bytes)], { type: sample.mimeType }), sample.filename);
  const response = await call('/v1/voices/add', { method: 'POST', body: form }, 'voice clone');
  const body = (await response.json()) as { voice_id?: string };
  if (!body.voice_id) throw unavailable();
  return body.voice_id;
}

/** Deletes a voice made by cloneVoice; already gone counts as done. */
async function deleteVoice(voiceId: string): Promise<void> {
  try {
    await call(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' }, 'voice delete');
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) return;
    throw error;
  }
}

export const elevenLabsProvider: TtsProvider = {
  id: 'elevenlabs',
  languages: null, // the multilingual model reads the language from the text
  speedRange: SPEED,
  listVoices: listStockVoices,
  speak: textToSpeech,
  ownVoices: { create: cloneVoice, remove: deleteVoice },
};
