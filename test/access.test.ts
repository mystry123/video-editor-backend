import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { TemplateVersion } from '../src/models/TemplateVersion';
import { RenderJob } from '../src/models/RenderJob';
import { Webhook } from '../src/models/Webhook';
import { ApiKey } from '../src/models/ApiKey';
import { generateApiKey } from '../src/utils/helpers';
import { env } from '../src/config/env';

const project = { width: 1280, height: 720, fps: 30, duration: 5 };

async function apiKeyFor(userId: unknown, permissions: string[]) {
  const { key, prefix, hashed } = generateApiKey();
  await ApiKey.create({ userId, name: 'k', key: hashed, keyPrefix: prefix, permissions });
  return { 'X-API-Key': key };
}

describe('templates', () => {
  it('are private unless made public', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/templates').set(auth).send({ name: 'Mine', data: { project, elements: [] } });
    expect(res.status).toBe(201);
    expect(res.body.isPublic).toBe(false);
  });

  it('show only your own renders, even on a public template', async () => {
    const owner = await createUser();
    const other = await createUser();
    const t = await Template.create({ userId: owner.user._id, name: 'Public', isPublic: true, data: { project, elements: [] } });
    await RenderJob.create({ userId: other.user._id, templateId: t._id, inputProps: {}, status: 'completed', outputUrl: 'https://x/other.mp4' });
    await RenderJob.create({ userId: owner.user._id, templateId: t._id, inputProps: {}, status: 'completed', outputUrl: 'https://x/mine.mp4' });

    const res = await api().get(`/api/v1/templates/${t._id}/renders`).set(owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => r.outputUrl)).toEqual(['https://x/mine.mp4']);
  });

  it("can't be moved to another account through update", async () => {
    const owner = await createUser();
    const victim = await createUser();
    const t = await Template.create({ userId: owner.user._id, name: 'T', data: { project, elements: [] } });
    const res = await api().put(`/api/v1/templates/${t._id}`).set(owner.auth).send({ name: 'Renamed', userId: String(victim.user._id), usageCount: 9999 });
    expect(res.status).toBe(200);
    const after = await Template.findById(t._id).lean();
    expect(String(after!.userId)).toBe(String(owner.user._id));
    expect(after!.name).toBe('Renamed');
    expect((after as any).usageCount ?? 0).not.toBe(9999);
  });

  it("bulk delete leaves other users' templates and versions alone", async () => {
    const me = await createUser();
    const other = await createUser();
    const theirs = await Template.create({ userId: other.user._id, name: 'Theirs', isPublic: true, data: { project, elements: [] } });
    await TemplateVersion.create({ templateId: theirs._id, version: 1, data: {}, createdBy: other.user._id });

    const res = await api().post('/api/v1/templates/bulk-delete').set(me.auth).send({ ids: [String(theirs._id)] });
    expect(res.body.deleted).toBe(0);
    expect(await Template.exists({ _id: theirs._id })).toBeTruthy();
    expect(await TemplateVersion.countDocuments({ templateId: theirs._id })).toBe(1);
  });
});

describe('render progress stream', () => {
  it("is not available for someone else's job", async () => {
    const owner = await createUser();
    const other = await createUser();
    const job = await RenderJob.create({ userId: owner.user._id, inputProps: {}, status: 'rendering' });
    const res = await api().get(`/api/v1/render/${job._id}/progress`).set(other.auth);
    expect(res.status).toBe(404);
  });
});

describe('webhooks', () => {
  it("can't be reassigned to another account", async () => {
    const owner = await createUser();
    const victim = await createUser();
    const hook = await Webhook.create({ userId: owner.user._id, name: 'h', url: 'https://example.com/h', events: ['render.completed'], secret: 's' });
    await api().put(`/api/v1/webhooks/${hook._id}`).set(owner.auth).send({ name: 'renamed', userId: String(victim.user._id), secret: 'mine' });
    const after = await Webhook.findById(hook._id).lean();
    expect(String(after!.userId)).toBe(String(owner.user._id));
    expect((after as any).secret).toBe('s');
    expect(after!.name).toBe('renamed');
  });
});

describe('API key permissions', () => {
  it('limit what a key can do', async () => {
    const { user } = await createUser();
    const t = await Template.create({ userId: user._id, name: 'T', data: { project, elements: [] } });
    const readOnly = await apiKeyFor(user._id, ['read']);

    expect((await api().get('/api/v1/templates').set(readOnly)).status).toBe(200);
    const del = await api().delete(`/api/v1/templates/${t._id}`).set(readOnly);
    expect(del.status).toBe(403);
    expect(del.body.code).toBe('PERMISSION_REQUIRED');
    expect(await Template.exists({ _id: t._id })).toBeTruthy();
  });

  it("can't create more keys", async () => {
    const { user } = await createUser();
    const admin = await apiKeyFor(user._id, ['admin']);
    const res = await api().post('/api/v1/auth/api-keys').set(admin).send({ name: 'escalate' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_REQUIRED');
  });
});

describe('login rate limiting', () => {
  it('slows repeated guesses against one account', async () => {
    await createUser({ email: 'target@test.dev', password: 'Password123' });
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      attempts.push((await api().post('/api/v1/auth/login').send({ email: 'target@test.dev', password: `guess-${i}` })).status);
    }
    expect(attempts.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(attempts[10]).toBe(429);
  });
});

describe('project search', () => {
  it('treats the query as text, not a regular expression', async () => {
    const { auth } = await createUser();
    expect((await api().get('/api/v1/projects/search').query({ q: '(' }).set(auth)).status).toBe(200);
    expect((await api().get('/api/v1/projects/search').query({ q: '(a+)+$' }).set(auth)).status).toBe(200);
  });
});

describe('Remotion webhook', () => {
  it('does not exist without a configured secret', async () => {
    const res = await api().post('/api/v1/webhooks/remotion').send({ type: 'success', customData: { jobId: 'x' }, outputUrl: 'https://evil/x.mp4' });
    expect(res.status).toBe(404);
  });

  it('rejects unsigned or tampered calls when a secret is set', async () => {
    const previous = env.remotionWebhookSecret;
    (env as any).remotionWebhookSecret = 'test-webhook-secret';
    try {
      const { user } = await createUser();
      const job = await RenderJob.create({ userId: user._id, inputProps: {}, status: 'rendering' });
      const res = await api()
        .post('/api/v1/webhooks/remotion')
        .set('X-Remotion-Signature', 'sha512=deadbeef')
        .send({ type: 'success', renderId: 'r', customData: { jobId: String(job._id) }, outputUrl: 'https://evil/x.mp4' });
      expect(res.status).toBe(401);
      expect((await RenderJob.findById(job._id))!.status).toBe('rendering');
    } finally {
      (env as any).remotionWebhookSecret = previous;
    }
  });
});
