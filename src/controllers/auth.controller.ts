import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { User, IUser, OAuthProvider } from '../models/User';
import { UserLoginHistory } from '../models/UserLoginHistory';
import { ApiKey } from '../models/ApiKey';
import { ApiError } from '../utils/ApiError';
import { generateApiKey } from '../utils/helpers';
import {
  generateTokenPair,
  generateAccessToken,
  generateResetToken,
  hashResetToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../utils/jwt';
import {
  getGoogleAuthUrl,
  verifyGoogleCode,
  verifyGoogleIdToken,
  getAppleAuthUrl,
  verifyAppleCode,
  verifyAppleIdToken,
  getFacebookAuthUrl,
  verifyFacebookCode,
  verifyFacebookAccessToken,
  OAuthUserInfo,
} from '../services/oauth.service';
import { sendPasswordResetEmail, sendWelcomeEmail } from '../services/email.service';
import { createSession, revokeAllSessions, revokeSession, rotateRefreshToken } from '../services/session.service';
import {
  accessTokenCookieOptions,
  refreshTokenCookieOptions,
  clearAccessTokenCookieOptions,
  clearRefreshTokenCookieOptions,
  COOKIE_NAMES,
} from '../config/cookies';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ============================================
// TYPES
// ============================================

interface UserResponse {
  _id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  role: string;
  isVerified: boolean;
  authProvider: string;
  linkedProviders?: string[];
  storageUsed?: number;
  createdAt: Date;
}

interface AuthResponse {
  user: UserResponse;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

// ============================================
// HELPERS
// ============================================


// Format user response (exclude sensitive fields)
function formatUserResponse(user: IUser, includeLinkedProviders = false): UserResponse {
  const response: UserResponse = {
    _id: user._id.toString(),
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    isVerified: user.isVerified,
    authProvider: user.authProvider,
    createdAt: user.createdAt,
  };

  if (includeLinkedProviders) {
    response.linkedProviders = user.oauthAccounts.map((a) => a.provider);
    // The real counter (the top-level storageUsed field was never updated).
    response.storageUsed = user.quotaUsage?.storageUsed || 0;
  }

  return response;
}

// Helper function to extract device info from user agent
function extractDeviceInfo(userAgent: string): string {
  if (!userAgent) return 'unknown';
  
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    if (ua.includes('iphone')) return 'iPhone';
    if (ua.includes('android')) return 'Android';
    return 'Mobile';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'Tablet';
  }
  if (ua.includes('windows nt')) return 'Windows';
  if (ua.includes('mac os')) return 'MacOS';
  if (ua.includes('linux')) return 'Linux';
  
  return 'Desktop';
}

// Login user: generate tokens, return in response (no cookies)
async function loginUser(user: IUser, req: any, res: Response, saveMetadata: boolean = false, loginType: 'password' | 'oauth_google' | 'oauth_apple' | 'oauth_facebook' | 'signup' = 'password'): Promise<AuthResponse> {
  const userAgent: string = res.locals?.userAgent || req.get?.('User-Agent') || '';
  const location = res.locals?.geoLocation;
  const tokens = await createSession(user, {
    method: loginType,
    userAgent,
    ip: req.ip,
    device: extractDeviceInfo(userAgent),
    location: location ? [location.city, location.country].filter(Boolean).join(', ') || null : null,
  });

  // Only save metadata for explicit login (not OAuth/signup unless specified)
  if (saveMetadata) {
    const metaData = {
      ip: res.locals?.clientIP || 
           req.ip || 
           req.connection?.remoteAddress || 
           req.socket?.remoteAddress ||
           'unknown',
      userAgent: res.locals?.userAgent || req.get?.('User-Agent') || 'unknown',
      timestamp: new Date(),
      device: extractDeviceInfo(req.get?.('User-Agent') || ''),
      location: res.locals?.geoLocation || null,
      success: true,
      loginType,
    };

    // Save login metadata in separate collection
    try {
      await UserLoginHistory.addLoginEvent(user._id.toString(), metaData);
    } catch (error) {
      logger.warn('Failed to save login metadata', { error: (error as Error).message });
      // Don't fail the login if metadata saving fails
    }
  }

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  // Return tokens in response body instead of cookies
  return {
    user: formatUserResponse(user),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  };
}

// Handle OAuth user: find or create
async function handleOAuthUser(userInfo: OAuthUserInfo): Promise<IUser> {
  // Check if user exists with this OAuth provider ($elemMatch: both fields on the same entry)
  let user = await User.findOne({
    oauthAccounts: { $elemMatch: { provider: userInfo.provider, providerId: userInfo.providerId } },
  });

  if (user) {
    // Update OAuth tokens if provided
    if (userInfo.accessToken || userInfo.refreshToken) {
      await User.updateOne(
        { _id: user._id, 'oauthAccounts.provider': userInfo.provider },
        {
          $set: {
            'oauthAccounts.$.accessToken': userInfo.accessToken,
            'oauthAccounts.$.refreshToken': userInfo.refreshToken,
          },
        }
      );
    }
    return user;
  }

  if (!userInfo.email) {
    throw ApiError.withCode(400, 'OAUTH_NO_EMAIL', `Your ${userInfo.provider} account didn't share an email address, so we can't sign you in with it.`);
  }
  const email = userInfo.email.toLowerCase();

  // Check if user exists with same email
  user = await User.findOne({ email }).select('+password +refreshTokens');

  if (user) {
    // Linking by email is only safe when the provider has verified that the
    // person signing in owns the address. Otherwise anyone could create a
    // provider account with someone else's email and take over their account.
    if (!userInfo.emailVerified) {
      throw ApiError.withCode(
        409,
        'OAUTH_EMAIL_UNVERIFIED',
        `An account with this email already exists. Sign in with your password, then connect ${userInfo.provider} in Settings.`
      );
    }

    // If the existing account never verified its email, whoever set its
    // password never proved they own the address (e.g. someone pre-registering
    // a victim's email). The provider just did, so the provider wins: drop the
    // unverified password and end that account's existing sessions.
    if (!user.isVerified) {
      if (user.password) {
        logger.warn('Removing unverified password while linking verified OAuth identity', {
          userId: String(user._id),
          provider: userInfo.provider,
        });
        user.password = undefined;
      }
      user.refreshTokens = [];
      await revokeAllSessions(user._id.toString(), 'unverified_account_claimed');
      user.isVerified = true;
      user.authProvider = userInfo.provider;
    }

    // Link OAuth account to existing user
    user.oauthAccounts.push({
      provider: userInfo.provider,
      providerId: userInfo.providerId,
      email,
      accessToken: userInfo.accessToken,
      refreshToken: userInfo.refreshToken,
    });
    await user.save();
    return user;
  }

  // Create new user
  user = await User.create({
    email,
    name: userInfo.name,
    avatarUrl: userInfo.avatarUrl,
    authProvider: userInfo.provider,
    isVerified: userInfo.emailVerified,
    oauthAccounts: [
      {
        provider: userInfo.provider,
        providerId: userInfo.providerId,
        email,
        accessToken: userInfo.accessToken,
        refreshToken: userInfo.refreshToken,
      },
    ],
  });

  // Send welcome email (non-blocking)
  sendWelcomeEmail(user.email, user.name).catch((err) =>
    logger.error('Failed to send welcome email:', err)
  );

  return user;
}

// ============================================
// LOCAL AUTHENTICATION
// ============================================

// POST /auth/signup
export const signup = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, password, name } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      throw ApiError.conflict('Email already registered');
    }

    // Create user
    const user = await User.create({
      email: email.toLowerCase(),
      password,
      name,
      authProvider: 'local',
    });

    // Login and set cookies (save metadata for login tracking)
    const result = await loginUser(user, req, res, true, 'password');

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email, user.name).catch((err) =>
      logger.error('Failed to send welcome email:', err)
    );

    res.status(201).json({
      message: 'Account created successfully',
      ...result,
    });
  } catch (error) {
    next(error);
  }
};

