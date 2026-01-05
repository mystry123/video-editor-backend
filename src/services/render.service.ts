import { AwsRegion, getRenderProgress, renderMediaOnLambda } from '@remotion/lambda-client';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Note: Install @remotion/lambda for production use
// import { renderMediaOnLambda, getRenderProgress, AwsRegion } from '@remotion/lambda';

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
  timeToRenderFrames?: number;
  timeToFinish?: number;
  costs?: {
    accruedSoFar: number;
    displayCost: string;
    currency: string;
    disclaimer?: string;
  };
  encodingStatus?: {
    framesEncoded: number;
    combinedFrames: number;
    timeToCombine: number | null;
  };
  renderMetadata?: any;
  bucket?: string;
  renderSize?: number;
  cleanup?: {
    doneIn: number;
    filesDeleted: number;
    minFilesToDelete: number;
  };
  currentTime?: number;
  fatalErrorEncountered?: boolean;
  lambdasInvoked?: number;
  timeToFinishChunks?: number;
  timeToEncode?: number;
  outputSizeInBytes?: number;
  type?: string;
  estimatedBillingDurationInMilliseconds?: number;
  timeToCombine?: number;
  combinedFrames?: number;
  mostExpensiveFrameRanges?: Array<{
    timeInMilliseconds: number;
    chunk: number;
    frameRange: [number, number];
  }>;
  outKey?: string;
  outBucket?: string;
  timeoutTimestamp?: number;
  compositionValidated?: number;
  functionLaunched?: number;
  serveUrlOpened?: number;
  artifacts?: any[];
}

export async function startRemotionRender(job: any): Promise<RenderResult> {
  logger.info('Starting Remotion render', { jobId: job._id });

  console.log('Job data:', JSON.stringify(job, null, 2));
  console.log('Environment vars:', JSON.stringify({
    awsRegion: env.awsRegion,
    remotionFunctionName: env.remotionFunctionName,
    remotionServeUrl: env.remotionServeUrl
  }, null, 2));
  // Uncomment when @remotion/lambda is installed:

  const response = await renderMediaOnLambda({
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
    serveUrl: env.remotionServeUrl,
    composition: "VideoEditor",
    inputProps: {
      projectSettings: job.inputProps.project,
      elements: job.inputProps.elements || []
    },
    codec: job.outputFormat === 'mp4' ? 'h264' : job.outputFormat,
    framesPerLambda: 500,
    outName: `renders/${job.userId}/${job._id}.${job.outputFormat}`,
    maxRetries: 3,
    imageFormat: 'png',
  });
  console.log('Render started:', JSON.stringify(response, null, 2));

  return { renderId: response.renderId, bucketName: response.bucketName };

}

export async function checkRemotionProgress(
  renderId: string,
  bucketName: string
): Promise<RenderProgress> {
  // Uncomment when @remotion/lambda is installed:

  const progress = await getRenderProgress({
    renderId,
    bucketName,
    region: env.awsRegion as AwsRegion,
    functionName: env.remotionFunctionName,
  });

  console.log('Progress check result:', JSON.stringify(progress, null, 2));

  // Return the full progress response with all fields
  const remotionProgress = progress as any;
  const fullProgress: RenderProgress = {
    ...remotionProgress,
    progress: remotionProgress.overallProgress || remotionProgress.progress || 0,
  };
  
  return fullProgress;

}
