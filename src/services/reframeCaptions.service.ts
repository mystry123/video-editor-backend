/**
 * Shotline captions for a reframe whose burned-in captions were replaced.
 *
 * The reframe engine leaves the source's captions out of the framing in some
 * shots and lists those time ranges (result.captions.replaced). Each range
 * becomes one caption element built from the file's transcript, so new
 * captions appear exactly where the old ones were cropped away and never
 * on top of shots that kept them.
 */

export interface TranscriptWord {
  text?: string;
  start?: number;   // seconds
  end?: number;
  type?: 'word' | 'spacing' | 'punctuation';
}

interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

/** Words with punctuation attached to the word before it, in seconds. */
export function captionWords(words: TranscriptWord[]): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const w of words) {
    const text = (w.text || '').trim();
    if (!text || w.type === 'spacing' || typeof w.start !== 'number' || typeof w.end !== 'number') continue;
    if (w.type === 'punctuation') {
      if (out.length) {
        out[out.length - 1].word += text;
        out[out.length - 1].end = Math.max(out[out.length - 1].end, w.end);
      }
      continue;
    }
    out.push({ word: text, start: w.start, end: w.end });
  }
  return out;
}

/**
 * One caption element per replaced range. A word belongs to the range its
 * midpoint falls in; word times are relative to the element's start (the
 * caption element counts time from its own start).
 */
export function replacementCaptionElements(
  words: TranscriptWord[],
  ranges: [number, number][],
  outputAspect: number
): Record<string, unknown>[] {
  const all = captionWords(words);
  const landscape = outputAspect >= 1.2;
  const elements: Record<string, unknown>[] = [];
  ranges.forEach(([start, end], i) => {
    const inside = all.filter((w) => (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 < end);
    if (!inside.length) return;
    const timed: CaptionWord[] = inside.map((w) => ({
      word: w.word,
      startMs: Math.max(0, Math.round((w.start - start) * 1000)),
      endMs: Math.max(0, Math.round((Math.min(w.end, end) - start) * 1000)),
    }));
    elements.push({
      id: `reframe-captions-${i}`,
      type: 'caption',
      time: start,
      duration: Math.max(0.1, end - start),
      track: 2,
      visible: true,
      opacity: 1,
      // Lower third of the new frame; wider lines on landscape outputs.
      x: '50%',
      y: landscape ? '86%' : '78%',
      anchorX: '50%',
      anchorY: '50%',
      width: landscape ? '80%' : '88%',
      height: '20%',
      transcription: { words: timed },
      text: timed.map((w) => w.word).join(' '),
      displayMode: 'tiktok',
      wordsPerLine: landscape ? 6 : 4,
      linesPerPage: 1,
      fontFamily: 'Inter',
      fontWeight: 800,
      fontSize: landscape ? 54 : 64,
      fillColor: '#FFFFFF',
      highlightStyle: 'color',
      highlightColor: '#FFE14D',
      inactiveColor: '#FFFFFF',
      inactiveOpacity: 1,
      strokeColor: '#000000',
      strokeWidth: 4,
    });
  });
  return elements;
}