// POST /auth/login
export const login = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Find user with password field
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (!user) {
      // 400, not 401: 401 is reserved for an invalid session (it triggers a token refresh).
      throw ApiError.withCode(400, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    }

    // Check if user has password (might be OAuth only)
    if (!user.password) {
      const providers = user.oauthAccounts.map((a) => a.provider).join(', ');
      throw ApiError.badRequest(
        `This account uses ${providers} login. Please sign in with ${providers}.`
      );
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      // 400, not 401: 401 is reserved for an invalid session (it triggers a token refresh).
      throw ApiError.withCode(400, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    }

    // Login and set cookies
    const result = await loginUser(user, req, res, true, 'password');

    res.json({
      message: 'Login successful',
      ...result,
    });
  } catch (error) {
    next(error);
  }
};

// POST /auth/logout
export const logout = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // End this device's session (identified by the access token), so both its
    // access and refresh tokens stop working. A refresh token in the body
    // (older clients) is also cleaned up.
    if (req.sessionId) await revokeSession(req.sessionId, 'logout', req.userId);
    const { refreshToken } = req.body || {};
    if (refreshToken && req.userId) {
      await User.updateOne({ _id: req.userId }, { $pull: { refreshTokens: hashRefreshToken(refreshToken) } });
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
};

// POST /auth/logout-all (logout from all devices)
export const logoutAll = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (req.userId) await revokeAllSessions(req.userId, 'logout_all');

    res.json({ message: 'Logged out from all devices' });
  } catch (error) {
    next(error);
  }
};

