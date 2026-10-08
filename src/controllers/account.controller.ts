// controllers/account.controller.ts
//
// The signed-in user's own account: profile, avatar, plan usage, sign-in
// history and account deletion. Everything here acts on req.userId only.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { UserLoginHistory } from '../models/UserLoginHistory';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getEffectiveQuota, isOverrideActive } from '../config/quotas';
import { getPlan } from '../services/plan.service';
import { getUsageSnapshot } from '../middleware/quota.middleware';
import { createPresignedUpload, deleteFromS3 } from '../services/storage.service';
import { accountCleanupQueue } from '../queues';
import { purgeUserData } from '../services/accountCleanup.service';
import { listSessions, revokeSession } from '../services/session.service';
import { generateUploadTicket } from '../utils/jwt';

const AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function avatarPrefix(userId: string): string {
  return `users/${userId}/avatars/`;
}

function avatarUrlPrefix(userId: string): string {
  return `${env.cdnUrl.replace(/\/$/, '')}/${avatarPrefix(userId)}`;
}

// GET /auth/me/usage
export const getMyUsage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) throw ApiError.notFound('User not found');

    const plan = getPlan(user.role);
    const usage = await getUsageSnapshot(String(user._id));
    const now = new Date();

    res.json({
      plan: { key: user.role, name: plan?.name || user.role, description: plan?.description },
      limits: getEffectiveQuota(user as any),
      overrides: (user.planOverrides || [])
        .filter((o) => isOverrideActive(o, now))
        .map((o) => ({ field: o.field, value: o.value, expiresAt: o.expiresAt || null })),
      usage,
    });
  } catch (error) {
    next(error);
  }
};

// POST /auth/me/avatar-upload — presigned upload for a new avatar image
export const createAvatarUpload = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { mimeType, size } = req.body as { mimeType: string; size: number };
    const ext = AVATAR_TYPES[mimeType];
    if (!ext) throw ApiError.withCode(400, 'AVATAR_TYPE', 'Use a JPG, PNG, WebP or GIF image.');
    if (size > AVATAR_MAX_BYTES) throw ApiError.withCode(400, 'AVATAR_TOO_LARGE', 'Avatar images can be up to 5 MB.');

    const key = `${avatarPrefix(req.userId!)}${uuidv4()}.${ext}`;
    const { url, fields } = await createPresignedUpload({ key, contentType: mimeType, maxSize: AVATAR_MAX_BYTES });

    res.json({ uploadUrl: url, fields, avatarUrl: `${avatarUrlPrefix(req.userId!)}${key.split('/').pop()}` });
  } catch (error) {
    next(error);
  }
};

// PUT /auth/me — name and avatar
export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, avatarUrl } = req.body as { name?: string; avatarUrl?: string };

    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');

    const previousAvatar = user.avatarUrl;
    if (name !== undefined) user.name = name.trim();
    if (avatarUrl !== undefined) {
      // Only avatars uploaded through createAvatarUpload (or removal) are accepted,
      // so a profile can't point at an arbitrary URL.
      if (avatarUrl !== '' && !avatarUrl.startsWith(avatarUrlPrefix(req.userId!))) {
        throw ApiError.withCode(400, 'AVATAR_URL', 'Upload the avatar image first.');
      }
      user.avatarUrl = avatarUrl || undefined;
    }
    await user.save();

    // Remove the replaced avatar file; a leftover file is harmless, so don't fail the request.
    if (avatarUrl !== undefined && previousAvatar && previousAvatar !== user.avatarUrl) {
      const prefix = avatarUrlPrefix(req.userId!);
      if (previousAvatar.startsWith(prefix)) {
        deleteFromS3(`${avatarPrefix(req.userId!)}${previousAvatar.slice(prefix.length)}`).catch((error) =>
          logger.warn('Failed to delete previous avatar', { error: error.message })
        );
      }
    }

    res.json({
      _id: user._id.toString(),
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      isVerified: user.isVerified,
      authProvider: user.authProvider,
      createdAt: user.createdAt,
    });
  } catch (error) {
    next(error);
  }
};

function describeBrowser(userAgent: string): string {
  const ua = userAgent || '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

// GET /auth/me/sign-ins
export const getSignInHistory = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);
    const events = await UserLoginHistory.getRecentLogins(req.userId!, limit);

    res.json({
      data: events.map((e) => ({
        at: e.timestamp,
        browser: describeBrowser(e.userAgent),
        device: e.device,
        ip: e.ip,
        location: [e.location?.city, e.location?.country].filter(Boolean).join(', ') || null,
        method: e.loginType,
        success: e.success,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /auth/me — deletes the account now, data in the background
export const deleteAccount = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { confirmEmail, password } = req.body as { confirmEmail: string; password?: string };

    const user = await User.findById(req.userId).select('+password');
    if (!user) throw ApiError.notFound('User not found');

    if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw ApiError.withCode(400, 'CONFIRM_EMAIL_MISMATCH', "The email you typed doesn't match this account.");
    }
    if (user.password) {
      if (!password || !(await user.comparePassword(password))) {
        throw ApiError.withCode(400, 'WRONG_PASSWORD', 'That password is incorrect.');
      }
    }
    if (user.role === 'admin' && (await User.countDocuments({ role: 'admin' })) <= 1) {
      throw ApiError.withCode(409, 'LAST_ADMIN', "You're the only admin. Make someone else an admin before deleting this account.");
    }

    const userId = user._id.toString();
    await User.deleteOne({ _id: user._id });

    // jobId makes a repeated request a no-op instead of a second cleanup.
    try {
      await accountCleanupQueue.add('purge', { userId }, { jobId: `account-cleanup-${userId}` });
    } catch (error: any) {
      // Queue unavailable: clean up in-process rather than leave the data behind.
      logger.error('Account cleanup enqueue failed; purging inline', { userId, error: error.message });
      purgeUserData(userId).catch((err) =>
        logger.error('Inline account purge failed; data needs manual cleanup', { userId, error: err.message })
      );
    }

    res.json({ message: 'Account deleted' });
  } catch (error) {
    next(error);
  }
};

// GET /auth/sessions — devices currently signed in
export const getSessions = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessions = await listSessions(req.userId!);
    res.json({
      data: sessions.map((session) => ({
        id: String(session._id),
        current: String(session._id) === req.sessionId,
        browser: describeBrowser(session.userAgent || ''),
        device: session.device || null,
        location: session.location || null,
        ip: session.ip || null,
        method: session.method,
        signedInAt: session.createdAt,
        lastActiveAt: session.lastUsedAt,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /auth/sessions/:id — sign out one device
export const revokeSessionById = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const revoked = await revokeSession(req.params.id, 'signed_out_from_settings', req.userId);
    if (!revoked) throw ApiError.notFound('That session has already ended.');
    res.json({ message: 'Signed out', current: req.params.id === req.sessionId });
  } catch (error) {
    next(error);
  }
};

// POST /auth/upload-ticket — short-lived token for browser-direct uploads
export const createUploadTicket = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user;
    const { ticket, expiresIn } = generateUploadTicket({
      userId: String(user._id),
      email: user.email,
      role: user.role,
      sid: req.sessionId,
    });
    res.json({ ticket, expiresIn });
  } catch (error) {
    next(error);
  }
};
