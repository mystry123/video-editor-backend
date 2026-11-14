// RENDER_PROVIDER=lambda: the worker starts renders on Remotion Lambda and
// either polls or waits for Remotion's signed webhook; outcomes go through
// the lifecycle service (charge, refund, deadline, cancel, private outputs).
// Remotion's Lambda calls are faked; its webhook signature check is real.
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { api, createUser } from './helpers';
import { RenderJob } from '../src/models/RenderJob';
import { env } from '../src/config/env';
import { setS3Clients } from '../src/config/aws';
import { getMonthlyTotal, reserveUsage } from '../src/services/usage.service';
import { checkRender, RENDER_DEADLINE_MS } from '../src/services/renderLifecycle.service';
import { presignOutput } from '../src/services/renderOutput.service';

const lambda = vi.hoisted(() => ({
  renderMediaOnLambda: vi.fn(),
  getRenderProgress: vi.fn(),
  deleteRender: vi.fn(),
}));
vi.mock('@remotion/lambda-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@remotion/lambda-client')>();
  return { ...actual, ...lambda };
});
vi.mock('../src/utils/worker.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/worker.utils')>();
  // No real waits in tests (polling, start retries).
  return {
    ...actual,
    createWorker: vi.fn(() => ({})),
    sleep: vi.fn(async () => undefined),
    retryWithBackoff: (fn: () => Promise<unknown>, opts: { maxRetries?: number } = {}) =>
      actual.retryWithBackoff(fn, { ...opts, initialDelay: 1, maxDelay: 1 }),
  };
});
vi.mock('../src/services/thumbnail.service', () => ({
  generateThumbnailFromVideo: vi.fn().mockResolvedValue({ success: false }),
}));

const { processRenderJob } = await import('../src/workers/render.worker');
const { purgeUserData } = await import('../src/services/accountCleanup.service');

const BUCKET = 'remotionlambda-useast1-test';
const SECRET = 'remotion-webhook-secret-for-tests';
const outputOf = (userId: unknown, jobId: unknown) => `https://${BUCKET}.s3.us-east-1.amazonaws.com/renders/${userId}/${jobId}.mp4`;

const saved = { ...env };
let s3Send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(env, {
    renderProvider: 'lambda',
    awsRegion: 'us-east-1',
    remotionFunctionName: 'remotion-render-test',
    remotionBucket: BUCKET,
    remotionServeUrl: `https://${BUCKET}.s3.us-east-1.amazonaws.com/sites/shotline/index.html`,
    remotionWebhookUrl: '',
    remotionWebhookSecret: '',
  });
  lambda.renderMediaOnLambda.mockResolvedValue({ renderId: 'lambda-render-1', bucketName: BUCKET });
  lambda.deleteRender.mockResolvedValue(undefined);
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' } });
  s3Send = vi.fn(async () => ({}));
  (client as any).send = s3Send;
  setS3Clients({ app: client });
});
afterEach(() => {
  Object.assign(env, saved);
  setS3Clients(null);
  vi.mocked(lambda.renderMediaOnLambda).mockReset();
  vi.mocked(lambda.getRenderProgress).mockReset();
});

const webhookOn = () => Object.assign(env, { remotionWebhookUrl: 'https://api.test/api/v1/webhooks/remotion', remotionWebhookSecret: SECRET });

async function queuedJob(extra: Record<string, unknown> = {}) {
  const { user } = await createUser();
  const job = await RenderJob.create({
    userId: user._id,
    inputProps: { project: { duration: 30, fps: 30, width: 1080, height: 1920 }, elements: [{ id: 'e1' }] },
    outputFormat: 'mp4',
    status: 'queued',
    ...extra,
  });
  await reserveUsage(user._id, 'renderMinutes', String(job._id), 30, -1);
  return { user, job };
}

const run = (jobId: unknown, attemptsMade = 0) => processRenderJob({ data: { jobId: String(jobId) }, attemptsMade, opts: { attempts: 3 } } as any);

