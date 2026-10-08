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
    framesPerLambda: 60,
    outName: `renders/${job.userId}/${job._id}.${job.outputFormat}`,
    maxRetries: 3,
    imageFormat: 'png',
    crf: 18,
    // yuv420p is only valid for h264; vp8/gif pick their own pixel format.
    ...(codec === 'h264' ? { pixelFormat: 'yuv420p' as const } : {}),
    privacy: 'public',
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