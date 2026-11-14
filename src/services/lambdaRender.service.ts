// services/lambdaRender.service.ts
//
// Renders on Remotion Lambda (RENDER_PROVIDER=lambda), restored from the
// pre-GCP code (before commit 240893d). The render is split into chunks that
// run on parallel Lambdas and is written, private, to REMOTION_BUCKET.
// It completes one of two ways:
// - webhook mode (REMOTION_WEBHOOK_URL + REMOTION_WEBHOOK_SECRET): Remotion
//   calls POST /api/v1/webhooks/remotion, signed with the secret;
// - poll mode: the render worker polls getRenderProgress until it ends.
// Either way the outcome goes through renderLifecycle.service, the same as
// local renders.

import { getRenderProgress, renderMediaOnLambda, deleteRender, type AwsRegion } from '@remotion/lambda-client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { COMPOSITION_ID, codecFor, compositionProps } from './render.service';

export interface LambdaRenderStart {
  renderId: string;
  bucketName: string;
}

export interface LambdaRenderProgress {
  done: boolean;
  progress: number;
  outputFile?: string;
  errors?: any[];
  fatalErrorEncountered?: boolean;
  framesRendered?: number;
  chunks?: number;
  costs?: { accruedSoFar: number; displayCost: string; currency: string };
  encodingStatus?: any;
  renderMetadata?: any;
  lambdasInvoked?: number;
  timeToFinish?: number;
  timeToRenderFrames?: number;
  timeToEncode?: number;
  outputSizeInBytes?: number;
}

/** Lambda render ids are Remotion's; local renders use "local-<host>-<time>" */
export function isLambdaRenderId(renderId: string | undefined | null): renderId is string {
  return Boolean(renderId) && !String(renderId).startsWith('local-');
}

/**
 * Webhook mode: Remotion reports completion to us, so the worker only starts
 * renders. Needs a public URL Lambda can reach and a secret to sign with.
 */
export function webhookMode(): boolean {
  return env.renderProvider === 'lambda' && Boolean(env.remotionWebhookUrl && env.remotionWebhookSecret);
}

const FRAMES_PER_LAMBDA = 60;

/** How to split a render across Lambdas: 60-frame chunks, unless that would
 * need more Lambdas than the account allows at once, then exactly that many
 * (bigger chunks, slower render, but it runs). */
export function renderChunking(project: any, maxLambdas = env.remotionMaxLambdas): { framesPerLambda: number } | { concurrency: number } {
  const frames = Math.ceil((Number(project?.duration) || 0) * (Number(project?.fps) || 30));
  if (Math.ceil(frames / FRAMES_PER_LAMBDA) <= maxLambdas) return { framesPerLambda: FRAMES_PER_LAMBDA };
  return { concurrency: maxLambdas };
}

/** Where a Lambda render's output goes in REMOTION_BUCKET */
export function lambdaOutName(job: { _id: any; userId: any; outputFormat: string }): string {
  return `renders/${job.userId}/${job._id}.${job.outputFormat}`;
}

export async function startLambdaRender(job: any): Promise<LambdaRenderStart> {
  const codec = codecFor(job.outputFormat);
  logger.info('Starting Remotion Lambda render', { jobId: job._id });

  const response = await renderMediaOnLambda({
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
    serveUrl: env.remotionServeUrl,
    composition: COMPOSITION_ID,
    inputProps: compositionProps(job.inputProps?.project, job.inputProps?.elements),
    codec,
    scale: job.scale || 1,
    ...renderChunking(job.inputProps?.project),
    outName: lambdaOutName(job),
    maxRetries: 3,
    imageFormat: 'png',
    // Same quality settings as local renders.
    ...(codec === 'gif' ? {} : { crf: 18 }),
    // yuv420p is only valid for h264; vp8/gif pick their own pixel format.
    ...(codec === 'h264' ? { pixelFormat: 'yuv420p' as const } : {}),
    // Private: users get a Shotline link that redirects to a signed URL
    // (services/renderOutput.service.ts), never the bucket itself.
    privacy: 'private',
    // Render in REMOTION_BUCKET (the bucket whose outputs we trust and sign),
    // not whichever Remotion bucket it would find in the region.
    forceBucketName: env.remotionBucket,
    // Webhook mode: Remotion calls us when the render ends (signed with the
    // secret); customData lets us match the job even before renderId is saved.
    ...(webhookMode()
      ? { webhook: { url: env.remotionWebhookUrl, secret: env.remotionWebhookSecret, customData: { jobId: String(job._id) } } }
      : {}),
  });

  logger.info('Lambda render started', { jobId: job._id, renderId: response.renderId, codec, scale: job.scale || 1 });
  return { renderId: response.renderId, bucketName: response.bucketName };
}

export async function getLambdaRenderProgress(renderId: string, bucketName: string): Promise<LambdaRenderProgress> {
  const progress = await getRenderProgress({
    renderId,
    bucketName,
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
  });
  return { ...progress, progress: (progress as any).overallProgress || 0 } as LambdaRenderProgress;
}

/** Deletes a Lambda render's working files and output. Already gone is fine. */
export async function deleteLambdaRender(renderId: string, bucketName: string): Promise<void> {
  try {
    await deleteRender({ bucketName, renderId, region: env.awsRegion as AwsRegion });
  } catch (error: any) {
    if (!/NoSuchKey|not found|404/i.test(error?.message || '')) throw error;
  }
}