function sign(body: unknown) {
  return `sha512=${crypto.createHmac('sha512', SECRET).update(JSON.stringify(body)).digest('hex')}`;
}
const postWebhook = (body: any, signature = sign(body)) =>
  api().post('/api/v1/webhooks/remotion').set('X-Remotion-Signature', signature).send(body);

describe('Lambda renders (poll mode)', () => {
  it('starts the render privately in REMOTION_BUCKET, polls it to the end, completes and charges it', async () => {
    const { user, job } = await queuedJob();
    lambda.getRenderProgress
      .mockResolvedValueOnce({ done: false, overallProgress: 0.5, framesRendered: 450 })
      .mockResolvedValueOnce({ done: true, overallProgress: 1, outputFile: outputOf(user._id, job._id), costs: { accruedSoFar: 0.01, displayCost: '$0.01', currency: 'USD' } });

    expect(await run(job._id)).toEqual({ ended: 'completed' });

    const input = lambda.renderMediaOnLambda.mock.calls[0][0];
    expect(input).toMatchObject({
      region: 'us-east-1',
      functionName: 'remotion-render-test',
      composition: 'VideoEditor',
      codec: 'h264',
      privacy: 'private',
      forceBucketName: BUCKET,
      outName: `renders/${user._id}/${job._id}.mp4`,
      inputProps: { projectSettings: { duration: 30 }, elements: [{ id: 'e1' }] },
      concurrency: 8, // 900 frames would need 15 Lambdas; REMOTION_MAX_LAMBDAS is 8
      pixelFormat: 'yuv420p',
    });
    expect(input.webhook).toBeUndefined();

    const done = await RenderJob.findById(job._id).select('+outputBucket +outputKey +bucketName');
    expect(done).toMatchObject({ status: 'completed', progress: 100, renderId: 'lambda-render-1', bucketName: BUCKET, outputBucket: BUCKET, outputKey: `renders/${user._id}/${job._id}.mp4` });
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });

  it('signs the private Lambda output from REMOTION_BUCKET', async () => {
    const outputUrl = outputOf('u', 'lambda-sign-1');
    const url = new URL((await presignOutput({ _id: 'lambda-sign-1', outputUrl, outputFormat: 'mp4' }, { download: true }))!);
    expect(url.host).toBe(`${BUCKET}.s3.us-east-1.amazonaws.com`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="shotline-lambda-sign-1.mp4"');
  });

  it('fails a fatal Lambda error with a safe message and refunds it', async () => {
    const { user, job } = await queuedJob();
    lambda.getRenderProgress.mockResolvedValue({
      done: false,
      overallProgress: 0.2,
      fatalErrorEncountered: true,
      errors: [{ isFatal: true, message: 'arn:aws:lambda:us-east-1:123:function failed: font could not be loaded' }],
    });

    expect(await run(job._id)).toEqual({ ended: 'failed' });
    const failed = await RenderJob.findById(job._id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).not.toMatch(/arn:aws/);
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('stops polling when the job is cancelled; a late finish is not charged and its file is deleted', async () => {
    const { user, job } = await queuedJob();
    lambda.getRenderProgress.mockImplementation(async () => {
      await RenderJob.updateOne({ _id: job._id }, { status: 'cancelled' });
      return { done: false, overallProgress: 0.3 };
    });
    expect(await run(job._id)).toEqual({ ended: 'cancelled' });

    // Webhook mode would still tell us the render finished: nothing is charged, the file goes.
    webhookOn();
    const body = { type: 'success', renderId: 'lambda-render-1', bucketName: BUCKET, customData: { jobId: String(job._id) }, outputUrl: outputOf(user._id, job._id) };
    expect((await postWebhook(body)).status).toBe(200);
    expect((await RenderJob.findById(job._id))!.status).toBe('cancelled');
    expect(s3Send.mock.calls.map(([cmd]: any[]) => [cmd.constructor.name, cmd.input])).toContainEqual([
      'DeleteObjectCommand',
      { Bucket: BUCKET, Key: `renders/${user._id}/${job._id}.mp4` },
    ]);
  });

  it('retries a failed start, then fails and refunds on the last attempt', async () => {
    const { user, job } = await queuedJob();
    lambda.renderMediaOnLambda.mockRejectedValue(new Error('AWS Concurrency limit reached'));
    await expect(run(job._id, 2)).rejects.toThrow('Concurrency');
    expect(lambda.renderMediaOnLambda).toHaveBeenCalledTimes(3);
    expect((await RenderJob.findById(job._id))!.status).toBe('failed');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('resumes polling a render that already started instead of starting it again', async () => {
    const { user, job } = await queuedJob({ status: 'rendering', renderId: 'lambda-render-9', bucketName: BUCKET, startedAt: new Date() });
    lambda.getRenderProgress.mockResolvedValue({ done: true, overallProgress: 1, outputFile: outputOf(user._id, job._id) });
    expect(await run(job._id)).toEqual({ ended: 'completed' });
    expect(lambda.renderMediaOnLambda).not.toHaveBeenCalled();
    expect(lambda.getRenderProgress.mock.calls[0][0]).toMatchObject({ renderId: 'lambda-render-9', bucketName: BUCKET });
  });
});

describe('Lambda renders (webhook mode)', () => {
  it('only starts the render, with the signed webhook and the job id', async () => {
    webhookOn();
    const { job } = await queuedJob();
    expect(await run(job._id)).toEqual({ started: true });
    expect(lambda.renderMediaOnLambda.mock.calls[0][0].webhook).toEqual({
      url: 'https://api.test/api/v1/webhooks/remotion',
      secret: SECRET,
      customData: { jobId: String(job._id) },
    });
    expect(lambda.getRenderProgress).not.toHaveBeenCalled();
    expect((await RenderJob.findById(job._id))!.status).toBe('rendering');
  });

  it('completes and charges a render from a correctly signed success webhook, once', async () => {
    webhookOn();
    const { user, job } = await queuedJob({ status: 'rendering', renderId: 'lambda-render-1', startedAt: new Date() });
    const body = { type: 'success', renderId: 'lambda-render-1', bucketName: BUCKET, customData: { jobId: String(job._id) }, outputUrl: outputOf(user._id, job._id), timeToFinish: 12000 };

    expect((await postWebhook(body)).body).toEqual({ received: true });
    expect((await postWebhook(body)).status).toBe(200); // duplicate: a no-op
    const done = await RenderJob.findById(job._id);
    expect(done).toMatchObject({ status: 'completed', outputUrl: body.outputUrl });
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });

  it('rejects bad signatures, mismatched render ids and outputs outside our storage', async () => {
    webhookOn();
    const { user, job } = await queuedJob({ status: 'rendering', renderId: 'lambda-render-1', startedAt: new Date() });
    const body = { type: 'success', renderId: 'lambda-render-1', bucketName: BUCKET, customData: { jobId: String(job._id) }, outputUrl: outputOf(user._id, job._id) };

    expect((await postWebhook(body, 'sha512=forged')).status).toBe(401);
    expect((await api().post('/api/v1/webhooks/remotion').send(body)).status).toBe(401);
    expect((await postWebhook({ ...body, renderId: 'someone-elses' })).status).toBe(409);
    expect((await postWebhook({ ...body, outputUrl: 'https://evil.s3.us-east-1.amazonaws.com/x.mp4' })).status).toBe(400);
    expect((await RenderJob.findById(job._id))!.status).toBe('rendering');
  });

  it('fails and refunds on error and timeout webhooks', async () => {
    webhookOn();
    const a = await queuedJob({ status: 'rendering', renderId: 'r-a', startedAt: new Date() });
    const b = await queuedJob({ status: 'rendering', renderId: 'r-b', startedAt: new Date() });
    await postWebhook({ type: 'error', renderId: 'r-a', bucketName: BUCKET, customData: { jobId: String(a.job._id) }, errors: [{ message: 'boom', name: 'Error', stack: '' }] });
    await postWebhook({ type: 'timeout', renderId: 'r-b', bucketName: BUCKET, customData: { jobId: String(b.job._id) } });
    expect((await RenderJob.findById(a.job._id))!.status).toBe('failed');
    const timedOut = await RenderJob.findById(b.job._id);
    expect(timedOut!.status).toBe('failed');
    expect(timedOut!.error).toMatch(/took too long/);
    expect(await getMonthlyTotal(String(a.user._id), 'renderMinutes')).toBe(0);
    expect(await getMonthlyTotal(String(b.user._id), 'renderMinutes')).toBe(0);
  });

  it('does not exist unless renders run on Lambda in webhook mode', async () => {
    const body = { type: 'success', renderId: 'x', customData: { jobId: 'x' } };
    expect((await postWebhook(body)).status).toBe(404); // Lambda, poll mode
    webhookOn();
    env.renderProvider = 'local';
    expect((await postWebhook(body)).status).toBe(404);
  });
});

describe('Lambda lifecycle backstops', () => {
  it('checkRender saves Lambda progress (never 100) and fails a render past its deadline', async () => {
    const { user, job } = await queuedJob({ status: 'rendering', renderId: 'lambda-render-1', bucketName: BUCKET, startedAt: new Date() });
    lambda.getRenderProgress.mockResolvedValue({ done: false, overallProgress: 1, framesRendered: 900 });
    expect(await checkRender({ _id: job._id, status: 'rendering', renderId: 'lambda-render-1' })).toBe('rendering');
    expect(await RenderJob.findById(job._id).select('+framesRendered')).toMatchObject({ progress: 99, framesRendered: 900 });

    await RenderJob.updateOne({ _id: job._id }, { startedAt: new Date(Date.now() - RENDER_DEADLINE_MS - 1000) });
    const late = (await RenderJob.findById(job._id).lean())!;
    expect(await checkRender(late as any)).toBe('failed');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(0);
  });

  it('a render made on a worker keeps the local backstop even with RENDER_PROVIDER=lambda', async () => {
    const { job } = await queuedJob({ status: 'rendering', renderId: 'local-box-1', startedAt: new Date() });
    expect(await checkRender({ _id: job._id, status: 'rendering', renderId: 'local-box-1', startedAt: new Date() })).toBe('rendering');
    expect(lambda.getRenderProgress).not.toHaveBeenCalled();
  });

  it('the maintenance sweep asks Lambda about a quiet render (a lost webhook) and completes it', async () => {
    webhookOn();
    const { user, job } = await queuedJob({ status: 'rendering', renderId: 'lambda-render-3', bucketName: BUCKET, startedAt: new Date(Date.now() - 10 * 60_000) });
    await RenderJob.collection.updateOne({ _id: job._id }, { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    lambda.getRenderProgress.mockResolvedValue({ done: true, overallProgress: 1, outputFile: outputOf(user._id, job._id) });

    const { runMaintenanceSweep } = await import('../src/services/maintenance.service');
    expect(await runMaintenanceSweep()).toMatchObject({ rendersChecked: 1 });
    expect((await RenderJob.findById(job._id))!.status).toBe('completed');
    expect(await getMonthlyTotal(String(user._id), 'renderMinutes')).toBe(30);
  });

  it('account deletion removes each Lambda render', async () => {
    const { user } = await queuedJob({ status: 'completed', renderId: 'lambda-render-7', bucketName: BUCKET });
    vi.spyOn(await import('../src/services/storage.service'), 'deleteS3Prefix').mockResolvedValue(0);
    const report = await purgeUserData(String(user._id));
    expect(lambda.deleteRender).toHaveBeenCalledWith({ bucketName: BUCKET, renderId: 'lambda-render-7', region: 'us-east-1' });
    expect(report).toMatchObject({ renderOutputs: 1 });
  });
});
