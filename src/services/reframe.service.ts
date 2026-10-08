// src/services/reframe.service.ts
// AI Reframe Service: calls YOLO microservice, smooths detections, generates keyframes

import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface ReframeBoundingBox {
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  width: number; height: number;
}

export interface ReframeDetection {
  time: number;
  frame: number;
  confidence: number;
  person_id: number;
  bbox: ReframeBoundingBox;
}

export interface LayoutZone {
  zone_id: string;
  person_ids: number[];
  crop_cx: number;
  crop_cy: number;
  crop_width: number;
  crop_height: number;
  canvas_top: number;
  canvas_left: number;
  canvas_w: number;
  canvas_h: number;
}

export interface LayoutDecision {
  layout_type: string;
  zones: LayoutZone[];
  reasoning: string;
  confidence: number;
}

export interface ReframeAnalysis {
  detections: ReframeDetection[];
  layout_decision: LayoutDecision | null;
  scene_stats: Record<string, any> | null;
  fps: number;
  total_frames: number;
  video_width: number;
  video_height: number;
  status: string;
}

export interface ReframeKeyframe {
  time: number;
  cropLeft: number;
  cropTop: number;
  cropWidth: number;
  cropHeight: number;
}

export interface ReframeZoneKeyframes {
  zone_id: string;
  person_ids: number[];
  canvas_top: number;
  canvas_left: number;
  canvas_w: number;
  canvas_h: number;
  keyframes: ReframeKeyframe[];
}

// ============================================================================
// Call YOLO Microservice
// ============================================================================

/**
 * Send video to YOLO microservice for subject detection + Bedrock layout reasoning
 */
export async function analyzeVideoForReframe(
  videoUrl: string,
  options: {
    sampleEveryN?: number;
    sourceRatio?: string;
    targetRatio?: string;
    transcriptionText?: string;
    fileDuration?: number;
    hasAudio?: boolean;
  } = {}
): Promise<ReframeAnalysis> {
  const {
    sampleEveryN = 15,
    sourceRatio = '16:9',
    targetRatio = '9:16',
    transcriptionText,
    fileDuration,
    hasAudio = true,
  } = options;

  logger.info('[reframe] Calling YOLO service', { videoUrl, targetRatio });

  const response = await axios.post(
    `${env.yoloServiceUrl}/detect`,
    {
      video_url: videoUrl,
      sample_every_n: sampleEveryN,
      source_ratio: sourceRatio,
      target_ratio: targetRatio,
      transcription_text: transcriptionText,
      file_duration: fileDuration,
      has_audio: hasAudio,
    },
    {
      timeout: 300_000, // 5 min timeout for long videos
      headers: env.yoloSharedSecret ? { 'X-Internal-Token': env.yoloSharedSecret } : undefined,
    }
  );

  return response.data as ReframeAnalysis;
}

// ============================================================================
// Smoothing Algorithm (Moving Average)
// ============================================================================

/**
 * Apply moving average smoothing to bounding box coordinates
 * Prevents "jittery camera" effect when crop follows subject
 */
export function smoothDetections(
  detections: ReframeDetection[],
  windowSize = 5
): ReframeDetection[] {
  if (detections.length <= windowSize) return detections;

  // Group by person_id and smooth each independently
  const byPerson = new Map<number, ReframeDetection[]>();
  for (const det of detections) {
    if (!byPerson.has(det.person_id)) {
      byPerson.set(det.person_id, []);
    }
    byPerson.get(det.person_id)!.push(det);
  }

  const smoothed: ReframeDetection[] = [];

  for (const [, personDets] of byPerson) {
    for (let i = 0; i < personDets.length; i++) {
      const start = Math.max(0, i - Math.floor(windowSize / 2));
      const end = Math.min(personDets.length - 1, i + Math.floor(windowSize / 2));
      const window = personDets.slice(start, end + 1);

      const avg = (key: keyof ReframeBoundingBox) =>
        window.reduce((sum, d) => sum + (d.bbox[key] as number), 0) / window.length;

      smoothed.push({
        ...personDets[i],
        bbox: {
          ...personDets[i].bbox,
          cx: avg('cx'),
          cy: avg('cy'),
          width: avg('width'),
          height: avg('height'),
        },
      });
    }
  }

  // Sort by time to maintain chronological order
  smoothed.sort((a, b) => a.time - b.time);
  return smoothed;
}

// ============================================================================
// Keyframe Generation
// ============================================================================

/**
 * Adjust a normalized crop region (in source coords) so its pixel-aspect matches
 * `desiredNormalizedRatio` — i.e. (cropWidth × srcW) / (cropHeight × srcH) ===
 * (zoneCanvasW × targetW) / (zoneCanvasH × targetH).
 *
 * We always **expand** the smaller dimension. That preserves the bounding rect
 * of the detected persons (we never crop them out) at the cost of including
 * a bit more of the surrounding frame. If the expansion would push past 1, we
 * clamp to 1 and shrink the other dimension instead so the aspect stays exact.
 *
 * Returns { cropWidth, cropHeight, cropLeft, cropTop } all in [0, 1].
 */
