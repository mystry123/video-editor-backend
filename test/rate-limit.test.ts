import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { api, createUser } from './helpers';
import { env } from '../src/config/env';
import { generateAccessToken, generateRefreshToken } from '../src/utils/jwt';
import { clientIp, rateLimitKey } from '../src/middleware/rateLimit.middleware';

const SECRET = 'p'.repeat(48);

function fakeRequest(headers: Record<string, string>, ip = '10.0.0.5', extra: Record<string, unknown> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ip, header: (name: string) => lower[name.toLowerCase()], ...extra } as unknown as Request;
}

const token = (userId: string) => generateAccessToken({ userId, email: 'a@b.c', role: 'free' });

afterEach(() => {
  env.internalProxySecret = '';
});

describe('rate limit keying', () => {
  it('keys a request with a valid access token by its user', () => {
    expect(rateLimitKey(fakeRequest({ Authorization: `Bearer ${token('u1')}` }))).toBe('user:u1');
  });

  it("never trusts a token it can't verify", () => {
    const [header, , signature] = token('u1').split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ userId: 'victim' })).toString('base64url')}.${signature}`;
    expect(rateLimitKey(fakeRequest({ Authorization: `Bearer ${forged}` }))).toBe('ip:10.0.0.5');
    expect(rateLimitKey(fakeRequest({ Authorization: 'Bearer junk' }))).toBe('ip:10.0.0.5');
    // Refresh tokens are signed with the other secret.
    const refresh = generateRefreshToken({ userId: 'u1', email: 'a@b.c', role: 'free' });
    expect(rateLimitKey(fakeRequest({ Authorization: `Bearer ${refresh}` }))).toBe('ip:10.0.0.5');
  });

  it('keys a token refresh by the refresh token\'s user', () => {
    const refresh = generateRefreshToken({ userId: 'u2', email: 'a@b.c', role: 'free' });
    expect(rateLimitKey(fakeRequest({}, '10.0.0.5', { body: { refreshToken: refresh } }))).toBe('user:u2');
    expect(rateLimitKey(fakeRequest({}, '10.0.0.5', { body: { refreshToken: token('u2') } }))).toBe('ip:10.0.0.5');
  });

  it('uses the id set by the auth middleware when the limiter runs after it (API keys too)', () => {
    expect(rateLimitKey(fakeRequest({}, '10.0.0.5', { userId: 'u9' }))).toBe('user:u9');
  });

  it('ignores the forwarded client IP without the shared secret', () => {
    expect(clientIp(fakeRequest({ 'X-Shotline-Client-IP': '1.2.3.4' }))).toBe('10.0.0.5');
    env.internalProxySecret = SECRET;
    expect(clientIp(fakeRequest({ 'X-Shotline-Client-IP': '1.2.3.4', 'X-Shotline-Proxy-Secret': 'wrong' }))).toBe('10.0.0.5');
  });

  it('trusts the forwarded client IP from the Remix server when the secret matches', () => {
    env.internalProxySecret = SECRET;
    expect(clientIp(fakeRequest({ 'X-Shotline-Client-IP': '1.2.3.4', 'X-Shotline-Proxy-Secret': SECRET }))).toBe('1.2.3.4');
    expect(clientIp(fakeRequest({ 'X-Shotline-Client-IP': '2001:db8::1', 'X-Shotline-Proxy-Secret': SECRET }))).toBe('2001:db8::1');
    // Not an IP: fall back.
    expect(clientIp(fakeRequest({ 'X-Shotline-Client-IP': 'evil, 1.1.1.1', 'X-Shotline-Proxy-Secret': SECRET }))).toBe('10.0.0.5');
    expect(rateLimitKey(fakeRequest({ 'X-Shotline-Client-IP': '1.2.3.4', 'X-Shotline-Proxy-Secret': SECRET }))).toBe('ip:1.2.3.4');
  });

  it('ignores a secret that is too short to be safe', () => {
    env.internalProxySecret = 'short';
    expect(clientIp(fakeRequest({ 'X-Shotline-Client-IP': '1.2.3.4', 'X-Shotline-Proxy-Secret': 'short' }))).toBe('10.0.0.5');
  });

  it('gives each signed-in user their own bucket on the general API limit', async () => {
    const a = await createUser();
    const b = await createUser();
    for (let i = 0; i < 100; i++) {
      expect((await api().get('/api/v1/docs.json').set(a.auth)).status).toBe(200);
    }
    const limited = await api().get('/api/v1/docs.json').set(a.auth);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    // Same IP, different user (and anonymous): unaffected.
    expect((await api().get('/api/v1/docs.json').set(b.auth)).status).toBe(200);
    expect((await api().get('/api/v1/docs.json')).status).toBe(200);
  });
});
