// services/tts/alignment.ts
//
// Word timings from a character alignment (ElevenLabs returns one with the
// speech), in the shape transcriptions use, so captions for generated speech
// need no transcription at all.

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'spacing';
}

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Words (with their punctuation) and the spaces between them, in seconds. */
export function wordsFromAlignment(alignment: CharacterAlignment | null | undefined): TimedWord[] {
  const chars = alignment?.characters ?? [];
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  const out: TimedWord[] = [];
  let i = 0;
  while (i < chars.length) {
    const space = /\s/.test(chars[i]);
    let j = i;
    while (j < chars.length && /\s/.test(chars[j]) === space) j++;
    const start = Number(starts[i]) || 0;
    const end = Number(ends[j - 1]) || start;
    if (space) {
      if (out.length) out.push({ text: ' ', start, end, type: 'spacing' });
    } else {
      out.push({ text: chars.slice(i, j).join(''), start, end, type: 'word' });
    }
    i = j;
  }
  // No trailing space
  while (out.length && out[out.length - 1].type === 'spacing') out.pop();
  return out;
}
