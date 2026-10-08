import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { api, createUser } from './helpers';
import { Transcription } from '../src/models/Transcription';

async function transcription(userId: unknown, extra: Record<string, unknown> = {}) {
  return Transcription.create({ userId, fileId: new Types.ObjectId(), status: 'completed', duration: 10, ...extra });
}

const patch = (auth: Record<string, string>, id: unknown, words: unknown[]) =>
  api().patch(`/api/v1/transcriptions/${id}/words`).set(auth).send({ words });

describe('PATCH /transcriptions/:id/words', () => {
  it('marks the transcript edited, keeps speakers and trims small overlaps', async () => {
    const { user, auth } = await createUser();
    const t = await transcription(user._id, { error: 'old failure' });
    const res = await patch(auth, t._id, [
      { text: 'hi', start: 0, end: 0.6, speaker_id: 's1' },
      { text: 'there', start: 0.5, end: 1 },
    ]);
    expect(res.status).toBe(200);
    const saved = await Transcription.findById(t._id).lean();
    expect(saved!.isEdited).toBe(true);
    expect(saved!.error).toBeUndefined();
    expect(saved!.words![0]).toMatchObject({ speaker_id: 's1', end: 0.5 });
    expect(saved!.text).toBe('hi there');
  });

  it('rejects words out of order or past the end of the media', async () => {
    const { user, auth } = await createUser();
    const t = await transcription(user._id);
    const unordered = await patch(auth, t._id, [{ text: 'b', start: 2, end: 3 }, { text: 'a', start: 1, end: 2 }]);
    expect(unordered.status).toBe(422);
    expect(unordered.body.code).toBe('INVALID_WORD_TIMING');
    const late = await patch(auth, t._id, [{ text: 'a', start: 30, end: 31 }]);
    expect(late.status).toBe(422);
  });

  it('says when an edit was kept over a running transcription', async () => {
    const { user, auth } = await createUser();
    const t = await transcription(user._id, { status: 'processing' });
    const res = await patch(auth, t._id, [{ text: 'mine', start: 0, end: 1 }]);
    expect(res.body.keptOverRunningTranscription).toBe(true);
    expect((await Transcription.findById(t._id))!.status).toBe('completed');
  });
});
