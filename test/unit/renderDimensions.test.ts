import { describe, expect, it } from 'vitest';
import { downscaleFactor, planRenderOutput, resolutionTier } from '../../src/utils/renderDimensions';

describe('resolutionTier', () => {
  it('uses the short side, so vertical video is classed like horizontal', () => {
    expect(resolutionTier(1920, 1080)).toBe('1080p');
    expect(resolutionTier(1080, 1920)).toBe('1080p');
    expect(resolutionTier(1280, 720)).toBe('720p');
    expect(resolutionTier(3840, 2160)).toBe('4k');
  });
});

describe('planRenderOutput', () => {
  it('downscales a 1080p project to a 720p plan', () => {
    const out = planRenderOutput(1080, 1920, '720p');
    expect(out.downscaled).toBe(true);
    expect(out.resolution).toBe('720p');
    expect(Math.round(1080 * out.scale)).toBe(720);
    expect(Math.round(1920 * out.scale)).toBe(1280);
  });

  it('leaves projects within the plan untouched', () => {
    expect(planRenderOutput(1280, 720, '720p')).toEqual({ resolution: '720p', scale: 1, downscaled: false });
    expect(planRenderOutput(1080, 1920, '4k').scale).toBe(1);
  });

  it('never upscales and tolerates bad input', () => {
    expect(downscaleFactor(640, 360, '1080p')).toBe(1);
    expect(downscaleFactor(0, 0, '720p')).toBe(1);
    expect(downscaleFactor(1920, 1080, 'unknown')).toBe(1);
  });
});
