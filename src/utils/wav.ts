// utils/wav.ts
//
// Joining WAV files: text-to-speech providers that cap the text per request
// return one WAV per chunk; these become one recording.

export interface WavParts {
  /** The 16-byte "fmt " chunk body: channels, sample rate, bit depth */
  format: Buffer;
  data: Buffer;
}

/** The format and sample data of a PCM WAV file. */
export function readWav(file: Buffer): WavParts {
  if (file.length < 12 || file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let format: Buffer | null = null;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    let size = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Streamed WAVs can leave the data size unknown (0 or 0xFFFFFFFF): it runs to the end
    if (id === 'data' && (size === 0 || size === 0xffffffff || start + size > file.length)) size = file.length - start;
    if (id === 'fmt ') format = file.subarray(start, start + size);
    if (id === 'data') data = file.subarray(start, start + size);
    offset = start + size + (size % 2); // chunks are word-aligned
  }
  if (!format || !data) throw new Error('WAV file has no format or data');
  return { format, data };
}

/** One WAV from several with the same format, back to back. */
export function joinWavs(files: Buffer[]): Buffer {
  if (files.length === 0) throw new Error('No audio to join');
  const parts = files.map(readWav);
  const format = parts[0].format;
  for (const part of parts) {
    if (!part.format.subarray(0, 16).equals(format.subarray(0, 16))) throw new Error('WAV files have different formats');
  }
  const dataSize = parts.reduce((sum, p) => sum + p.data.length, 0);
  const header = Buffer.alloc(12 + 8 + format.length + 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(header.length - 8 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(format.length, 16);
  format.copy(header, 20);
  header.write('data', 20 + format.length, 'ascii');
  header.writeUInt32LE(dataSize, 24 + format.length);
  return Buffer.concat([header, ...parts.map((p) => p.data)]);
}

/** Length in seconds of a PCM WAV. */
export function wavDuration(file: Buffer): number {
  const { format, data } = readWav(file);
  const byteRate = format.readUInt32LE(8);
  return byteRate > 0 ? data.length / byteRate : 0;
}
