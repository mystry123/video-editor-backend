import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { api, createUser } from './helpers';
import { Session } from '../src/models/Session';
import { User } from '../src/models/User';
import { env } from '../src/config/env';
import { hashRefreshToken } from '../src/utils/jwt';

async function signIn(email = `s${Date.now()}${Math.random()}@test.dev`) {
  await createUser({ email, password: 'Password123' });
  const res = await api().post('/api/v1/auth/login').send({ email, password: 'Password123' });
  expect(res.status).toBe(200);
  return { email, ...res.body as { accessToken: string; refreshToken: string; user: any } };
}

const refresh = (refreshToken: string) => api().post('/api/v1/auth/refresh').send({ refreshToken });
const me = (accessToken: string) => api().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);

describe('sessions', () => {
  it('sign-in creates a session that both tokens point to', async () => {
    const { accessToken, refreshToken } = await signIn();
    const sid = (jwt.decode(accessToken) as any).sid;
    expect(sid).toBe((jwt.decode(refreshToken) as any).sid);
    const session = await Session.findById(sid);
    expect(session!.tokenHash).toBe(hashRefreshToken(refreshToken));
    expect((await me(accessToken)).status).toBe(200);
  });

  it('refresh rotates the refresh token', async () => {
    const first = await signIn();
    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    expect((await me(res.body.accessToken)).status).toBe(200);
    expect((await refresh(res.body.refreshToken)).status).toBe(200);
  });

  it('parallel refreshes with the same token all succeed with the same new token', async () => {
    const { refreshToken } = await signIn();
    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken), refresh(refreshToken)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.refreshToken)).size).toBe(1);
  });

  it('the previous refresh token still works until the new one is used (lost cookie)', async () => {
    const { refreshToken } = await signIn();
    const rotated = await refresh(refreshToken);
    const again = await refresh(refreshToken);
    expect(again.status).toBe(200);
    expect(again.body.refreshToken).toBe(rotated.body.refreshToken);
  });

  it('a refresh token two rotations old revokes the session for everyone', async () => {
    const { refreshToken, accessToken } = await signIn();
    const second = await refresh(refreshToken);
    const third = await refresh(second.body.refreshToken);
    expect(third.status).toBe(200);

    const stolen = await refresh(refreshToken);
    expect(stolen.status).toBe(401);
    expect(stolen.body.code).toBe('SESSION_REVOKED');
    // The legitimate holder is signed out too: the session is gone for everyone.
    expect((await refresh(third.body.refreshToken)).status).toBe(401);
    vi.useFakeTimers({ now: Date.now() + 11_000, toFake: ['Date'] });
    try {
      expect((await me(accessToken)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the previous token stops working once the grace period ends', async () => {
    const { refreshToken } = await signIn();
    await refresh(refreshToken);
    const sid = (jwt.decode(refreshToken) as any).sid;
    await Session.updateOne({ _id: sid }, { $set: { prevValidUntil: new Date(Date.now() - 1000) } });
    expect((await refresh(refreshToken)).body.code).toBe('SESSION_REVOKED');
  });

  it('logout ends the session immediately for access and refresh', async () => {
    const { accessToken, refreshToken } = await signIn();
    await api().post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect((await me(accessToken)).status).toBe(401);
    expect((await refresh(refreshToken)).status).toBe(401);
  });

  it('changing the password signs out other devices but keeps this one', async () => {
    const email = `pw${Date.now()}@test.dev`;
    const laptop = await signIn(email);
    const phone = await api().post('/api/v1/auth/login').send({ email, password: 'Password123' });
    const res = await api()
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${laptop.accessToken}`)
      .send({ currentPassword: 'Password123', newPassword: 'NewPassword456' });
    expect(res.status).toBe(200);
    expect((await refresh(phone.body.refreshToken)).status).toBe(401);
    expect((await me(res.body.accessToken)).status).toBe(200);
  });

  it('moves a pre-session refresh token into a session once', async () => {
    const { user } = await createUser();
    const legacy = jwt.sign({ userId: String(user._id), email: user.email, role: user.role, tokenType: 'refresh' }, env.jwtRefreshSecret, { expiresIn: '1d' });
    await User.updateOne({ _id: user._id }, { $set: { refreshTokens: [hashRefreshToken(legacy)] } });

    const res = await refresh(legacy);
    expect(res.status).toBe(200);
    expect((jwt.decode(res.body.refreshToken) as any).sid).toBeTruthy();
    expect((await refresh(legacy)).status).toBe(401);
  });

  it('lists and revokes devices from settings', async () => {
    const email = `dev${Date.now()}@test.dev`;
    const a = await signIn(email);
    const b = await api().post('/api/v1/auth/login').send({ email, password: 'Password123' });
    const list = await api().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${a.accessToken}`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: any) => s.current)).toHaveLength(1);

    const other = list.body.data.find((s: any) => !s.current);
    await api().delete(`/api/v1/auth/sessions/${other.id}`).set('Authorization', `Bearer ${a.accessToken}`).expect(200);
    expect((await refresh(b.body.refreshToken)).status).toBe(401);
  });
});

describe('upload tickets', () => {
  it('work only on upload routes and die with the session', async () => {
    const { accessToken } = await signIn();
    const issued = await api().post('/api/v1/auth/upload-ticket').set('Authorization', `Bearer ${accessToken}`);
    expect(issued.status).toBe(200);
    const ticket = { Authorization: `Bearer ${issued.body.ticket}` };

    // Not usable as a general session token.
    expect((await me(issued.body.ticket)).status).toBe(401);
    expect((await api().get('/api/v1/templates').set(ticket)).status).toBe(401);
    expect((await api().post('/api/v1/auth/upload-ticket').set(ticket)).status).toBe(401);

    // Accepted where the browser uploads (reaches validation, not auth).
    const upload = await api().post('/api/v1/files/upload-url').set(ticket).send({});
    expect(upload.status).toBe(400);
    expect(upload.body.code).toBe('VALIDATION_ERROR');

    await api().post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect((await api().post('/api/v1/files/upload-url').set(ticket).send({})).status).toBe(401);
  });
});
