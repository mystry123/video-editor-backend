import { CookieOptions } from 'express';
import { env } from './env';

// Check if we're in production
const isProduction = env.nodeEnv === 'production';

// Access token cookie options (short-lived)
export const accessTokenCookieOptions: CookieOptions = {
  httpOnly: false,                          // Prevents JavaScript access (XSS protection)
  secure: isProduction,                    // HTTPS only in production
  sameSite: 'lax',                         // 'lax' allows OAuth redirects, blocks CSRF
  maxAge: 3 * 60 * 60 * 1000,                  // 15 minutes                        // Only sent to API routes
};

// Refresh token cookie options (long-lived, restricted path)
export const refreshTokenCookieOptions: CookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,         // 7 days                   // Only sent to auth routes (more secure)
};

// Options for clearing cookies
export const clearAccessTokenCookieOptions: CookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: 'lax',
};

export const clearRefreshTokenCookieOptions: CookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: 'lax',
};

// Cookie names (centralized)
export const COOKIE_NAMES = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
} as const;
