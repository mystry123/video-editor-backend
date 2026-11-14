// services/render.service.ts
//
// RENDER_PROVIDER=local (the default): renders run on the worker with
// @remotion/renderer and a headless Chrome. (RENDER_PROVIDER=lambda runs them
// on Remotion Lambda instead: services/lambdaRender.service.ts; the director's
// storyboard stills still render here.) The composition
// ("VideoEditor") comes from a bundle of the frontend's app/remotion entry:
// the frontend deploy writes it to a versioned directory and points
// REMOTION_SERVE_URL's `current` link at it. Each render resolves that link
// once, so a deploy never changes a render that is already running.
//
// @remotion/renderer must be the exact version the bundle was built with
// (the frontend's remotion packages; 4.0.400 now).

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  ensureBrowser,
  makeCancelSignal,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
} from '@remotion/renderer';
import { env } from '../config/env';
import { uploadRenderFile } from './storage.service';
import { logger } from '../utils/logger';

export const COMPOSITION_ID = 'VideoEditor';

type Codec = 'h264' | 'vp8' | 'gif';

// Output format (as stored on the template) → Remotion codec. Keep in sync with
// SUPPORTED_OUTPUT_FORMATS in controllers/render.controller.ts.
const CODEC_BY_FORMAT: Record<string, Codec> = {
  mp4: 'h264',
  webm: 'vp8',
  gif: 'gif',
};

const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
};

export function codecFor(outputFormat: string): Codec {
  const codec = CODEC_BY_FORMAT[outputFormat];
  if (!codec) throw new Error(`Unsupported output format: ${outputFormat}`);
  return codec;
}

/** The composition's input props, as the frontend's Root.tsx reads them */
export function compositionProps(project: any, elements: any[] | undefined) {
  return { projectSettings: project, elements: elements || [] };
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/**
 * Where this render's composition bundle is: an http(s) URL as is, or a local
 * directory with symlinks resolved (so later deploys don't swap it mid-render).
 */
export async function resolveServeUrl(serveUrl = env.remotionServeUrl): Promise<string> {
  if (!serveUrl) throw new Error('REMOTION_SERVE_URL is not set');
  if (/^https?:\/\//i.test(serveUrl)) return serveUrl;
  try {
    const dir = await fs.realpath(serveUrl);
    await fs.access(path.join(dir, 'index.html'));
    return dir;
  } catch {
    throw new Error(`Remotion bundle not found at ${serveUrl} (deploy the frontend to build it)`);
  }
}

// ---------------------------------------------------------------------------
// Browser: one headless Chrome per process, shared by renders and stills
// ---------------------------------------------------------------------------

type Browser = Awaited<ReturnType<typeof openBrowser>>;
let browser: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  // Downloads Chrome Headless Shell on first use (into node_modules/.remotion).
  await ensureBrowser();
  return openBrowser('chrome', { logLevel: 'warn' });
}

export function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = launch().catch((error) => {
      browser = null;
      throw error;
    });
  }
  return browser;
}

/** Closes the shared browser (next use opens a fresh one). Never throws. */
export async function closeBrowser(): Promise<void> {
  const current = browser;
  browser = null;
  if (!current) return;
  try {
    await (await current).close({ silent: true });
  } catch {
    // already gone
  }
}

/** Errors that mean the shared Chrome died, not that the project is broken */
export function isBrowserCrash(message: string | undefined): boolean {
  return /Target closed|Session closed|Browser closed|browser has disconnected|Protocol error|ECONNRESET|socket hang up/i.test(message || '');
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface RenderProgressUpdate {
  /** 0..1 over frames + encoding */
  progress: number;
  renderedFrames: number;
  encodedFrames: number;
  stage: string;
}

export interface RenderVideoOptions {
  serveUrl: string;
  project: any;
  elements: any[];
  outputFormat: string;
  scale?: number;
  outputPath: string;
  onProgress?: (update: RenderProgressUpdate) => void;
  cancelSignal?: ReturnType<typeof makeCancelSignal>['cancelSignal'];
}

export interface RenderVideoResult {
  outputPath: string;
  frames: number;
  sizeBytes: number;
}

export async function renderVideo(options: RenderVideoOptions): Promise<RenderVideoResult> {
  const codec = codecFor(options.outputFormat);
  const inputProps = compositionProps(options.project, options.elements);
  const puppeteerInstance = await getBrowser();
  const composition = await selectComposition({
    serveUrl: options.serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    puppeteerInstance,
    logLevel: 'warn',
  });

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await renderMedia({
    serveUrl: options.serveUrl,
    composition,
    inputProps,
    codec,
    outputLocation: options.outputPath,
    overwrite: true,
    scale: options.scale || 1,
    puppeteerInstance,
    concurrency: env.remotionConcurrency,
    // Same quality settings the Lambda renders used.
    crf: codec === 'gif' ? undefined : 18,
    imageFormat: 'png',
    ...(codec === 'h264' ? { pixelFormat: 'yuv420p' as const } : {}),
    // Media comes from GCS; give slow loads time before a frame times out.
    timeoutInMilliseconds: 60_000,
    cancelSignal: options.cancelSignal,
    logLevel: 'warn',
    onProgress: (p) =>
      options.onProgress?.({
        progress: p.progress,
        renderedFrames: p.renderedFrames,
        encodedFrames: p.encodedFrames,
        stage: String(p.stitchStage),
      }),
  });

  const stat = await fs.stat(options.outputPath);
  return { outputPath: options.outputPath, frames: composition.durationInFrames, sizeBytes: stat.size };
}

/** Where a job's output is written while rendering */
export function localOutputPath(jobId: string, outputFormat: string): string {
  return path.join(os.tmpdir(), 'shotline-renders', `${jobId}.${outputFormat}`);
}

/**
 * Uploads a finished render to the (private) renders bucket of the active
 * storage provider and returns its
 * storage URL; users only ever get /r/<id> links to it (renderOutput.service).
 */
export async function uploadRenderOutput(localPath: string, job: { _id: any; userId: any; outputFormat: string }): Promise<string> {
  const key = `renders/${job.userId}/${job._id}.${job.outputFormat}`;
  return uploadRenderFile(localPath, key, CONTENT_TYPE_BY_FORMAT[job.outputFormat] || 'application/octet-stream');
}

// ---------------------------------------------------------------------------
// Stills (the director's storyboard)
// ---------------------------------------------------------------------------

export async function renderStillFrame(project: any, elements: any[], frame: number, scale: number): Promise<Buffer> {
  const serveUrl = await resolveServeUrl();
  const inputProps = compositionProps(project, elements);
  const puppeteerInstance = await getBrowser();
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, puppeteerInstance, logLevel: 'warn' });
  const { buffer } = await renderStill({
    serveUrl,
    composition,
    inputProps,
    frame: Math.max(0, Math.min(composition.durationInFrames - 1, frame)),
    imageFormat: 'jpeg',
    jpegQuality: 72,
    scale,
    puppeteerInstance,
    timeoutInMilliseconds: 60_000,
    logLevel: 'warn',
  });
  if (!buffer) throw new Error('renderStill returned no image');
  return buffer;
}

export { makeCancelSignal };

/** Logged once at worker start: where renders will read the composition */
export async function describeRenderSetup(): Promise<void> {
  try {
    logger.info('Renders use the composition bundle', { serveUrl: await resolveServeUrl() });
  } catch (error: any) {
    logger.warn('Renders will fail until the composition bundle exists', { error: error?.message });
  }
}
