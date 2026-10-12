import { ApiError } from '../../utils/ApiError';

/** Any provider problem that isn't the user's: setup, credits, limits, outages. Details go to the log. */
export const voiceUnavailable = () =>
  ApiError.withCode(503, 'VOICE_UNAVAILABLE', "Text to speech isn't available right now. Try again in a few minutes.");
