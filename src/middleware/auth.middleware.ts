import { Response, NextFunction } from 'express';
import { sendError } from '../utils/errorResponse';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { ApiKey } from '../models/ApiKey';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../utils/jwt';
import { hashApiKey } from '../utils/helpers';
import { COOKIE_NAMES } from '../config/cookies';
import { logger } from '../utils/logger';

// ============================================
// API KEY AUTHENTICATION
// ============================================


export const apiKeyAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const apiKey = req.header('X-API-Key');

  if (!apiKey) {
    return next();
  }

  try {
    const hashedKey = hashApiKey(apiKey);
    const keyRecord = await ApiKey.findOne({
      key: hashedKey,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });

    if (!keyRecord) {
      sendError(req, res, 401, 'Invalid API key', 'INVALID_API_KEY');
      return;
    }

    await ApiKey.updateOne({ _id: keyRecord._id }, { lastUsedAt: new Date() });

    const user = await User.findById(keyRecord.userId);
    if (!user) {
      sendError(req, res, 401, 'User not found', 'SESSION_INVALID');
      return;
    }

    req.userId = user._id.toString();
    req.user = user;
    req.permissions = keyRecord.permissions;
    req.authMethod = 'api-key';
    next();
  } catch (error) {
    next(error);
  }
};

// ============================================
// BEARER TOKEN AUTHENTICATION (NEW!)
// ============================================

export const bearerAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(req, res, 401, 'Bearer token required', 'AUTH_REQUIRED');
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);

    if (!payload) {
      sendError(req, res, 401, 'Invalid or expired token', 'SESSION_INVALID');
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      sendError(req, res, 401, 'User not found', 'SESSION_INVALID');
      return;
    }

    req.userId = payload.userId;
    req.user = user;
    req.authMethod = 'bearer';
    next();
  } catch (error) {
    logger.error('Bearer auth error:', error);
    sendError(req, res, 401, 'Authentication failed', 'SESSION_INVALID');
  }
};



// ============================================
// COMBINED AUTHENTICATION (Bearer Token First)
// ============================================

// Tries Bearer token first, then API key
export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // 1. Try Bearer token (Authorization header)
  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return bearerAuth(req, res, next);
  }

  // 2. Try API key
  const apiKey = req.header('X-API-Key');
  if (apiKey) {
    return apiKeyAuth(req, res, next);
  }

  // 3. No credentials
  sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
};

// ============================================
// OPTIONAL AUTHENTICATION
// ============================================

// Doesn't fail if no auth, but attaches user if authenticated
// Useful for endpoints that behave differently for logged-in users
export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // Try API key
  const apiKey = req.header('X-API-Key');
  if (apiKey) {
    try {
      const hashedKey = hashApiKey(apiKey);
      const keyRecord = await ApiKey.findOne({
        key: hashedKey,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      });

      if (keyRecord) {
        const user = await User.findById(keyRecord.userId);
        if (user) {
          req.userId = user._id.toString();
          req.user = user;
          req.permissions = keyRecord.permissions;
          req.authMethod = 'api-key';
        }
      }
    } catch (error) {
      logger.debug('Optional API key auth failed:', error);
    }
    return next();
  }

  // Try Bearer token
  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const payload = verifyAccessToken(token);
      if (payload) {
        const user = await User.findById(payload.userId);
        if (user) {
          req.userId = payload.userId;
          req.user = user;
          req.authMethod = 'bearer';
        }
      }
    } catch (error) {
      logger.debug('Optional bearer auth failed:', error);
    }
  }

  next();
};

// ============================================
// ROLE-BASED ACCESS CONTROL
// ============================================

// Require specific roles
export const requireRole = (roles: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
      return;
    }

    if (!roles.includes(req.user.role)) {
      sendError(req, res, 403, 'Insufficient permissions', 'FORBIDDEN');
      return;
    }

    next();
  };
};

// Account-level changes (password, deleting the account, admin actions) need a
// signed-in session; an API key alone isn't enough.
export const requireSession = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.authMethod === 'api-key') {
    sendError(req, res, 403, "Sign in to do this. API keys can't change account settings.", 'SESSION_REQUIRED');
    return;
  }
  next();
};

// ============================================
// PERMISSION-BASED ACCESS CONTROL
// ============================================

// Require specific permissions (for API key access)
export const requirePermission = (permission: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      sendError(req, res, 401, 'Authentication required', 'AUTH_REQUIRED');
      return;
    }

    // Admin role always has all permissions
    if (req.user.role === 'admin') {
      return next();
    }

    // Check API key permissions
    if (req.authMethod === 'api-key' && req.permissions) {
      if (!req.permissions.includes(permission) && !req.permissions.includes('admin')) {
        sendError(req, res, 403, `Permission '${permission}' required`, 'PERMISSION_REQUIRED');
        return;
      }
    }

    next();
  };
};

// ============================================
// COOKIE-ONLY ROUTES
// ============================================

// For routes that should ONLY work with browser (cookie) auth
// Example: OAuth linking (shouldn't be done via API key)
export const requireCookieAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];

  if (!token) {
    sendError(req, res, 401, 'Browser authentication required', 'AUTH_REQUIRED');
    return;
  }

  try {
    const payload = verifyAccessToken(token);

    if (!payload) {
      sendError(req, res, 401, 'Invalid or expired session', 'SESSION_INVALID');
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      sendError(req, res, 401, 'User not found', 'SESSION_INVALID');
      return;
    }

    req.userId = payload.userId;
    req.user = user;
    req.authMethod = 'cookie';
    next();
  } catch (error) {
    logger.error('Cookie auth error:', error);
    sendError(req, res, 401, 'Authentication failed', 'SESSION_INVALID');
  }
};
