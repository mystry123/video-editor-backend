import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/ApiError';

// ============================================
// TYPES
// ============================================

export interface OAuthUserInfo {
  provider: 'google' | 'apple' | 'facebook';
  providerId: string;
  email: string;
  /** Whether the provider says the user proved they own `email`. Only verified emails may be linked to an existing account. */
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
}

const PROVIDER_NAMES = { google: 'Google', apple: 'Apple', facebook: 'Facebook' } as const;

/** Client-facing error for a failed provider check; the cause is logged, not returned. */
function oauthFailure(provider: keyof typeof PROVIDER_NAMES, error: unknown): ApiError {
  const message = (error as Error)?.message || '';
  logger.warn(`${PROVIDER_NAMES[provider]} sign-in verification failed`, { error: message });
  if (/not configured/i.test(message)) {
    return ApiError.withCode(503, 'OAUTH_NOT_CONFIGURED', `${PROVIDER_NAMES[provider]} sign-in isn't available right now.`);
  }
  return ApiError.withCode(400, 'OAUTH_INVALID_TOKEN', `We couldn't verify your ${PROVIDER_NAMES[provider]} sign-in. Try again.`);
}

// ============================================
// GOOGLE OAuth
// ============================================

const googleClient = new OAuth2Client(
  env.googleClientId,
  env.googleClientSecret,
  env.googleCallbackUrl
);

// Get Google OAuth URL
export function getGoogleAuthUrl(): string {
  return googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    prompt: 'consent',
  });
}

// Verify Google OAuth code and get user info
function assertGoogleConfigured(): void {
  // Without a client id, verifyIdToken would not check the audience.
  if (!env.googleClientId) throw new Error('Google sign-in is not configured');
}

export async function verifyGoogleCode(code: string): Promise<OAuthUserInfo> {
  try {
    assertGoogleConfigured();
    const { tokens } = await googleClient.getToken(code);
    googleClient.setCredentials(tokens);

    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: env.googleClientId,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new Error('Invalid Google token payload');
    }

    return {
      provider: 'google',
      providerId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name,
      avatarUrl: payload.picture,
      accessToken: tokens.access_token || undefined,
      refreshToken: tokens.refresh_token || undefined,
    };
  } catch (error) {
    throw oauthFailure('google', error);
  }
}

// Verify Google ID token (for mobile/frontend token flow)
export async function verifyGoogleIdToken(idToken: string): Promise<OAuthUserInfo> {
  try {
    assertGoogleConfigured();
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.googleClientId,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new Error('Invalid Google token payload');
    }

    return {
      provider: 'google',
      providerId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name,
      avatarUrl: payload.picture,
    };
  } catch (error) {
    throw oauthFailure('google', error);
  }
}

// ============================================
// APPLE OAuth
// ============================================

// Generate Apple client secret (JWT)
function generateAppleClientSecret(): string {
  const privateKey = env.applePrivateKey.replace(/\\n/g, '\n');
  
  const token = jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '180d',
    audience: 'https://appleid.apple.com',
    issuer: env.appleTeamId,
    subject: env.appleClientId,
    keyid: env.appleKeyId,
  });

  return token;
}

// Apple's signing keys; jose fetches and caches them, refetching on unknown key ids.
const APPLE_ISSUER = 'https://appleid.apple.com';
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

/**
 * Verifies an Apple identity token: signature against Apple's published keys,
 * expiry, issuer and audience (our Service ID). Only then are its claims used.
 */
export async function verifyAppleIdentityToken(
  idToken: string,
  keys: Parameters<typeof jwtVerify>[1] = appleKeys
): Promise<{ sub: string; email?: string; emailVerified: boolean }> {
  if (!env.appleClientId) throw new Error('Apple sign-in is not configured');
  const { payload } = await jwtVerify(idToken, keys as any, {
    issuer: APPLE_ISSUER,
    audience: env.appleClientId,
    algorithms: ['RS256'],
  });
  if (!payload.sub) throw new Error('Apple token has no subject');
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  return { sub: payload.sub, email, emailVerified: !!email && verified };
}

// Get Apple OAuth URL
export function getAppleAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: env.appleClientId,
    redirect_uri: env.appleCallbackUrl,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
  });

  return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
}

