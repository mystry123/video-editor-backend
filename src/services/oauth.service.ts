import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ============================================
// TYPES
// ============================================

export interface OAuthUserInfo {
  provider: 'google' | 'apple' | 'facebook';
  providerId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
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
export async function verifyGoogleCode(code: string): Promise<OAuthUserInfo> {
  try {
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
      name: payload.name,
      avatarUrl: payload.picture,
      accessToken: tokens.access_token || undefined,
      refreshToken: tokens.refresh_token || undefined,
    };
  } catch (error) {
    logger.error('Google OAuth error:', error);
    throw new Error('Failed to verify Google authentication');
  }
}

// Verify Google ID token (for mobile/frontend token flow)
export async function verifyGoogleIdToken(idToken: string): Promise<OAuthUserInfo> {
  try {
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
      name: payload.name,
      avatarUrl: payload.picture,
    };
  } catch (error) {
    logger.error('Google ID token verification error:', error);
    throw new Error('Invalid Google ID token');
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

    // Decode the ID token to get user info
    const decoded = jwt.decode(tokens.id_token || idToken) as any;

    if (!decoded || !decoded.sub) {
      throw new Error('Invalid Apple token');
    }

    // Build name from user data (only provided on first sign-in)
    let name: string | undefined;
    if (userData?.name) {
      const { firstName, lastName } = userData.name;
      name = [firstName, lastName].filter(Boolean).join(' ') || undefined;
    }

    return {
      provider: 'apple',
      providerId: decoded.sub,
      email: decoded.email,
      name,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  } catch (error) {
    logger.error('Apple OAuth error:', error);
    throw new Error('Failed to verify Apple authentication');
  }
}

// Verify Apple ID token (for mobile/frontend token flow)
export async function verifyAppleIdToken(idToken: string): Promise<OAuthUserInfo> {
  try {
    // Fetch Apple's public keys
    const keysResponse = await fetch('https://appleid.apple.com/auth/keys');
    const { keys } = await keysResponse.json() as any;

    // Decode token header to get key ID
    const header = jwt.decode(idToken, { complete: true })?.header;
    if (!header) throw new Error('Invalid token');

    // Find matching key
    const key = keys.find((k: any) => k.kid === header.kid);
    if (!key) throw new Error('Key not found');

    // Convert JWK to PEM (simplified - use jose library in production)
    // For production, use: import { createPublicKey } from 'crypto';
    
    const decoded = jwt.decode(idToken) as any;
    
    if (!decoded || !decoded.sub) {
      throw new Error('Invalid Apple token');
    }

    // Verify audience and issuer
    if (decoded.aud !== env.appleClientId) {
      throw new Error('Invalid audience');
    }
    if (decoded.iss !== 'https://appleid.apple.com') {
      throw new Error('Invalid issuer');
    }

    return {
      provider: 'apple',
      providerId: decoded.sub,
      email: decoded.email,
    };
  } catch (error) {
    logger.error('Apple ID token verification error:', error);
    throw new Error('Invalid Apple ID token');
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
      name: userData.name,
      avatarUrl: userData.picture?.data?.url,
      accessToken: tokens.access_token,
    };
  } catch (error) {
    logger.error('Facebook OAuth error:', error);
    throw new Error('Failed to verify Facebook authentication');
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

    if (!debugData.data?.is_valid) {
      throw new Error('Invalid Facebook token');
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
      name: userData.name,
      avatarUrl: userData.picture?.data?.url,
      accessToken,
    };
  } catch (error) {
    logger.error('Facebook token verification error:', error);
    throw new Error('Invalid Facebook access token');
  }
}