// POST /auth/refresh
export const refresh = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Get refresh token from request body (frontend-managed)
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw ApiError.withCode(401, 'SESSION_INVALID', 'Your session has ended. Sign in again.');
    }

    const result = await rotateRefreshToken(refreshToken, { ip: req.ip });

    res.json({
      user: formatUserResponse(result.user),
      accessToken: result.accessToken,
      // Rotated on every refresh: the client must store this new one.
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    });
  } catch (error) {
    next(error);
  }
};

// POST /auth/forgot-password
export const forgotPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });

    // Don't reveal if email exists (security)
    if (!user || (!user.password && user.oauthAccounts.length > 0)) {
      res.json({ message: 'If the email exists, a reset link has been sent' });
      return;
    }

    // Generate reset token
    const { token, hashedToken, expires } = generateResetToken();

    // Save hashed token
    await User.findByIdAndUpdate(user._id, {
      resetPasswordToken: hashedToken,
      resetPasswordExpires: expires,
    });

    // Send email
    await sendPasswordResetEmail(user.email, token, user.name);

    res.json({ message: 'If the email exists, a reset link has been sent' });
  } catch (error) {
    next(error);
  }
};

// POST /auth/reset-password
export const resetPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { token, password } = req.body;

    const hashedToken = hashResetToken(token);

    // Find user with valid token
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      throw ApiError.badRequest('Invalid or expired reset token');
    }

    // Update password and clear reset token
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    await revokeAllSessions(user._id.toString(), 'password_reset');


    res.json({ message: 'Password reset successfully. Please login with your new password.' });
  } catch (error) {
    next(error);
  }
};

// POST /auth/change-password
export const changePassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    if (!user.password) {
      throw ApiError.badRequest('Cannot change password for OAuth-only accounts. Set a password first.');
    }

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      // 400, not 401: a 401 means "session expired" to the frontend and triggers a token refresh.
      throw ApiError.withCode(400, 'WRONG_PASSWORD', 'Your current password is incorrect.');
    }

    // Update password and end every session, then start a new one for this device.
    user.password = newPassword;
    await user.save();
    await revokeAllSessions(user._id.toString(), 'password_change');

    // Issue new tokens
    const result = await loginUser(user, req, res, true, 'password');

    res.json({
      message: 'Password changed successfully',
      ...result,
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// GOOGLE OAUTH
// ============================================

// GET /auth/google
export const googleAuth = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const url = getGoogleAuthUrl();
    res.json({ url });
  } catch (error) {
    next(error);
  }
};

// GET /auth/google/callback
export const googleCallback = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      throw new Error('No authorization code');
    }

    const userInfo = await verifyGoogleCode(code);
    const user = await handleOAuthUser(userInfo);
    await loginUser(user, req, res, false);

    // Redirect to frontend (clean URL, tokens in cookies)
    res.redirect(`${env.frontendUrl}/auth/callback?success=true`);
  } catch (error) {
    logger.error('Google OAuth callback error:', error);
    res.redirect(`${env.frontendUrl}/auth/callback?error=oauth_failed`);
  }
};

