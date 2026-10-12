// services/audio/index.ts
//
// AI audio tools beyond speech: cleaning up a recording (the voice without
// background noise) and sound effects from a description. ElevenLabs is the
// only implementation today; callers use getAudioTools() so tests (or another
// vendor later) can swap it with setAudioTools(). The ElevenLabs key needs the
// Audio Isolation and Sound Effects permissions.

import { elevenLabsCall } from '../tts/elevenlabs';

export interface AudioTools {
  /** The voice from `audio` (an MP3), without background noise, as MP3 */
  isolateVoice(audio: Buffer, filename: string): Promise<Buffer>;
  /** A sound effect from a description; duration in seconds, or chosen by the model */
  soundEffect(prompt: string, durationSeconds?: number): Promise<Buffer>;
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
};

let override: AudioTools | null = null;

export function getAudioTools(): AudioTools {
  return override ?? elevenLabsAudioTools;
}

/** Tests: use `tools` instead (null goes back to ElevenLabs). */
export function setAudioTools(tools: AudioTools | null): void {
  override = tools;
}
