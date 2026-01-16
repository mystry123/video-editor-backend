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
    response.storageUsed = user.storageUsed;
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
  const tokenPayload = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  };

  const tokens = generateTokenPair(tokenPayload);
  const hashedRefresh = hashRefreshToken(tokens.refreshToken);

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

    // Debug: Login token generation
    console.log('LOGIN TOKEN DEBUG:', {
      generatedRefreshToken: tokens.refreshToken,
      generatedRefreshTokenLength: tokens.refreshToken.length,
      hashedRefreshToken: hashedRefresh,
      hashedRefreshPrefix: hashedRefresh.substring(0, 10) + '...',
      metaData,
    });

    // Save login metadata in separate collection
    try {
      await UserLoginHistory.addLoginEvent(user._id.toString(), metaData);
    } catch (error) {
      console.error('Failed to save login metadata:', error);
      // Don't fail the login if metadata saving fails
    }
  }

  // Store hashed refresh token (keep last 5 for multi-device support)
  await User.findByIdAndUpdate(user._id, {
    $push: { refreshTokens: { $each: [hashedRefresh], $slice: -5 } },
    lastLoginAt: new Date(),
  });

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
  // Check if user exists with this OAuth provider
  let user = await User.findOne({
    'oauthAccounts.provider': userInfo.provider,
    'oauthAccounts.providerId': userInfo.providerId,
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

  // Check if user exists with same email
  user = await User.findOne({ email: userInfo.email });

  if (user) {
    // Link OAuth account to existing user
    user.oauthAccounts.push({
      provider: userInfo.provider,
      providerId: userInfo.providerId,
      email: userInfo.email,
      accessToken: userInfo.accessToken,
      refreshToken: userInfo.refreshToken,
    });
    await user.save();
    return user;
  }

  // Create new user
  user = await User.create({
    email: userInfo.email,
    name: userInfo.name,
    avatarUrl: userInfo.avatarUrl,
    authProvider: userInfo.provider,
    isVerified: true, // OAuth users are pre-verified
    oauthAccounts: [
      {
        provider: userInfo.provider,
        providerId: userInfo.providerId,
        email: userInfo.email,
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
      throw ApiError.unauthorized('Invalid email or password');
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
      throw ApiError.unauthorized('Invalid email or password');
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
    // Get refresh token from request body
    const { refreshToken } = req.body;

    // Remove refresh token from DB if exists
    if (refreshToken && req.userId) {
      const hashedToken = hashRefreshToken(refreshToken);
      await User.findByIdAndUpdate(req.userId, {
        $pull: { refreshTokens: hashedToken },
      });
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
    // Clear all refresh tokens
    if (req.userId) {
      await User.findByIdAndUpdate(req.userId, {
        $set: { refreshTokens: [] },
      });
    }

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

    console.log("refresh token",refreshToken)

    if (!refreshToken) {
      throw ApiError.unauthorized('No refresh token');
    }

    // Debug logging
    logger.info('Refresh attempt', {
      hasRefreshToken: !!refreshToken,
      refreshTokenLength: refreshToken?.length,
      refreshTokenPrefix: refreshToken?.substring(0, 20) + '...',
    });

    // Verify token
    const payload = verifyRefreshToken(refreshToken);
    logger.info('Token verification result', {
      payload: !!payload,
      userId: payload?.userId,
    });
    
    if (!payload) {
      throw ApiError.unauthorized('Invalid refresh token');
    }

    // Check if token exists in user's tokens (not revoked)
    const hashedToken = hashRefreshToken(refreshToken);
    
    // Debug: Manual hash calculation
    const crypto = require('crypto');
    const manualHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    
    console.log('HASHING DEBUG:', {
      originalToken: refreshToken,
      originalTokenLength: refreshToken.length,
      functionHash: hashedToken,
      manualHash: manualHash,
      hashesMatch: hashedToken === manualHash,
      functionHashPrefix: hashedToken.substring(0, 10) + '...',
      manualHashPrefix: manualHash.substring(0, 10) + '...',
    });
    
    // Debug: Check user's stored tokens
    const userWithTokens = await User.findById(payload.userId).select('+refreshTokens');
    console.log({userWithTokens});
    const debugInfo = {
      userId: payload.userId,
      userExists: !!userWithTokens,
      storedTokenCount: userWithTokens?.refreshTokens?.length || 0,
      hashedTokenPrefix: hashedToken.substring(0, 10) + '...',
      storedTokenPrefixes: userWithTokens?.refreshTokens?.map((t: string) => t.substring(0, 10) + '...') || [],
      exactHashMatch: userWithTokens?.refreshTokens?.includes(hashedToken),
    };
    
    console.log('DEBUG DATABASE LOOKUP:', JSON.stringify(debugInfo, null, 2));
    logger.info('Database lookup', debugInfo);
    
    const user = await User.findOne({
      _id: payload.userId,
      refreshTokens: hashedToken,
    }).select('+refreshTokens');

    logger.info('Token lookup result', {
      found: !!user,
    });

    if (!user) {
      throw ApiError.unauthorized('Invalid refresh token');
    }

    // Remove old token (token rotation)
    await User.findByIdAndUpdate(user._id, {
      $pull: { refreshTokens: hashedToken },
    });

    // Generate NEW access token only (keep refresh token rotation minimal)
    const newAccessToken = generateAccessToken({
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
    });

    // Re-add the same refresh token (no rotation unless needed)
    await User.findByIdAndUpdate(user._id, {
      $push: { refreshTokens: hashedToken },
    });

    res.json({
      user: formatUserResponse(user),
      accessToken: newAccessToken,
      refreshToken: refreshToken, // Return the same refresh token
      expiresIn: 900, // 15 minutes
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
    user.refreshTokens = []; // Invalidate all sessions
    await user.save();


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
      throw ApiError.unauthorized('Current password is incorrect');
    }

    // Update password and clear all sessions
    user.password = newPassword;
    user.refreshTokens = [];
    await user.save();

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
    const user = await User.findById(req.userId);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    res.json(formatUserResponse(user, true));
  } catch (error) {
    next(error);
  }
};

// PUT /auth/me
export const updateMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, avatarUrl } = req.body;

    const user = await User.findByIdAndUpdate(
      req.userId,
      { name, avatarUrl },
      { new: true }
    );

    if (!user) {
      throw ApiError.notFound('User not found');
    }

    res.json(formatUserResponse(user));
  } catch (error) {
    next(error);
  }
};

// DELETE /auth/me
export const deleteMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await User.findByIdAndDelete(req.userId);
    await ApiKey.deleteMany({ userId: req.userId });

    res.json({ message: 'Account deleted successfully' });
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
      'oauthAccounts.provider': provider,
      'oauthAccounts.providerId': userInfo.providerId,
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
