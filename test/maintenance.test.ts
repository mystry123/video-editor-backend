import { describe, expect, it, vi } from 'vitest';
import { runMaintenanceSweep } from '../src/services/maintenance.service';
import { RenderJob } from '../src/models/RenderJob';
import { Transcription } from '../src/models/Transcription';
import { CaptionProject } from '../src/models/Caption';
import { File } from '../src/models/File';
import { getRenderQueue } from '../src/queues';
import { createUser } from './helpers';

vi.mock('../src/services/storage.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage.service')>();
  return { ...actual, deleteFromS3: vi.fn().mockResolvedValue(undefined) };
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** Writes timestamps directly (Mongoose would refresh updatedAt). */
async function age(model: any, id: unknown, fields: Record<string, Date>) {
  await model.collection.updateOne({ _id: id }, { $set: fields });
}

describe('maintenance sweep', () => {
  it('re-queues renders whose queue job was lost', async () => {
    const { user } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'pending' });
    await age(RenderJob, job._id, { updatedAt: minutesAgo(5) });

    const counts = await runMaintenanceSweep();
    expect(counts.rendersRequeued).toBe(1);
    expect(getRenderQueue().add).toHaveBeenCalledWith('render', { jobId: String(job._id) }, { jobId: `render-${job._id}` });
  });

  it('resumes a recent render whose poller died, and fails an old one', async () => {
    const { user } = await createUser();
    const resumable = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering', renderId: 'r1', startedAt: minutesAgo(30) });
    const dead = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering', startedAt: minutesAgo(30) });
    await age(RenderJob, resumable._id, { updatedAt: minutesAgo(20) });
    await age(RenderJob, dead._id, { updatedAt: minutesAgo(20) });

    const counts = await runMaintenanceSweep();
    expect(counts.rendersResumed).toBe(1);
    expect(counts.rendersFailed).toBe(1);
    expect((await RenderJob.findById(dead._id))!.status).toBe('failed');
    expect((await RenderJob.findById(resumable._id))!.status).toBe('rendering');
  });

  it('leaves work alone while its queue job is still running', async () => {
    const { user } = await createUser();
    const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering', startedAt: minutesAgo(30) });
    await age(RenderJob, job._id, { updatedAt: minutesAgo(20) });
    (getRenderQueue().getJob as any).mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue('active') });

    await runMaintenanceSweep();
    expect((await RenderJob.findById(job._id))!.status).toBe('rendering');
  });

  it('fails stuck transcriptions, captions and reframes', async () => {
    const { user } = await createUser();
    const file = await File.create({
      userId: user._id, name: 'v.mp4', originalName: 'v.mp4', mimeType: 'video/mp4', size: 1,
      storageKey: 'k', cdnUrl: 'https://cdn.test/k', status: 'ready',
      reframe: { '9_16': { status: 'processing' } },
    });
    const transcription = await Transcription.create({ userId: user._id, fileId: file._id, status: 'processing' });
    const caption = await CaptionProject.create({ userId: user._id, fileId: file._id, name: 'c', status: 'rendering' });
    await age(Transcription, transcription._id, { updatedAt: minutesAgo(20) });
    await age(CaptionProject, caption._id, { updatedAt: minutesAgo(20) });
    await age(File, file._id, { updatedAt: minutesAgo(20) });

    await runMaintenanceSweep();
    expect((await Transcription.findById(transcription._id))!.status).toBe('failed');
    expect((await CaptionProject.findById(caption._id))!.status).toBe('failed');
    const reframe: any = (await File.findById(file._id).lean())!.reframe;
    expect(reframe['9_16'].status).toBe('failed');
  });

  it('removes uploads that were never completed', async () => {
    const { user } = await createUser();
    const abandoned = await File.create({ userId: user._id, name: 'a', originalName: 'a', mimeType: 'video/mp4', size: 1, storageKey: 'k1', cdnUrl: 'https://cdn.test/k1', status: 'processing', source: 'upload' });
    const fresh = await File.create({ userId: user._id, name: 'b', originalName: 'b', mimeType: 'video/mp4', size: 1, storageKey: 'k2', cdnUrl: 'https://cdn.test/k2', status: 'processing', source: 'upload' });
    await age(File, abandoned._id, { createdAt: minutesAgo(180), updatedAt: minutesAgo(180) });

    const counts = await runMaintenanceSweep();
    expect(counts.abandonedUploadsRemoved).toBe(1);
    expect(await File.exists({ _id: abandoned._id })).toBeNull();
    expect(await File.exists({ _id: fresh._id })).toBeTruthy();
  });

  it('does nothing when everything is healthy', async () => {
    expect(await runMaintenanceSweep()).toEqual({});
  });
});
