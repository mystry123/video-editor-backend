// services/audio/index.ts
//
// AI audio tools beyond speech: cleaning up a recording (the voice without
// background noise) and sound effects from a description. ElevenLabs is the
// only implementation today; callers use getAudioTools() so tests (or another
// vendor later) can swap it with setAudioTools(). The ElevenLabs key needs the
// Audio Isolation and Sound Effects permissions.

import { elevenLabsCall } from '../tts/elevenlabs';

export type DubStatus = { state: 'dubbing' } | { state: 'dubbed' } | { state: 'failed'; error?: string };

export interface AudioTools {
  /** The voice from `audio` (an MP3), without background noise, as MP3 */
  isolateVoice(audio: Buffer, filename: string): Promise<Buffer>;
  /** A sound effect from a description; duration in seconds, or chosen by the model */
  soundEffect(prompt: string, durationSeconds?: number): Promise<Buffer>;
  /** Starts dubbing `audio` (an MP3) into `language` (ISO 639-1); the job's id and expected wait */
  startDub(audio: Buffer, filename: string, language: string): Promise<{ id: string; expectedSeconds: number }>;
  dubStatus(id: string): Promise<DubStatus>;
  /** The dubbed audio, once the status is 'dubbed' */
  dubbedAudio(id: string, language: string): Promise<Buffer>;
  /** Removes the job at the provider (best effort) */
  deleteDub(id: string): Promise<void>;
}

export const SOUND_EFFECT_SECONDS = { min: 0.5, max: 22 } as const;

const elevenLabsAudioTools: AudioTools = {
  async isolateVoice(audio, filename) {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), filename);
    const response = await elevenLabsCall('/v1/audio-isolation', { method: 'POST', body: form }, 'audio isolation');
    return Buffer.from(await response.arrayBuffer());
  },
  async soundEffect(prompt, durationSeconds) {
    const response = await elevenLabsCall(
      '/v1/sound-generation?output_format=mp3_44100_128',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: prompt,
          ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
          prompt_influence: 0.4,
        }),
      },
      'sound effect'
    );
    return Buffer.from(await response.arrayBuffer());
  },
  async startDub(audio, filename, language) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), filename);
    form.append('target_lang', language);
    form.append('num_speakers', '0'); // detect
    form.append('watermark', 'false'); // audio only: watermarks are for video output
    form.append('name', `shotline ${filename}`);
    const response = await elevenLabsCall('/v1/dubbing', { method: 'POST', body: form }, 'dubbing');
    const body = (await response.json()) as { dubbing_id?: string; expected_duration_sec?: number };
    if (!body.dubbing_id) throw new Error('No dubbing id');
    return { id: body.dubbing_id, expectedSeconds: Number(body.expected_duration_sec) || 60 };
  },
  async dubStatus(id) {
    const response = await elevenLabsCall(`/v1/dubbing/${encodeURIComponent(id)}`, { method: 'GET' }, 'dubbing status');
    const body = (await response.json()) as { status?: string; error?: string; error_message?: string };
    if (body.status === 'dubbed') return { state: 'dubbed' };
    if (body.status === 'dubbing' || body.status === 'cloning' || body.status === 'transcribing' || !body.status) return { state: 'dubbing' };
    return { state: 'failed', error: body.error_message || body.error || body.status };
  },
  async dubbedAudio(id, language) {
    const response = await elevenLabsCall(`/v1/dubbing/${encodeURIComponent(id)}/audio/${encodeURIComponent(language)}`, { method: 'GET' }, 'dubbing download');
    return Buffer.from(await response.arrayBuffer());
  },
  async deleteDub(id) {
    await elevenLabsCall(`/v1/dubbing/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'dubbing delete').catch(() => undefined);
  },
};

let override: AudioTools | null = null;

export function getAudioTools(): AudioTools {
  return override ?? elevenLabsAudioTools;
}

/** Tests: use `tools` instead (null goes back to ElevenLabs). */
export function setAudioTools(tools: AudioTools | null): void {
  override = tools;
}
