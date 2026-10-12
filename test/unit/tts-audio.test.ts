import { describe, expect, it } from 'vitest';
import { joinWavs, readWav, wavDuration } from '../../src/utils/wav';
import { wavToMp3 } from '../../src/utils/audioEncode';
import { splitScript } from '../../src/services/tts/sarvam';
import { encodeTestWav } from './wavFixture';

describe('joinWavs', () => {
  it('joins same-format WAVs into one with the summed length', () => {
    const joined = joinWavs([encodeTestWav(1), encodeTestWav(0.5)]);
    expect(wavDuration(joined)).toBeCloseTo(1.5, 3);
    expect(joined.readUInt32LE(4)).toBe(joined.length - 8);
    expect(readWav(joined).format.readUInt32LE(4)).toBe(44100);
  });

  it('refuses different formats and non-WAV input', () => {
    expect(() => joinWavs([encodeTestWav(1, 44100), encodeTestWav(1, 22050)])).toThrow(/different formats/);
    expect(() => readWav(Buffer.from('ID3 not a wav'))).toThrow(/Not a WAV/);
  });

  it('reads a data chunk whose size was left unknown by a stream', () => {
    const wav = encodeTestWav(1);
    wav.writeUInt32LE(0xffffffff, 40);
    expect(wavDuration(wav)).toBeCloseTo(1, 3);
  });
});

describe('wavToMp3', () => {
  it('encodes with ffmpeg', async () => {
    const mp3 = await wavToMp3(encodeTestWav(2));
    // MPEG frame sync or an ID3 tag
    expect(mp3[0] === 0xff || mp3.subarray(0, 3).toString() === 'ID3').toBe(true);
    expect(mp3.length).toBeLessThan(encodeTestWav(2).length / 4);
  });
});

describe('splitScript', () => {
  it('keeps short scripts whole', () => {
    expect(splitScript('  Hello there.  ', 100)).toEqual(['Hello there.']);
  });

  it('splits at sentence ends, including Devanagari full stops', () => {
    const parts = splitScript('पहला वाक्य है। दूसरा वाक्य है। तीसरा वाक्य है।', 30);
    expect(parts.every((p) => p.length <= 30)).toBe(true);
    expect(parts.every((p) => p.endsWith('।'))).toBe(true);
    expect(parts.join(' ')).toBe('पहला वाक्य है। दूसरा वाक्य है। तीसरा वाक्य है।');
  });

  it('falls back to spaces, then to a hard cut', () => {
    const words = splitScript('one two three four five six seven eight nine ten', 12);
    expect(words.every((p) => p.length <= 12)).toBe(true);
    expect(words.join(' ')).toBe('one two three four five six seven eight nine ten');
    expect(splitScript('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});
