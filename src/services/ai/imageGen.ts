// services/ai/imageGen.ts
//
// Makes an image from a description with a Gemini image model on Vertex AI
// (same credentials as the assistant). Returns the image bytes; saving and
// metering are the caller's. Tests swap the generator with setImageGenerator().

import { GoogleAuth } from 'google-auth-library';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';

export const IMAGE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

export type ImageGenerator = (prompt: string, aspect: ImageAspect) => Promise<GeneratedImage>;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], projectId: env.vertexProject });

const unavailable = () => ApiError.withCode(503, 'IMAGES_UNAVAILABLE', "Image generation isn't available right now. Try again in a minute.");

const vertexGenerator: ImageGenerator = async (prompt, aspect) => {
  let token: string | null | undefined;
  try {
    token = await auth.getAccessToken();
  } catch (error) {
    logger.error('Vertex credentials unavailable', { error: (error as Error).message });
    throw unavailable();
  }
  const host = env.vertexLocation === 'global' ? 'aiplatform.googleapis.com' : `${env.vertexLocation}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${env.vertexProject}/locations/${env.vertexLocation}/publishers/google/models/${env.imageModel}:generateContent`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    logger.error('Vertex unreachable (image)', { error: (error as Error).message });
    throw unavailable();
  }
  if (!response.ok) {
    logger.error('Image generation failed', { status: response.status, body: (await response.text()).slice(0, 500), model: env.imageModel });
    throw unavailable();
  }
  const body = (await response.json()) as any;
  const candidate = body.candidates?.[0];
  const image = (candidate?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
  if (!image) {
    // Blocked by safety filters, or the model answered in words only
    logger.warn('No image returned', { finishReason: candidate?.finishReason, block: body.promptFeedback?.blockReason });
    throw ApiError.withCode(422, 'IMAGE_NOT_MADE', "That image couldn't be made. Try describing it differently.");
  }
  return { bytes: Buffer.from(image.inlineData.data, 'base64'), mimeType: String(image.inlineData.mimeType || 'image/png') };
};

let override: ImageGenerator | null = null;

export function getImageGenerator(): ImageGenerator {
  return override ?? vertexGenerator;
}

/** Tests: use `generator` instead (null goes back to Vertex). */
export function setImageGenerator(generator: ImageGenerator | null): void {
  override = generator;
}
