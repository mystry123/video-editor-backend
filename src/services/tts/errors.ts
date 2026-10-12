import { ApiError } from '../../utils/ApiError';

/** Any provider problem that isn't the user's: setup, credits, limits, outages. Details go to the log. */
export const voiceUnavailable = () =>
  ApiError.withCode(503, 'VOICE_UNAVAILABLE', "This voice feature isn't available right now. Try again in a few minutes.");

/** The provider account isn't set up for this feature (e.g. the API key lacks its permission). */
export const voiceFeatureNotEnabled = (feature: string) =>
  ApiError.withCode(503, 'VOICE_FEATURE_NOT_ENABLED', `${feature} isn't switched on for Shotline yet.`);
