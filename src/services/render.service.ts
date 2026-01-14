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

export async function startRemotionRender(job: any): Promise<RenderResult> {
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
    codec: job.outputFormat === 'mp4' ? 'h264' : job.outputFormat,
    framesPerLambda: 60,
    outName: `renders/${job.userId}/${job._id}.${job.outputFormat}`,
    maxRetries: 3,
    imageFormat: 'png',
    crf: 18,
    pixelFormat: 'yuv420p',
    privacy: 'public',
  });

  logger.info('Render started with webhook', {
    jobId: job._id,
    renderId: response.renderId,
    webhookUrl: `${env.apiBaseUrl}/webhooks/remotion`,
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