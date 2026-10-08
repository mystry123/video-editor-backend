import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { RenderJob } from '../src/models/RenderJob';
import { CaptionProject } from '../src/models/Caption';
import { User } from '../src/models/User';
import { UsageCounter, UsageEntry } from '../src/models/Usage';
import { currentPeriod, getMonthlyTotal, releaseUsage, reserveUsage, settleUsage } from '../src/services/usage.service';
import { runMaintenanceSweep } from '../src/services/maintenance.service';

const id = () => String(new Types.ObjectId());

async function setLimit(userId: unknown, field: string, value: number) {
  await User.updateOne({ _id: userId }, { $push: { planOverrides: { field, value } } });
}

describe('usage ledger', () => {
  it('reserves within the limit and refuses past it with the quota code', async () => {
    const { user } = await createUser();
    await reserveUsage(user._id, 'renderMinutes', id(), 90, 2); // 1.5 of 2 min
    await expect(reserveUsage(user._id, 'renderMinutes', id(), 60, 2)).rejects.toMatchObject({
      statusCode: 403,
      code: 'RENDER_MINUTES_EXCEEDED',
    });
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(90);
  });

  it('is idempotent per job: reserve, settle and release never double-count', async () => {
    const { user } = await createUser();
    const job = id();
    await reserveUsage(user._id, 'renderMinutes', job, 60, -1);
    await reserveUsage(user._id, 'renderMinutes', job, 60, -1);
    await settleUsage(user._id, 'renderMinutes', job, 45);
    await settleUsage(user._id, 'renderMinutes', job, 45);
    await releaseUsage('renderMinutes', job, 'late');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(45);
    expect(await UsageEntry.countDocuments({ jobId: job })).toBe(1);
  });

  it('refunds a released reservation and lets the job reserve again', async () => {
    const { user } = await createUser();
    const job = id();
    await reserveUsage(user._id, 'transcriptionMinutes', job, 120, 5);
    await releaseUsage('transcriptionMinutes', job, 'failed');
    expect(await getMonthlyTotal(String(user._id), 'transcriptionMinutes')).toBe(0);
    await reserveUsage(user._id, 'transcriptionMinutes', job, 120, 5);
    expect(await getMonthlyTotal(String(user._id), 'transcriptionMinutes')).toBe(120);
  });

  it("parallel requests can't overshoot the limit", async () => {
    const { user } = await createUser();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveUsage(user._id, 'renderMinutes', id(), 30, 1))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(60);
  });

  it("starts the month from the old counter so this month's usage isn't forgiven", async () => {
    const { user } = await createUser();
    await User.updateOne({ _id: user._id }, { 'quotaUsage.renderMinutesUsed': 3, 'quotaUsage.lastReset': new Date() });
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(180);
    // Reading doesn't create the counter; the first charge does, from the same seed.
    expect(await UsageCounter.countDocuments({ userId: user._id })).toBe(0);
    await reserveUsage(user._id, 'renderMinutes', id(), 60, -1);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(240);
  });

  it('charges a job that started before the ledger directly, once', async () => {
    const { user } = await createUser();
    const job = id();
    await settleUsage(user._id, 'renderMinutes', job, 30);
    await settleUsage(user._id, 'renderMinutes', job, 30);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });
});

describe('render metering', () => {
  async function template(userId: unknown, duration: number) {
    return Template.create({ userId, name: 'T', data: { project: { fps: 30, outputFormat: 'mp4', width: 1280, height: 720, duration }, elements: [] } });
  }

  it('reserves at start, refuses once the month is used up, and refunds on cancel', async () => {
    const { user, auth } = await createUser();
    await setLimit(user._id, 'maxRenderMinutes', 1);
    const t = await template(user._id, 40);

    const first = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(first.status).toBe(202);
    const second = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('RENDER_MINUTES_EXCEEDED');

    const cancel = await api().post(`/api/v1/render/${first.body.id}/cancel`).set(auth);
    expect(cancel.status).toBeLessThan(300);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
    expect((await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) })).status).toBe(202);
  });
});

describe('maintenance: usage reconciliation', () => {
  it('refunds reservations whose job failed and charges ones that completed', async () => {
    const { user } = await createUser();
    const failed = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'failed' });
    const done = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'completed' });
    await reserveUsage(user._id, 'renderMinutes', String(failed._id), 60, -1);
    await reserveUsage(user._id, 'renderMinutes', String(done._id), 30, -1);
    await UsageEntry.collection.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 60 * 60_000) } });

    const counts = await runMaintenanceSweep();
    expect(counts).toMatchObject({ reservationsReleased: 1, reservationsSettled: 1 });
    const counter = await UsageCounter.findOne({ userId: user._id, kind: 'renderMinutes', period: currentPeriod() });
    expect(counter!.total).toBe(30);
  });

  it('refunds caption exports and minutes of a failed caption project', async () => {
    const { user } = await createUser();
    const project = await CaptionProject.create({ userId: user._id, fileId: new Types.ObjectId(), name: 'c', status: 'failed' });
    await reserveUsage(user._id, 'captionExports', `caption-export-${project._id}`, 1, 3);
    await reserveUsage(user._id, 'captionRenderMinutes', `caption-render-${project._id}`, 30, 5);
    await UsageEntry.collection.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 60 * 60_000) } });

    await runMaintenanceSweep();
    expect(await getMonthlyTotal(String(user._id), 'captionExports')).toBe(0);
    expect(await getMonthlyTotal(String(user._id), 'captionRenderMinutes')).toBe(0);
  });
});
