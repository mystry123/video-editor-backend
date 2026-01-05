import { Response, NextFunction } from 'express';
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
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    await ApiKey.updateOne({ _id: keyRecord._id }, { lastUsedAt: new Date() });

    const user = await User.findById(keyRecord.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
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
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);

    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.userId = payload.userId;
    req.user = user;
    req.authMethod = 'bearer';
    next();
  } catch (error) {
    logger.error('Bearer auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ============================================
// COOKIE/JWT AUTHENTICATION
// ============================================

export const cookieAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];

  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);

    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.userId = payload.userId;
    req.user = user;
    req.authMethod = 'cookie';
    next();
  } catch (error) {
    logger.error('Cookie auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ============================================
// COMBINED AUTHENTICATION (UPDATED!)
// ============================================

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // 1. Try API key (X-API-Key header)
  const apiKey = req.header('X-API-Key');
  if (apiKey) {
    return apiKeyAuth(req, res, next);
  }

  // 2. Try Bearer token (Authorization header) ← NEW!
  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return bearerAuth(req, res, next);
  }

  // 3. Try cookie
  const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
  if (token) {
    return cookieAuth(req, res, next);
  }

  // 4. No credentials
  res.status(401).json({ error: 'Authentication required' });
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

  // Try cookie
  const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      if (payload) {
        const user = await User.findById(payload.userId);
        if (user) {
          req.userId = payload.userId;
          req.user = user;
          req.authMethod = 'cookie';
        }
      }
    } catch (error) {
      logger.debug('Optional cookie auth failed:', error);
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
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

// ============================================
// PERMISSION-BASED ACCESS CONTROL
// ============================================

// Require specific permissions (for API key access)
export const requirePermission = (permission: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Admin role always has all permissions
    if (req.user.role === 'admin') {
      return next();
    }

    // Check API key permissions
    if (req.authMethod === 'api-key' && req.permissions) {
      if (!req.permissions.includes(permission) && !req.permissions.includes('admin')) {
        res.status(403).json({ error: `Permission '${permission}' required` });
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
    res.status(401).json({ error: 'Browser authentication required' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);

    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.userId = payload.userId;
    req.user = user;
    req.authMethod = 'cookie';
    next();
  } catch (error) {
    logger.error('Cookie auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};
