import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { AuditLog } from '../src/models/AuditLog';
import { User } from '../src/models/User';
import { getUserQuota } from '../src/config/quotas';

describe('admin access', () => {
  it('is admins only', async () => {
    const { auth } = await createUser();
    const res = await api().get('/api/v1/admin/users').set(auth);
    expect(res.status).toBe(403);
  });
});

describe('managing users', () => {
  it('changes a user plan and records it', async () => {
    const admin = await createUser({ role: 'admin' });
    const target = await createUser();
    const res = await api().patch(`/api/v1/admin/users/${target.user._id}/plan`).set(admin.auth).send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect((await User.findById(target.user._id))!.role).toBe('pro');
    const entry = await AuditLog.findOne({ targetId: String(target.user._id) });
    expect(entry?.summary).toBe('Plan changed from Free to Pro');
    expect(entry?.actorEmail).toBe(admin.user.email);
  });

  it("won't let an admin change their own plan", async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await api().patch(`/api/v1/admin/users/${admin.user._id}/plan`).set(admin.auth).send({ plan: 'free' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_PLAN_CHANGE');
  });

  it('adds an override that changes effective limits, replacing an earlier one', async () => {
    const admin = await createUser({ role: 'admin' });
    const target = await createUser();
    const url = `/api/v1/admin/users/${target.user._id}/overrides`;
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

    await api().post(url).set(admin.auth).send({ field: 'maxRenderMinutes', value: 10 }).expect(201);
    const second = await api().post(url).set(admin.auth).send({ field: 'maxRenderMinutes', value: 20, expiresAt, note: 'tester' });
    expect(second.status).toBe(201);
    expect(second.body.overrides).toHaveLength(1);

    const detail = await api().get(`/api/v1/admin/users/${target.user._id}`).set(admin.auth);
    expect(detail.body.effectiveLimits.maxRenderMinutes).toBe(20);
    expect(detail.body.planLimits.maxRenderMinutes).toBe(1);

    const usage = await api().get('/api/v1/auth/me/usage').set(target.auth);
    expect(usage.body.limits.maxRenderMinutes).toBe(20);

    const id = second.body.overrides[0].id;
    await api().delete(`${url}/${id}`).set(admin.auth).expect(200);
    const after = await api().get('/api/v1/auth/me/usage').set(target.auth);
    expect(after.body.limits.maxRenderMinutes).toBe(1);
  });

  it('rejects invalid overrides', async () => {
    const admin = await createUser({ role: 'admin' });
    const target = await createUser();
    const url = `/api/v1/admin/users/${target.user._id}/overrides`;
    const badValue = await api().post(url).set(admin.auth).send({ field: 'maxResolution', value: '8k' });
    expect(badValue.body.code).toBe('INVALID_LIMIT');
    const past = await api().post(url).set(admin.auth).send({ field: 'maxRenderMinutes', value: 5, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.body.code).toBe('INVALID_EXPIRY');
  });
});

describe('editing plans', () => {
  it('applies plan limit changes immediately in this process and audits only real changes', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await api().put('/api/v1/admin/plans/pro').set(admin.auth).send({ limits: { maxRenderMinutes: 120, maxResolution: '1080p' } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(getUserQuota('pro').maxRenderMinutes).toBe(120);
    const entry = await AuditLog.findOne({ targetType: 'plan', targetId: 'pro' });
    expect(entry?.summary).toBe('Pro plan: Render minutes: 60 min → 120 min');

    const again = await api().put('/api/v1/admin/plans/pro').set(admin.auth).send({ limits: { maxRenderMinutes: 120 } });
    expect(again.body.changed).toBe(false);
    expect(await AuditLog.countDocuments({ targetType: 'plan' })).toBe(1);

    // Restore for other tests in this file.
    await api().put('/api/v1/admin/plans/pro').set(admin.auth).send({ limits: { maxRenderMinutes: 60 } });
  });

  it('rejects invalid limits', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await api().put('/api/v1/admin/plans/free').set(admin.auth).send({ limits: { maxStorage: -7 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LIMIT');
  });
});
