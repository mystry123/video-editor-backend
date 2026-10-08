// utils/renderDimensions.ts
//
// Resolution tiers are defined by the frame's SHORT side, so a vertical
// 1080x1920 video is "1080p" (not "1920p") and gets the same plan treatment
// as a horizontal 1920x1080 one.

const SHORT_SIDE_BY_TIER: Record<string, number> = {
  '720p': 720,
  '1080p': 1080,
  '4k': 2160,
};

export function resolutionTier(width: number, height: number): string {
  const shortSide = Math.min(width, height);
  if (shortSide <= 720) return '720p';
  if (shortSide <= 1080) return '1080p';
  return '4k';
}

/**
 * Remotion `scale` factor that brings the frame down to the plan's maximum
 * tier. Returns 1 when no downscale is needed or the inputs are unusable.
 * Remotion rounds the scaled dimensions and evens them out for h264 itself.
 */
export function downscaleFactor(width: number, height: number, maxTier: string): number {
  const shortSide = Math.min(width, height);
  const maxShortSide = SHORT_SIDE_BY_TIER[maxTier];
  if (!shortSide || !maxShortSide || shortSide <= maxShortSide) return 1;
  return maxShortSide / shortSide;
}

export interface RenderOutputPlan {
  /** Tier of the rendered file, after any downscale. */
  resolution: string;
  scale: number;
  downscaled: boolean;
}

export function planRenderOutput(width: number, height: number, maxTier: string): RenderOutputPlan {
  const scale = downscaleFactor(width, height, maxTier);
  return {
    resolution: resolutionTier(Math.round(width * scale), Math.round(height * scale)),
    scale,
    downscaled: scale < 1,
  };
}