function fitCropToAspect(
  cropWidth: number,
  cropHeight: number,
  centerX: number,
  centerY: number,
  desiredNormalizedRatio: number
): { cropWidth: number; cropHeight: number; cropLeft: number; cropTop: number } {
  let w = cropWidth;
  let h = cropHeight;

  const currentRatio = w / h;
  if (currentRatio < desiredNormalizedRatio) {
    // crop is too narrow → widen
    w = h * desiredNormalizedRatio;
  } else if (currentRatio > desiredNormalizedRatio) {
    // crop is too short → make it taller
    h = w / desiredNormalizedRatio;
  }

  // Clamp to [0, 1]. If clamping breaks the aspect, shrink the other axis to
  // restore it. This guarantees the final aspect is exact.
  if (w > 1) {
    w = 1;
    h = w / desiredNormalizedRatio;
  }
  if (h > 1) {
    h = 1;
    w = h * desiredNormalizedRatio;
  }
  // Guard against degenerate values (very thin zones can produce w or h ≈ 0).
  w = Math.max(0.01, Math.min(1, w));
  h = Math.max(0.01, Math.min(1, h));

  // Re-center, then clamp the position so the crop stays within [0, 1].
  const cropLeft = Math.max(0, Math.min(1 - w, centerX - w / 2));
  const cropTop = Math.max(0, Math.min(1 - h, centerY - h / 2));

  return { cropWidth: w, cropHeight: h, cropLeft, cropTop };
}

/**
 * Convert detections + layout decision into Remotion-compatible keyframes.
 *
 * IMPORTANT: every emitted keyframe's crop is shaped so that
 *   (cropWidth × sourceWidth) / (cropHeight × sourceHeight) === zone aspect
 * — otherwise the preview's `objectFit: 'fill'` stretches the video and
 * everything looks vertically/horizontally compressed.
 */
export function detectionsToZoneKeyframes(
  detections: ReframeDetection[],
  layoutDecision: LayoutDecision,
  targetRatio: string,
  sourceWidth: number,
  sourceHeight: number
): ReframeZoneKeyframes[] {
  const zones: ReframeZoneKeyframes[] = [];

  // Parse target ratio (e.g. "9:16" → tw=9, th=16). Default to source if unparseable.
  const [twRaw, thRaw] = (targetRatio || '').split(':').map(Number);
  const tw = Number.isFinite(twRaw) && twRaw > 0 ? twRaw : sourceWidth;
  const th = Number.isFinite(thRaw) && thRaw > 0 ? thRaw : sourceHeight;

  const sW = sourceWidth > 0 ? sourceWidth : 1920;
  const sH = sourceHeight > 0 ? sourceHeight : 1080;
  const sourcePixelAspect = sW / sH;

  for (const zone of layoutDecision.zones) {
    // Zone aspect in target-canvas pixels.
    const zonePixelW = (zone.canvas_w || 1) * tw;
    const zonePixelH = (zone.canvas_h || 1) * th;
    const zonePixelAspect = zonePixelW / zonePixelH;

    // Aspect we need from the normalized source crop:
    //   (cropW × sW) / (cropH × sH) = zonePixelAspect
    //   → cropW / cropH = zonePixelAspect / sourcePixelAspect
    const desiredNormalizedRatio = zonePixelAspect / sourcePixelAspect;

    // Filter detections for persons in this zone
    const zoneDets = detections.filter(d => zone.person_ids.includes(d.person_id));

    // If no detections, fall back to the layout's static crop — but still aspect-fit.
    if (zoneDets.length === 0) {
      const fitted = fitCropToAspect(
        zone.crop_width || 0.5,
        zone.crop_height || 0.5,
        zone.crop_cx ?? 0.5,
        zone.crop_cy ?? 0.5,
        desiredNormalizedRatio
      );
      zones.push({
        zone_id: zone.zone_id,
        person_ids: zone.person_ids,
        canvas_top: zone.canvas_top,
        canvas_left: zone.canvas_left,
        canvas_w: zone.canvas_w,
        canvas_h: zone.canvas_h,
        keyframes: [{
          time: 0,
          cropLeft: parseFloat(fitted.cropLeft.toFixed(4)),
          cropTop: parseFloat(fitted.cropTop.toFixed(4)),
          cropWidth: parseFloat(fitted.cropWidth.toFixed(4)),
          cropHeight: parseFloat(fitted.cropHeight.toFixed(4)),
        }],
      });
      continue;
    }

    // Group detections by time
    const byTime = new Map<number, ReframeDetection[]>();
    for (const det of zoneDets) {
      const t = det.time;
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t)!.push(det);
    }

    const keyframes: ReframeKeyframe[] = [];

    for (const [time, dets] of byTime) {
      let minCx = Infinity, maxCx = -Infinity;
      let minCy = Infinity, maxCy = -Infinity;
      let maxW = 0, maxH = 0;

      for (const d of dets) {
        minCx = Math.min(minCx, d.bbox.cx);
        maxCx = Math.max(maxCx, d.bbox.cx);
        minCy = Math.min(minCy, d.bbox.cy);
        maxCy = Math.max(maxCy, d.bbox.cy);
        maxW = Math.max(maxW, d.bbox.width);
        maxH = Math.max(maxH, d.bbox.height);
      }

      const centerX = (minCx + maxCx) / 2;
      const centerY = (minCy + maxCy) / 2;

      // Initial crop covers the bounding rect of detections + 1.3× padding,
      // never smaller than the layout's hint.
      const initialW = Math.max(zone.crop_width, (maxCx - minCx) + maxW * 1.3);
      const initialH = Math.max(zone.crop_height, (maxCy - minCy) + maxH * 1.3);

      // Expand the smaller axis to make the aspect match the target zone.
      const fitted = fitCropToAspect(
        initialW,
        initialH,
        centerX,
        centerY,
        desiredNormalizedRatio
      );

      keyframes.push({
        time: parseFloat(time.toFixed(3)),
        cropLeft: parseFloat(fitted.cropLeft.toFixed(4)),
        cropTop: parseFloat(fitted.cropTop.toFixed(4)),
        cropWidth: parseFloat(fitted.cropWidth.toFixed(4)),
        cropHeight: parseFloat(fitted.cropHeight.toFixed(4)),
      });
    }

    keyframes.sort((a, b) => a.time - b.time);

    zones.push({
      zone_id: zone.zone_id,
      person_ids: zone.person_ids,
      canvas_top: zone.canvas_top,
      canvas_left: zone.canvas_left,
      canvas_w: zone.canvas_w,
      canvas_h: zone.canvas_h,
      keyframes,
    });
  }

  return zones;
}