// Verify Apple OAuth code and get user info
export async function verifyAppleCode(
  code: string,
  idToken?: string,
  userData?: { name?: { firstName?: string; lastName?: string } }
): Promise<OAuthUserInfo> {
  try {
    const clientSecret = generateAppleClientSecret();

    // Exchange code for tokens
    const tokenResponse = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: env.appleClientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: env.appleCallbackUrl,
      }),
    });

    const tokens = await tokenResponse.json() as any;

    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    // Verify the identity token (even the one from Apple's token endpoint).
    const identity = await verifyAppleIdentityToken(tokens.id_token || idToken || '');

    // Build name from user data (only provided on first sign-in)
    let name: string | undefined;
    if (userData?.name) {
      const { firstName, lastName } = userData.name;
      name = [firstName, lastName].filter(Boolean).join(' ') || undefined;
    }

    return {
      provider: 'apple',
      providerId: identity.sub,
      email: identity.email || '',
      emailVerified: identity.emailVerified,
      name,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  } catch (error) {
    throw oauthFailure('apple', error);
  }
}

// Verify Apple ID token (for mobile/frontend token flow)
export async function verifyAppleIdToken(idToken: string): Promise<OAuthUserInfo> {
  try {
    const identity = await verifyAppleIdentityToken(idToken);
    return {
      provider: 'apple',
      providerId: identity.sub,
      email: identity.email || '',
      emailVerified: identity.emailVerified,
    };
  } catch (error) {
    throw oauthFailure('apple', error);
  }
}

// ============================================
// FACEBOOK OAuth
// ============================================

// Get Facebook OAuth URL
export function getFacebookAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: env.facebookAppId,
    redirect_uri: env.facebookCallbackUrl,
    scope: 'email,public_profile',
    response_type: 'code',
  });

  return `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
}

// Verify Facebook OAuth code and get user info
export async function verifyFacebookCode(code: string): Promise<OAuthUserInfo> {
  try {
    // Exchange code for access token
    const tokenUrl = new URL('https://graph.facebook.com/v18.0/oauth/access_token');
    tokenUrl.searchParams.set('client_id', env.facebookAppId);
    tokenUrl.searchParams.set('client_secret', env.facebookAppSecret);
    tokenUrl.searchParams.set('redirect_uri', env.facebookCallbackUrl);
    tokenUrl.searchParams.set('code', code);

    const tokenResponse = await fetch(tokenUrl.toString());
    const tokens = await tokenResponse.json() as any;

    if (tokens.error) {
      throw new Error(tokens.error.message || 'Facebook token error');
    }

    // Get user info
    const userUrl = new URL('https://graph.facebook.com/v18.0/me');
    userUrl.searchParams.set('fields', 'id,email,name,picture.width(200)');
    userUrl.searchParams.set('access_token', tokens.access_token);

    const userResponse = await fetch(userUrl.toString());
    const userData = await userResponse.json() as any;

    if (userData.error) {
      throw new Error(userData.error.message || 'Facebook user error');
    }

    return {
      provider: 'facebook',
      providerId: userData.id,
      email: userData.email,
      // Facebook only returns an email the user has confirmed with Facebook.
      emailVerified: !!userData.email,
      name: userData.name,
      avatarUrl: userData.picture?.data?.url,
      accessToken: tokens.access_token,
    };
  } catch (error) {
    throw oauthFailure('facebook', error);
  }
}

// Verify Facebook access token (for mobile/frontend token flow)
export async function verifyFacebookAccessToken(accessToken: string): Promise<OAuthUserInfo> {
  try {
    // Verify token with Facebook
    const debugUrl = new URL('https://graph.facebook.com/debug_token');
    debugUrl.searchParams.set('input_token', accessToken);
    debugUrl.searchParams.set('access_token', `${env.facebookAppId}|${env.facebookAppSecret}`);

    const debugResponse = await fetch(debugUrl.toString());
    const debugData = await debugResponse.json() as any;

    if (!env.facebookAppId || !env.facebookAppSecret) throw new Error('Facebook sign-in is not configured');
    if (!debugData.data?.is_valid) {
      throw new Error('Invalid Facebook token');
    }
    // A valid token issued to some other Facebook app must not sign anyone in here.
    if (String(debugData.data.app_id) !== String(env.facebookAppId)) {
      throw new Error('Facebook token was issued for a different app');
    }

    // Get user info
    const userUrl = new URL('https://graph.facebook.com/v18.0/me');
    userUrl.searchParams.set('fields', 'id,email,name,picture.width(200)');
    userUrl.searchParams.set('access_token', accessToken);

    const userResponse = await fetch(userUrl.toString());
    const userData = await userResponse.json() as any;

    if (userData.error) {
      throw new Error(userData.error.message);
    }

    return {
      provider: 'facebook',
      providerId: userData.id,
      email: userData.email,
      emailVerified: !!userData.email,
      name: userData.name,
      avatarUrl: userData.picture?.data?.url,
      accessToken,
    };
  } catch (error) {
    throw oauthFailure('facebook', error);
  }
}
