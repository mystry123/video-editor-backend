// services/tts/types.ts
//
// A text-to-speech provider. Which one Shotline uses is a setting
// (TTS_PROVIDER); everything else talks to this interface. Providers differ
// in what they can do, and say so here, so the API and the editor adapt:
// a language list (or null if the provider works the language out itself),
// a speed range, hosted or generated previews, and whether users can make
// their own voice.

import type { TimedWord } from './alignment';

export type TtsProviderId = 'elevenlabs' | 'sarvam';
export type { TimedWord };

export interface TtsVoice {
  id: string;
  name: string;
  gender?: string;
  accent?: string;
  age?: string;
  description?: string;
  useCase?: string;
  /** A hosted sample; without one, previews come from previewSpeech */
  previewUrl?: string;
}

export interface VoiceSearch {
  text?: string;
  /** ISO 639-1, e.g. "hi" */
  language?: string;
  gender?: 'male' | 'female' | 'neutral';
  /** 0-based */
  page?: number;
}

export interface TtsLanguage {
  /** BCP-47, e.g. "hi-IN" */
  code: string;
  label: string;
}

export interface SpeechAudio {
  audio: Buffer;
  mimeType: 'audio/mpeg' | 'audio/wav';
  ext: 'mp3' | 'wav';
  /** When the provider says when each word is spoken: captions without transcribing */
  words?: TimedWord[];
}

export interface SpeakRequest {
  voiceId: string;
  text: string;
  /** Already within the provider's speedRange */
  speed: number;
  /** One of the provider's languages (required when it has a list) */
  language?: string;
  /** The user's own voice (made with this provider) */
  ownVoice?: boolean;
}

export interface OwnVoiceSample {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

export interface TtsProvider {
  readonly id: TtsProviderId;
  /** Languages to choose from, or null when the provider detects the language from the text */
  readonly languages: TtsLanguage[] | null;
  readonly speedRange: { min: number; max: number };
  listVoices(): Promise<TtsVoice[]>;
  /**
   * A wider voice library to search (beyond listVoices), if the provider has
   * one. Voices from it can be spoken with directly.
   */
  searchVoices?(query: VoiceSearch): Promise<{ voices: TtsVoice[]; hasMore: boolean }>;
  speak(request: SpeakRequest): Promise<SpeechAudio>;
  /** A short sample of a voice, for providers without hosted previews */
  previewSpeech?(voiceId: string, language: string): Promise<SpeechAudio>;
  /** Users' own voices (cloning), if the provider offers it */
  ownVoices?: {
    create(userId: string, sample: OwnVoiceSample): Promise<string>;
    remove(voiceId: string): Promise<void>;
  };
}
