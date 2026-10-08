import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, UnsecuredJWT } from 'jose';
import { verifyAppleIdentityToken } from '../../src/services/oauth.service';

const KID = 'apple-test-key';

async function setup() {
  const apple = await generateKeyPair('RS256');
  const attacker = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(apple.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (key: CryptoKey | any, claims: Record<string, unknown> = {}, aud = 'com.shotline.test') =>
    new SignJWT({ email: 'victim@example.com', email_verified: 'true', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('https://appleid.apple.com')
      .setAudience(aud)
      .setSubject('apple-user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  return { apple, attacker, keys, sign };
}

describe('verifyAppleIdentityToken', () => {
  it('accepts a token signed by Apple for our client id', async () => {
    const { apple, keys, sign } = await setup();
    const result = await verifyAppleIdentityToken(await sign(apple.privateKey), keys);
    expect(result).toEqual({ sub: 'apple-user-1', email: 'victim@example.com', emailVerified: true });
  });

  it('rejects a token signed with another key, even with Apple\'s key id', async () => {
    const { attacker, keys, sign } = await setup();
    await expect(verifyAppleIdentityToken(await sign(attacker.privateKey), keys)).rejects.toThrow();
  });

  it('rejects unsigned tokens', async () => {
    const { keys } = await setup();
    const unsigned = new UnsecuredJWT({ email: 'victim@example.com' })
      .setIssuer('https://appleid.apple.com')
      .setAudience('com.shotline.test')
      .setSubject('x')
      .encode();
    await expect(verifyAppleIdentityToken(unsigned, keys)).rejects.toThrow();
  });

  it('rejects tokens for another app or that have expired', async () => {
    const { apple, keys, sign } = await setup();
    await expect(verifyAppleIdentityToken(await sign(apple.privateKey, {}, 'com.other.app'), keys)).rejects.toThrow();
    const expired = await new SignJWT({ email: 'a@b.c' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('https://appleid.apple.com')
      .setAudience('com.shotline.test')
      .setSubject('x')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(apple.privateKey);
    await expect(verifyAppleIdentityToken(expired, keys)).rejects.toThrow();
  });

  it('only reports the email as verified when Apple says so', async () => {
    const { apple, keys, sign } = await setup();
    const result = await verifyAppleIdentityToken(await sign(apple.privateKey, { email_verified: false }), keys);
    expect(result.emailVerified).toBe(false);
  });
});
