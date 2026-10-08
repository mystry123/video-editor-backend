import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { User } from '../src/models/User';
import type { OAuthUserInfo } from '../src/services/oauth.service';

const identity: { current: OAuthUserInfo } = { current: null as any };

vi.mock('../src/services/oauth.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/oauth.service')>();
  return { ...actual, verifyAppleIdToken: vi.fn(async () => identity.current) };
});

const signInWithApple = () => api().post('/api/v1/auth/apple/token').send({ idToken: 'verified-by-mock' });

beforeEach(() => {
  identity.current = { provider: 'apple', providerId: 'apple-123', email: 'owner@example.com', emailVerified: true };
});

describe('signing in with a provider when the email already has an account', () => {
  it('refuses to link when the provider has not verified the email', async () => {
    await createUser({ email: 'owner@example.com' });
    identity.current.emailVerified = false;
    const res = await signInWithApple();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OAUTH_EMAIL_UNVERIFIED');
    const user = await User.findOne({ email: 'owner@example.com' });
    expect(user!.oauthAccounts).toHaveLength(0);
  });

  it('takes over an unverified pre-registered account: drops its password and sessions', async () => {
    const { user } = await createUser({ email: 'owner@example.com', password: 'AttackerPass1' });
    await User.updateOne({ _id: user._id }, { $set: { isVerified: false, refreshTokens: ['attacker-session'] } });

    const res = await signInWithApple();
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();

    const after = await User.findById(user._id).select('+password +refreshTokens');
    expect(after!.password).toBeUndefined();
    expect(after!.refreshTokens).not.toContain('attacker-session');
    expect(after!.isVerified).toBe(true);
    expect(after!.oauthAccounts.map((a) => a.provider)).toEqual(['apple']);

    const attackerLogin = await api().post('/api/v1/auth/login').send({ email: 'owner@example.com', password: 'AttackerPass1' });
    expect(attackerLogin.status).toBe(400);
  });

  it('links to a verified account and keeps its password', async () => {
    const { user } = await createUser({ email: 'owner@example.com', password: 'OwnerPass12' });
    await User.updateOne({ _id: user._id }, { $set: { isVerified: true } });
    const res = await signInWithApple();
    expect(res.status).toBe(200);
    const login = await api().post('/api/v1/auth/login').send({ email: 'owner@example.com', password: 'OwnerPass12' });
    expect(login.status).toBe(200);
  });

  it('matches the provider id on the same linked-account entry', async () => {
    // Someone with a Google link whose id equals the Apple id must not be matched.
    const { user } = await createUser({ email: 'someone@example.com' });
    await User.updateOne(
      { _id: user._id },
      { $push: { oauthAccounts: { $each: [{ provider: 'google', providerId: 'apple-123' }, { provider: 'apple', providerId: 'other' }] } } }
    );
    identity.current.email = 'fresh@example.com';
    const res = await signInWithApple();
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('fresh@example.com');
  });
});

describe('new accounts from a provider', () => {
  it('are verified only if the provider verified the email', async () => {
    identity.current = { provider: 'apple', providerId: 'p1', email: 'New@Example.com', emailVerified: false };
    const res = await signInWithApple();
    expect(res.status).toBe(200);
    const user = await User.findOne({ email: 'new@example.com' });
    expect(user!.isVerified).toBe(false);
  });

  it('need an email address', async () => {
    identity.current = { provider: 'apple', providerId: 'p2', email: '', emailVerified: false };
    const res = await signInWithApple();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OAUTH_NO_EMAIL');
  });
});
