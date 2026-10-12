// services/tts/sarvam.ts
//
// Sarvam (Bulbul): Indian voices for 10 Indian languages and Indian English,
// good with code-mixed text like Hinglish. A language is chosen per request.
// No hosted previews (we make and keep one per voice and language) and no
// self-serve own voices. Requests take up to 2,500 characters, so longer
// scripts are spoken in parts and joined; the result is stored as MP3.
// Needs SARVAM_API_KEY (an API subscription key from dashboard.sarvam.ai).

import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { wavToMp3 } from '../../utils/audioEncode';
import { joinWavs } from '../../utils/wav';
import { voiceUnavailable } from './errors';
import type { SpeakRequest, SpeechAudio, TtsLanguage, TtsProvider, TtsVoice } from './types';

const API = 'https://api.sarvam.ai/text-to-speech';
const MODEL = 'bulbul:v3';
const MAX_PER_REQUEST = 2400; // the API allows 2,500; a margin for multi-byte counting
const SAMPLE_RATE = 44100;
const SPEED = { min: 0.5, max: 2 } as const;

export const SARVAM_LANGUAGES: TtsLanguage[] = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'bn-IN', label: 'Bengali' },
  { code: 'ta-IN', label: 'Tamil' },
  { code: 'te-IN', label: 'Telugu' },
  { code: 'mr-IN', label: 'Marathi' },
  { code: 'gu-IN', label: 'Gujarati' },
  { code: 'kn-IN', label: 'Kannada' },
  { code: 'ml-IN', label: 'Malayalam' },
  { code: 'pa-IN', label: 'Punjabi' },
  { code: 'od-IN', label: 'Odia' },
];

/** bulbul:v3 speakers; Shubh is Sarvam's default */
const SPEAKERS = [
  'shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya', 'amit', 'dev', 'ishita',
  'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir', 'aayan', 'ashutosh', 'advait', 'anand', 'tanya',
  'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'shruti', 'suhani', 'mohit', 'kavitha', 'rehan', 'soham', 'rupali',
];

// Sarvam doesn't publish genders or styles for these; names only
const VOICES: TtsVoice[] = SPEAKERS.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));

// "Hi, I'm {name}. This is how your videos will sound with my voice."
const PREVIEW_LINES: Record<string, string> = {
  'en-IN': "Hi, I'm {name}. This is how your videos will sound with my voice.",
  'hi-IN': 'नमस्ते, मैं {name} हूँ। आपके वीडियो में मेरी आवाज़ ऐसी सुनाई देगी।',
  'bn-IN': 'নমস্কার, আমি {name}। আপনার ভিডিওতে আমার কণ্ঠ এমন শোনাবে।',
  'ta-IN': 'வணக்கம், நான் {name}. உங்கள் வீடியோக்களில் என் குரல் இப்படித்தான் ஒலிக்கும்.',
  'te-IN': 'నమస్కారం, నేను {name}. మీ వీడియోలలో నా గొంతు ఇలా వినిపిస్తుంది.',
  'mr-IN': 'नमस्कार, मी {name}. तुमच्या व्हिडिओमध्ये माझा आवाज असा ऐकू येईल.',
  'gu-IN': 'નમસ્તે, હું {name} છું. તમારા વીડિયોમાં મારો અવાજ આવો સંભળાશે.',
  'kn-IN': 'ನಮಸ್ಕಾರ, ನಾನು {name}. ನಿಮ್ಮ ವೀಡಿಯೊಗಳಲ್ಲಿ ನನ್ನ ಧ್ವನಿ ಹೀಗೆ ಕೇಳಿಸುತ್ತದೆ.',
  'ml-IN': 'നമസ്കാരം, ഞാൻ {name}. നിങ്ങളുടെ വീഡിയോകളിൽ എന്റെ ശബ്ദം ഇങ്ങനെയായിരിക്കും.',
  'pa-IN': 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ {name} ਹਾਂ। ਤੁਹਾਡੀਆਂ ਵੀਡੀਓਜ਼ ਵਿੱਚ ਮੇਰੀ ਆਵਾਜ਼ ਇਸ ਤਰ੍ਹਾਂ ਸੁਣਾਈ ਦੇਵੇਗੀ।',
  'od-IN': 'ନମସ୍କାର, ମୁଁ {name}। ଆପଣଙ୍କ ଭିଡିଓରେ ମୋ ସ୍ୱର ଏମିତି ଶୁଣାଯିବ।',
};