// ============================================================================
// Inputs and layout safety (G4)
// ============================================================================

/**
 * Closest named ratio for the source video. 4:5 is checked before the generic
 * portrait case (it used to be classified as 9:16).
 */
export function detectSourceRatio(width: number, height: number): '16:9' | '1:1' | '4:5' | '9:16' {
  const ar = width > 0 && height > 0 ? width / height : 16 / 9;
  if (Math.abs(ar - 1) < 0.1) return '1:1';
  if (Math.abs(ar - 4 / 5) < 0.08) return '4:5';
  if (ar < 1) return '9:16';
  return '16:9';
}

/**
 * Frames between detection samples: about 300 samples per video, but never
 * denser than every 3rd frame or sparser than every 30th.
 */
export function sampleEveryFor(durationSeconds: number | undefined, fps = 30): number {
  const frames = (Number(durationSeconds) || 0) * fps;
  if (frames <= 0) return 3;
  return Math.max(3, Math.min(30, Math.round(frames / 300)));
}

const inUnit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** True if a layout from the reasoning model is usable (zones inside the frame and canvas). */
export function isValidLayout(layout: LayoutDecision | null | undefined): layout is LayoutDecision {
  if (!layout || !Array.isArray(layout.zones) || layout.zones.length === 0 || layout.zones.length > 4) return false;
  return layout.zones.every(
    (z) =>
      Array.isArray(z.person_ids) &&
      [z.crop_cx, z.crop_cy, z.crop_width, z.crop_height, z.canvas_top, z.canvas_left, z.canvas_w, z.canvas_h].every(inUnit) &&
      z.canvas_w > 0 &&
      z.canvas_h > 0 &&
      z.canvas_left + z.canvas_w <= 1.001 &&
      z.canvas_top + z.canvas_h <= 1.001
  );
}

/**
 * One full-canvas zone following the most-detected person (or the frame
 * centre if nobody was detected). Used when the model's layout is missing or
 * invalid, instead of failing the job or assuming tracker id 0 exists.
 */
export function fallbackLayout(detections: ReframeDetection[]): LayoutDecision {
  const counts = new Map<number, number>();
  for (const d of detections) counts.set(d.person_id, (counts.get(d.person_id) || 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    layout_type: 'single_fallback',
    reasoning: 'Fallback: following the most visible person.',
    confidence: 0,
    zones: [
      {
        zone_id: 'main',
        person_ids: main === undefined ? [] : [main],
        crop_cx: 0.5,
        crop_cy: 0.5,
        crop_width: 0.5,
        crop_height: 0.5,
        canvas_top: 0,
        canvas_left: 0,
        canvas_w: 1,
        canvas_h: 1,
      },
    ],
  };
}

/** A request that timed out: retrying would only time out again. */
export function isTimeout(error: any): boolean {
  return error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(error?.message || '');
}
