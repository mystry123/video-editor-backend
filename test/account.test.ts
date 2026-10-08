import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { User } from '../src/models/User';
import { ApiKey } from '../src/models/ApiKey';
import { accountCleanupQueue } from '../src/queues';
import { generateApiKey } from '../src/utils/helpers';

describe('profile', () => {
  it('reports whether the account has a password', async () => {
    const withPassword = await createUser();
    const me = await api().get('/api/v1/auth/me').set(withPassword.auth);
    expect(me.status).toBe(200);
    expect(me.body.hasPassword).toBe(true);
  });

  it('updates the name (trimmed) and rejects avatar URLs it did not issue', async () => {
    const { user, auth } = await createUser();
    const ok = await api().put('/api/v1/auth/me').set(auth).send({ name: '  New Name  ' });
    expect(ok.status).toBe(200);
    expect((await User.findById(user._id))!.name).toBe('New Name');

    const evil = await api().put('/api/v1/auth/me').set(auth).send({ avatarUrl: 'https://evil.example/x.png' });
    expect(evil.status).toBe(400);
    expect(evil.body.code).toBe('AVATAR_URL');

    const own = await api()
      .put('/api/v1/auth/me')
      .set(auth)
      .send({ avatarUrl: `https://cdn.test/users/${user._id}/avatars/a.png` });
    expect(own.status).toBe(200);
    expect(own.body.avatarUrl).toBe(`https://cdn.test/users/${user._id}/avatars/a.png`);
  });

  it('rejects avatar uploads of the wrong type or size', async () => {
    const { auth } = await createUser();
    const pdf = await api().post('/api/v1/auth/me/avatar-upload').set(auth).send({ mimeType: 'application/pdf', size: 10 });
    expect(pdf.body.code).toBe('AVATAR_TYPE');
    const huge = await api().post('/api/v1/auth/me/avatar-upload').set(auth).send({ mimeType: 'image/png', size: 6 * 1024 * 1024 });
    expect(huge.body.code).toBe('AVATAR_TOO_LARGE');
  });
});

describe('password', () => {
  it('returns 400 WRONG_PASSWORD, not 401, for a wrong current password', async () => {
    const { auth } = await createUser({ password: 'Password123' });
    const res = await api().post('/api/v1/auth/change-password').set(auth).send({ currentPassword: 'nope', newPassword: 'Different123' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WRONG_PASSWORD');
  });

  it('validates set-password input', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/auth/set-password').set(auth).send({ password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('does not let an API key change account settings', async () => {
    const { user } = await createUser();
    const { key, prefix, hashed } = generateApiKey();
    await ApiKey.create({ userId: user._id, name: 'k', key: hashed, keyPrefix: prefix, permissions: ['read', 'write'] });
    const res = await api().post('/api/v1/auth/change-password').set('X-API-Key', key).send({ currentPassword: 'Password123', newPassword: 'Different123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_REQUIRED');
  });
});

describe('usage', () => {
  it("reports the plan and doesn't count last month's usage", async () => {
    const { user, auth } = await createUser();
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
    await User.updateOne({ _id: user._id }, { $set: { 'quotaUsage.renderMinutesUsed': 9, 'quotaUsage.lastReset': lastMonth } });

    const res = await api().get('/api/v1/auth/me/usage').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.plan.key).toBe('free');
    expect(res.body.usage.renderMinutes).toBe(0);
  });

  it('keeps counters within the same month', async () => {
    const { user, auth } = await createUser();
    await User.updateOne({ _id: user._id }, { $set: { 'quotaUsage.renderMinutesUsed': 0.5, 'quotaUsage.lastReset': new Date() } });
    const res = await api().get('/api/v1/auth/me/usage').set(auth);
    expect(res.body.usage.renderMinutes).toBe(0.5);
  });
});

describe('delete account', () => {
  it('requires the matching email and password', async () => {
    const { user, auth } = await createUser({ password: 'Password123' });
    const wrongEmail = await api().delete('/api/v1/auth/me').set(auth).send({ confirmEmail: 'x@y.z', password: 'Password123' });
    expect(wrongEmail.body.code).toBe('CONFIRM_EMAIL_MISMATCH');
    const wrongPassword = await api().delete('/api/v1/auth/me').set(auth).send({ confirmEmail: user.email, password: 'nope' });
    expect(wrongPassword.body.code).toBe('WRONG_PASSWORD');
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it('deletes the user now and queues the data cleanup once', async () => {
    const { user, auth } = await createUser({ password: 'Password123' });
    const res = await api().delete('/api/v1/auth/me').set(auth).send({ confirmEmail: user.email.toUpperCase(), password: 'Password123' });
    expect(res.status).toBe(200);
    expect(await User.exists({ _id: user._id })).toBeNull();
    expect(accountCleanupQueue.add).toHaveBeenCalledWith('purge', { userId: String(user._id) }, { jobId: `account-cleanup-${user._id}` });
  });

  it('protects the last admin', async () => {
    const { user, auth } = await createUser({ role: 'admin', password: 'Password123' });
    const res = await api().delete('/api/v1/auth/me').set(auth).send({ confirmEmail: user.email, password: 'Password123' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
  });
});
