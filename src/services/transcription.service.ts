import fetch from 'node-fetch';
import FormData from 'form-data';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

export interface TranscriptionResult {
  id: string;
  text: string;
  words: Array<{
    text: string;
    start: number;
    end: number;
    type: 'word' | 'spacing' | 'punctuation';
    speaker_id?: string;
  }>;
  utterances?: Array<{
    speaker_id: string;
    start: number;
    end: number;
    text: string;
  }>;
  audio_duration: number;
  language_code?: string;
}

export async function createElevenLabsTranscription(
  audioUrl: string,
  options: {
    language?: string;
    speakerCount?: number;
  } = {}
): Promise<TranscriptionResult> {
  logger.info('Starting ElevenLabs transcription', { audioUrl, options });

  // Download audio file
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio: ${audioResponse.statusText}`);
  }


  const formData = new FormData();
  formData.append('cloud_storage_url', audioUrl);
  formData.append('model_id', 'scribe_v1');

  if (options.language) {
    formData.append('language_code', options.language);
  }
  if (options.speakerCount) {
    formData.append('num_speakers', options.speakerCount.toString());
  }
  formData.append('timestamps_granularity', 'word');
  formData.append('diarize', 'true');
  formData.append('tag_audio_events', 'true');

  const response = await fetch(`${ELEVENLABS_API_URL}/speech-to-text`, {
    method: 'POST',
    headers: {
      'xi-api-key': env.elevenLabsApiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    logger.error('ElevenLabs API error', error);
    throw new Error(`ElevenLabs error: ${(error as any).detail || 'Unknown error'}`);
  }

  const result = (await response.json()) as TranscriptionResult;
  logger.info('Transcription completed', { id: result.id, duration: result.audio_duration });

  return result;
}
