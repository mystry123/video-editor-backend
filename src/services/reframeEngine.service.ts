// services/reframeEngine.service.ts
//
// Client for the reframe engine service (shotline-reframe, Python). It runs
// analyses in the background; we submit, poll for progress, then ask it to
// plan the shape the user wants. Planning a finished analysis is fast, so a
// new shape, zoom or keep-text choice doesn't re-analyse the video.

import axios from 'axios';
import { env } from '../config/env';

export type ReframeQuality = 'standard' | 'high' | 'max';
export type ReframeZoom = 'sharp' | 'balanced' | 'tight';

export interface AnalysisStatus {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage?: string;
  stageLabel?: string;
  progress?: number;
  error?: string;
  text?: Array<{ id: string; kind: string; region: string; description: string; onScreen: number; canKeep: boolean }>;
  duration?: number;
  /** Burned-in captions inside the picture (the editor offers Keep / Replace). */
  pictureCaptions?: boolean;
}

/** Burned-in captions inside the picture: keep them, or leave them out and add Shotline captions. */
export type ReframeCaptions = 'keep' | 'replace';
export const REFRAME_CAPTIONS: readonly ReframeCaptions[] = ['keep', 'replace'];

export interface PlanOptions {
  ratio: string;
  zoom: ReframeZoom;
  keepText: string[];
  outputHeight: number;
  captions?: ReframeCaptions;
}

const OUTPUT_HEIGHTS = [720, 1080, 1440, 2160];

export function reframeEngineConfigured(): boolean {
  return Boolean(env.reframeServiceUrl);
}

// Planning is fast unless the AI director picks framings (a vision-model
// call, cached per analysis and shape): allow for that.
const PLAN_TIMEOUT_MS = 120_000;

function client(timeout = 30_000) {
  return axios.create({
    baseURL: env.reframeServiceUrl.replace(/\/$/, ''),
    timeout,
    headers: env.reframeServiceToken ? { 'X-Internal-Token': env.reframeServiceToken } : undefined,
  });
}

/** Output height the engine should plan for, from a plan's max resolution ("1080p", "4k", …). */
export function outputHeightFor(maxResolution: string | undefined): number {
  const m = String(maxResolution || '1080p').toLowerCase();
  const px = m === '4k' ? 2160 : m === '2k' ? 1440 : Number.parseInt(m, 10) || 1080;
  return [...OUTPUT_HEIGHTS].reverse().find((h) => h <= px) ?? 720;
}

export async function submitAnalysis(input: {
  videoUrl: string;
  words?: unknown[];
  quality: ReframeQuality;
}): Promise<AnalysisStatus> {
  const { data } = await client().post('/analyses', input);
  return data;
}

export async function getAnalysis(id: string): Promise<AnalysisStatus> {
  const { data } = await client().get(`/analyses/${encodeURIComponent(id)}`);
  return data;
}

export async function planAnalysis(id: string, options: PlanOptions): Promise<Record<string, unknown>> {
  const { data } = await client(PLAN_TIMEOUT_MS).post(`/analyses/${encodeURIComponent(id)}/plan`, options);
  return data;
}