// POST /auth/google/token (for mobile/SPA with ID token)
export const googleToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { idToken, code } = req.body;

    if (!idToken && !code) {
      throw ApiError.badRequest('Either idToken or code is required');
    }

    const userInfo = idToken
      ? await verifyGoogleIdToken(idToken)
      : await verifyGoogleCode(code);

    const user = await handleOAuthUser(userInfo);
    const result = await loginUser(user, req, res, true, 'oauth_google');

    res.json(result);
  } catch (error) {
    next(error);
  }
};

// ============================================
// APPLE OAUTH
// ============================================

// GET /auth/apple
export const appleAuth = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const url = getAppleAuthUrl();
    res.json({ url });
  } catch (error) {
    next(error);
  }
};

// POST /auth/apple/callback (Apple uses POST)
export const appleCallback = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { code, id_token, user: userDataStr } = req.body;

    if (!code) {
      throw new Error('No authorization code');
    }

    // Parse user data (only provided on first sign-in)
    let userData;
    if (userDataStr) {
      try {
        userData = JSON.parse(userDataStr);
      } catch {
        // Ignore parse errors
      }
    }

    const userInfo = await verifyAppleCode(code, id_token, userData);
    const user = await handleOAuthUser(userInfo);
    await loginUser(user, req, res, false);

    // Redirect to frontend
    res.redirect(`${env.frontendUrl}/auth/callback?success=true`);
  } catch (error) {
    logger.error('Apple OAuth callback error:', error);
    res.redirect(`${env.frontendUrl}/auth/callback?error=oauth_failed`);
  }
};

// POST /auth/apple/token (for mobile/SPA)
export const appleToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { idToken, code, user: userData } = req.body;

    if (!idToken && !code) {
      throw ApiError.badRequest('Either idToken or code is required');
    }

    const userInfo = idToken
      ? await verifyAppleIdToken(idToken)
      : await verifyAppleCode(code, undefined, userData);

    const user = await handleOAuthUser(userInfo);
    const result = await loginUser(user, req, res, true, 'oauth_apple');

    res.json(result);
  } catch (error) {
    next(error);
  }
};

// ============================================
// FACEBOOK OAUTH
// ============================================

// GET /auth/facebook
export const facebookAuth = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const url = getFacebookAuthUrl();
    res.json({ url });
  } catch (error) {
    next(error);
  }
};

// GET /auth/facebook/callback
export const facebookCallback = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      throw new Error('No authorization code');
    }

    const userInfo = await verifyFacebookCode(code);
    const user = await handleOAuthUser(userInfo);
    await loginUser(user, req, res, false);

    // Redirect to frontend
    res.redirect(`${env.frontendUrl}/auth/callback?success=true`);
  } catch (error) {
    logger.error('Facebook OAuth callback error:', error);
    res.redirect(`${env.frontendUrl}/auth/callback?error=oauth_failed`);
  }
};

// POST /auth/facebook/token (for mobile/SPA)
export const facebookToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { accessToken, code } = req.body;

    if (!accessToken && !code) {
      throw ApiError.badRequest('Either accessToken or code is required');
    }

    const userInfo = accessToken
      ? await verifyFacebookAccessToken(accessToken)
      : await verifyFacebookCode(code);

    const user = await handleOAuthUser(userInfo);
    const result = await loginUser(user, req, res, true, 'oauth_facebook');

    res.json(result);
  } catch (error) {
    next(error);
  }
};

// ============================================
// USER PROFILE
// ============================================

// GET /auth/me
export const getMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    res.json({
      ...formatUserResponse(user, true),
      // Lets settings offer "Set password" to accounts that only use Google/Apple/Facebook.
      hasPassword: !!user.password,
      lastLoginAt: user.lastLoginAt,
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// API KEYS (for programmatic access)
// ============================================

// POST /auth/api-keys
export const createApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, permissions, expiresAt } = req.body;

    const user = await User.findById(req.userId);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    const { key, prefix, hashed } = generateApiKey();

    const apiKey = await ApiKey.create({
      userId: user._id,
      name,
      key: hashed,
      keyPrefix: prefix,
      permissions: permissions || ['read', 'write'],
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    // Return the actual key only once (never stored in plain text)
    res.status(201).json({
      id: apiKey._id,
      name: apiKey.name,
      key, // ⚠️ Only returned on creation!
      keyPrefix: apiKey.keyPrefix,
      permissions: apiKey.permissions,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    });
  } catch (error) {
    next(error);
  }
};

// GET /auth/api-keys
export const listApiKeys = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const apiKeys = await ApiKey.find({ userId: req.userId }).select('-key');
    res.json({ data: apiKeys });
  } catch (error) {
    next(error);
  }
};

