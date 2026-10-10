import { describe, expect, it } from 'vitest';
import { parseCaptionStyle } from '../../src/schemas/captionStyle';

// The caption animations the editor offers (keep in step with the
// frontend's captionStyleSchema): a style using one must save.
describe('caption style animations', () => {
  it.each(['caption-word-blur-in', 'caption-word-stomp', 'caption-word-tilt', 'caption-word-glow'])('accepts word animation %s', (type) => {
    expect(parseCaptionStyle({ wordAnimation: { type, duration: 0.3, params: { color: '#FFE066', size: '14px' } } }).ok).toBe(true);
  });

  it.each(['caption-page-rise', 'caption-page-zoom-punch', 'caption-page-reveal', 'caption-page-flip-3d', 'caption-page-drift'])('accepts page animation %s', (type) => {
    expect(parseCaptionStyle({ pageEnter: { type, duration: 0.4 }, pageExit: { type, category: 'exit', duration: 0.4 } }).ok).toBe(true);
  });

  it('still refuses unknown ones', () => {
    expect(parseCaptionStyle({ wordAnimation: { type: 'caption-word-explode', duration: 0.3 } }).ok).toBe(false);
  });
});
