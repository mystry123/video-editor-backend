// services/tts/index.ts
//
// Which text-to-speech provider Shotline uses: TTS_PROVIDER ("elevenlabs",
// the default, or "sarvam"). Callers get it from getTtsProvider() and never
// import a provider directly; tests swap in a fake with setTtsProvider().

import { env } from '../../config/env';
import { elevenLabsProvider } from './elevenlabs';
import { sarvamProvider } from './sarvam';
import type { TtsProvider, TtsProviderId } from './types';

export * from './types';

const PROVIDERS: Record<TtsProviderId, TtsProvider> = {
  elevenlabs: elevenLabsProvider,
  sarvam: sarvamProvider,
};

let override: TtsProvider | null = null;

/** The provider in use. */
export function getTtsProvider(): TtsProvider {
  return override ?? PROVIDERS[env.ttsProvider] ?? elevenLabsProvider;
}

/** A specific provider: e.g. to delete an own voice made with a provider no longer in use. */
export function getTtsProviderById(id: TtsProviderId): TtsProvider {
  if (override?.id === id) return override;
  return PROVIDERS[id];
}

/** Tests: use `provider` instead (null goes back to the setting). */
export function setTtsProvider(provider: TtsProvider | null): void {
  override = provider;
}