/**
 * Parts of at most `max` characters, split at sentence ends where possible,
 * then at spaces, and only mid-word for a word longer than `max`.
 */
export function splitScript(text: string, max = MAX_PER_REQUEST): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    // the last sentence end (. ! ? । ॥ or a line break) in the window
    let cut = -1;
    for (const m of window.matchAll(/[.!?।॥\n](?=\s|$)/g)) if (m.index! > 0) cut = m.index! + 1;
    if (cut < max * 0.5) {
      const space = window.lastIndexOf(' ');
      cut = space > 0 ? space : max;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

async function request(body: Record<string, unknown>): Promise<Buffer> {
  if (!env.sarvamApiKey) throw voiceUnavailable();
  let response: Response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': env.sarvamApiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    logger.error('Sarvam text to speech unreachable', { error: (error as Error).message });
    throw voiceUnavailable();
  }
  if (!response.ok) {
    let detail: any = null;
    try {
      detail = ((await response.json()) as any)?.error;
    } catch {
      // not JSON
    }
    logger.error('Sarvam text to speech failed', { httpStatus: response.status, code: detail?.code, message: detail?.message, requestId: detail?.request_id });
    // 400/422 on input we validated means the script itself was refused
    if (response.status === 400 || response.status === 422) {
      throw ApiError.withCode(422, 'SPEECH_REJECTED', "That script couldn't be spoken. Check for unusual characters and try again.");
    }
    throw voiceUnavailable(); // key, credits (429 is "quota exceeded"), outages
  }
  const json = (await response.json()) as { audios?: string[] };
  const audio = json.audios?.[0];
  if (!audio) throw voiceUnavailable();
  return Buffer.from(audio, 'base64');
}

async function speakParts(speaker: string, language: string, parts: string[], speed: number): Promise<SpeechAudio> {
  if (!SPEAKERS.includes(speaker)) throw ApiError.withCode(404, 'VOICE_NOT_FOUND', "That voice isn't available. Pick another one.");
  if (!SARVAM_LANGUAGES.some((l) => l.code === language)) throw ApiError.withCode(400, 'LANGUAGE_NOT_SUPPORTED', 'Pick a language for this voice.');
  const wavs: Buffer[] = [];
  for (const text of parts) {
    wavs.push(
      await request({
        text,
        language_code: language,
        speaker,
        model: MODEL,
        pace: Math.min(SPEED.max, Math.max(SPEED.min, speed)),
        speech_sample_rate: SAMPLE_RATE,
        output_audio_codec: 'wav',
      })
    );
  }
  const wav = wavs.length === 1 ? wavs[0] : joinWavs(wavs);
  try {
    return { audio: await wavToMp3(wav), mimeType: 'audio/mpeg', ext: 'mp3' };
  } catch (error) {
    // Still usable, just bigger
    logger.warn('MP3 encoding failed; keeping WAV', { error: (error as Error).message });
    return { audio: wav, mimeType: 'audio/wav', ext: 'wav' };
  }
}

export const sarvamProvider: TtsProvider = {
  id: 'sarvam',
  languages: SARVAM_LANGUAGES,
  speedRange: SPEED,
  listVoices: async () => VOICES,
  speak: ({ voiceId, text, speed, language }: SpeakRequest) => speakParts(voiceId, language || 'en-IN', splitScript(text), speed),
  previewSpeech: (voiceId, language) => {
    const name = VOICES.find((v) => v.id === voiceId)?.name ?? voiceId;
    return speakParts(voiceId, language, [(PREVIEW_LINES[language] ?? PREVIEW_LINES['en-IN']).replace('{name}', name)], 1);
  },
};
