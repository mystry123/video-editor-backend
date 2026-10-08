import { describe, expect, it } from 'vitest';
import { captionWords, replacementCaptionElements } from '../src/services/reframeCaptions.service';

const words = [
  { text: 'The', start: 1.0, end: 1.2, type: 'word' as const },
  { text: ' ', start: 1.2, end: 1.25, type: 'spacing' as const },
  { text: 'best', start: 1.25, end: 1.6, type: 'word' as const },
  { text: ',', start: 1.6, end: 1.6, type: 'punctuation' as const },
  { text: 'way', start: 2.4, end: 2.7, type: 'word' as const },
  { text: 'is', start: 6.1, end: 6.3, type: 'word' as const },
  { text: 'here', start: 9.0, end: 9.4, type: 'word' as const },
];

describe('replacement captions for a reframe', () => {
  it('joins punctuation to the word before it and drops spacing', () => {
    expect(captionWords(words).map((w) => w.word)).toEqual(['The', 'best,', 'way', 'is', 'here']);
  });

  it('makes one caption element per replaced range, timed from the range start', () => {
    const els = replacementCaptionElements(words, [[1, 3], [6, 7]], 16 / 9);
    expect(els).toHaveLength(2);
    const [first, second] = els as any[];
    expect(first).toMatchObject({ type: 'caption', time: 1, duration: 2, y: '86%' });
    expect(first.transcription.words).toEqual([
      { word: 'The', startMs: 0, endMs: 200 },
      { word: 'best,', startMs: 250, endMs: 600 },
      { word: 'way', startMs: 1400, endMs: 1700 },
    ]);
    expect(second.transcription.words.map((w: any) => w.word)).toEqual(['is']);
  });

  it('adds nothing for ranges without speech, and never outside the ranges', () => {
    const els = replacementCaptionElements(words, [[3, 5]], 16 / 9);
    expect(els).toHaveLength(0);
  });

  it('places captions higher and shorter lines on tall outputs', () => {
    const [el] = replacementCaptionElements(words, [[0, 10]], 9 / 16) as any[];
    expect(el).toMatchObject({ y: '78%', wordsPerLine: 4 });
  });
});