// DELETE /auth/api-keys/:id
export const deleteApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await ApiKey.deleteOne({ _id: id, userId: req.userId });
    if (result.deletedCount === 0) {
      throw ApiError.notFound('API key not found');
    }

    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// ============================================
// LINK/UNLINK OAUTH ACCOUNTS
// ============================================

// POST /auth/link/:provider
export const linkOAuthAccount = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { provider } = req.params as { provider: OAuthProvider };
    const { idToken, accessToken, code } = req.body;

    const user = await User.findById(req.userId);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    // Check if already linked
    if (user.hasOAuthProvider(provider)) {
      throw ApiError.conflict(`${provider} account already linked`);
    }

    // Verify based on provider
    let userInfo: OAuthUserInfo;

    switch (provider) {
      case 'google':
        userInfo = idToken
          ? await verifyGoogleIdToken(idToken)
          : await verifyGoogleCode(code);
        break;
      case 'apple':
        userInfo = idToken
          ? await verifyAppleIdToken(idToken)
          : await verifyAppleCode(code);
        break;
      case 'facebook':
        userInfo = accessToken
          ? await verifyFacebookAccessToken(accessToken)
          : await verifyFacebookCode(code);
        break;
      default:
        throw ApiError.badRequest('Invalid provider');
    }

    // Check if this OAuth account is already linked to another user
    const existingUser = await User.findOne({
      oauthAccounts: { $elemMatch: { provider, providerId: userInfo.providerId } },
    });

    if (existingUser && existingUser._id.toString() !== user._id.toString()) {
      throw ApiError.conflict(`This ${provider} account is already linked to another user`);
    }

    // Link account
    user.oauthAccounts.push({
      provider: userInfo.provider,
      providerId: userInfo.providerId,
      email: userInfo.email,
      accessToken: userInfo.accessToken,
      refreshToken: userInfo.refreshToken,
    });
    await user.save();

    res.json({
      message: `${provider} account linked successfully`,
      linkedProviders: user.oauthAccounts.map((a) => a.provider),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /auth/unlink/:provider
export const unlinkOAuthAccount = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { provider } = req.params as { provider: OAuthProvider };

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    // Check if linked
    if (!user.hasOAuthProvider(provider)) {
      throw ApiError.notFound(`${provider} account not linked`);
    }

    // Ensure user has another way to login
    const hasPassword = !!user.password;
    const otherProviders = user.oauthAccounts.filter((a) => a.provider !== provider);

    if (!hasPassword && otherProviders.length === 0) {
      throw ApiError.badRequest(
        'Cannot unlink. You need at least one login method. Set a password first.'
      );
    }

    // Unlink
    user.oauthAccounts = user.oauthAccounts.filter((a) => a.provider !== provider);
    await user.save();

    res.json({
      message: `${provider} account unlinked successfully`,
      linkedProviders: user.oauthAccounts.map((a) => a.provider),
    });
  } catch (error) {
    next(error);
  }
};

// POST /auth/set-password (for OAuth users to add password)
export const setPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { password } = req.body;

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    if (user.password) {
      throw ApiError.badRequest('Password already set. Use change-password instead.');
    }

    user.password = password;
    if (user.authProvider !== 'local') {
      user.authProvider = 'local';
    }
    await user.save();

    res.json({ message: 'Password set successfully' });
  } catch (error) {
    next(error);
  }
};

// ============================================
// SESSION STATUS
// ============================================

// GET /auth/status (check if user is authenticated)
export const getStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.userId) {
      res.json({ authenticated: false });
      return;
    }

    const user = await User.findById(req.userId);
    if (!user) {
      res.json({ authenticated: false });
      return;
    }

    res.json({
      authenticated: true,
      user: formatUserResponse(user),
    });
  } catch (error) {
    next(error);
  }
};
