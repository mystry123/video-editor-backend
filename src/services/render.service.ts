// services/render.service.ts

import { AwsRegion, getRenderProgress, renderMediaOnLambda } from '@remotion/lambda-client';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface RenderResult {
  renderId: string;
  bucketName: string;
}

export interface RenderProgress {
  done: boolean;
  progress: number;
  outputFile?: string;
  errors?: any[];
  fatalErrorEncountered?: boolean;
  framesRendered?: number;
  chunks?: number;
  costs?: {
    accruedSoFar: number;
    displayCost: string;
    currency: string;
  };
  encodingStatus?: any;
  renderMetadata?: any;
  lambdasInvoked?: number;
  timeToFinish?: number;
  timeToRenderFrames?: number;
  timeToEncode?: number;
  outputSizeInBytes?: number;
}

// Output format (as stored on the template) → Remotion codec. Keep in sync with
// SUPPORTED_OUTPUT_FORMATS in controllers/render.controller.ts.
type LambdaCodec = Parameters<typeof renderMediaOnLambda>[0]['codec'];

const CODEC_BY_FORMAT: Record<string, LambdaCodec> = {
  mp4: 'h264',
  webm: 'vp8',
  gif: 'gif',
};

const FRAMES_PER_LAMBDA = 60;

/** How to split a render across Lambdas: 60-frame chunks, unless that would
 * need more Lambdas than the account allows at once, then exactly that many
 * (bigger chunks, slower render, but it runs). */
export function renderChunking(project: any, maxLambdas = env.remotionMaxLambdas): { framesPerLambda: number } | { concurrency: number } {
  const frames = Math.ceil((Number(project?.duration) || 0) * (Number(project?.fps) || 30));
  if (Math.ceil(frames / FRAMES_PER_LAMBDA) <= maxLambdas) return { framesPerLambda: FRAMES_PER_LAMBDA };
  return { concurrency: maxLambdas };
}

export async function startRemotionRender(job: any): Promise<RenderResult> {
  const codec = CODEC_BY_FORMAT[job.outputFormat];
  if (!codec) {
    throw new Error(`Unsupported output format: ${job.outputFormat}`);
  }

  logger.info('Starting Remotion render', { jobId: job._id });

  const response = await renderMediaOnLambda({
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
    serveUrl: env.remotionServeUrl,
    composition: 'VideoEditor',
    inputProps: {
      projectSettings: job.inputProps.project,
      elements: job.inputProps.elements || [],
    },
    codec,
    scale: job.scale || 1,
    ...renderChunking(job.inputProps.project),
    outName: `renders/${job.userId}/${job._id}.${job.outputFormat}`,
    maxRetries: 3,
    imageFormat: 'png',
    crf: 18,
    // yuv420p is only valid for h264; vp8/gif pick their own pixel format.
    ...(codec === 'h264' ? { pixelFormat: 'yuv420p' as const } : {}),
    // Private: users get a Shotline link that redirects to a signed URL
    // (services/renderOutput.service.ts), never the bucket itself.
    privacy: 'private',
    // Webhook mode: Remotion calls us when the render ends (signed with the
    // secret); customData lets us match the job even before renderId is saved.
    ...(env.remotionWebhookUrl && env.remotionWebhookSecret
      ? { webhook: { url: env.remotionWebhookUrl, secret: env.remotionWebhookSecret, customData: { jobId: String(job._id) } } }
      : {}),
  });

  logger.info('Render started', {
    jobId: job._id,
    renderId: response.renderId,
    codec,
    scale: job.scale || 1,
  });

  return { renderId: response.renderId, bucketName: response.bucketName };
}

// Keep this for manual progress checks if needed
export async function checkRemotionProgress(
  renderId: string,
  bucketName: string
): Promise<RenderProgress> {
  const progress = await getRenderProgress({
    renderId,
    bucketName,
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
  });

  return {
    ...progress,
    progress: (progress as any).overallProgress || 0,
  } as RenderProgress;
}