// services/session.service.ts
//
// Sign-in sessions: issuing tokens, rotating refresh tokens, detecting a
// stolen refresh token, and revoking sessions so access stops quickly.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { Session, type ISession } from '../models/Session';
import { User, type IUser } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { generateAccessToken, generateRefreshToken, hashRefreshToken } from '../utils/jwt';
import { logger } from '../utils/logger';

/**
 * The previous refresh token keeps working until the new one is used (or this
 * long, at most). A response carrying the new cookie can get lost (an action or
 * a fetch that refreshed but didn't set it), and the browser then still holds
 * the old token; that must not look like theft. A token two or more rotations
 * old does mean two holders, and revokes the session.
 */
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
/** How long "is this session still active?" answers are cached per process. */
const ACTIVE_CACHE_MS = 10_000;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  sessionId: string;
}

export interface SessionContext {
  method: string;
  userAgent?: string;
  ip?: string;
  device?: string;
  location?: string | null;
}

// ---------------------------------------------------------------------------
// Encryption of the token kept for the grace window
// ---------------------------------------------------------------------------

function replayKey(): Buffer {
  return crypto.createHash('sha256').update(`${env.jwtRefreshSecret}:session-replay`).digest();
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', replayKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(sealed: string): string | null {
  try {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', replayKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token issuing
// ---------------------------------------------------------------------------

function secondsUntilExpiry(token: string): number {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return decoded?.exp ? Math.max(0, decoded.exp - Math.floor(Date.now() / 1000)) : 0;
}

function tokensFor(user: Pick<IUser, '_id' | 'email' | 'role'>, sessionId: string): Omit<SessionTokens, 'sessionId'> & { refreshExpiresAt: Date } {
  const payload = { userId: user._id.toString(), email: user.email, role: user.role, sid: sessionId };
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);
  return {
    accessToken,
    refreshToken,
    expiresIn: secondsUntilExpiry(accessToken),
    refreshExpiresAt: new Date(Date.now() + secondsUntilExpiry(refreshToken) * 1000),
  };
}

/** Starts a session for a fresh sign-in and returns its tokens. */
export async function createSession(user: IUser, context: SessionContext): Promise<SessionTokens> {
  const sessionId = new Types.ObjectId();
  const tokens = tokensFor(user, sessionId.toString());
  await Session.create({
    _id: sessionId,
    userId: user._id,
    tokenHash: hashRefreshToken(tokens.refreshToken),
    method: context.method,
    userAgent: context.userAgent?.slice(0, 500),
    ip: context.ip,
    device: context.device,
    location: context.location ?? null,
    expiresAt: tokens.refreshExpiresAt,
  });
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn, sessionId: sessionId.toString() };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

const sessionEnded = () => ApiError.withCode(401, 'SESSION_INVALID', 'Your session has ended. Sign in again.');

/**
 * Exchanges a refresh token for new tokens. The refresh token rotates every
 * time. The previous token (until the new one is used) returns the same new
 * refresh token, so parallel requests and lost cookies are harmless. An older
 * token means it was copied: the session is revoked for everyone holding it.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  context: Omit<SessionContext, 'method'> = {}
): Promise<SessionTokens & { user: IUser }> {
  let payload: any;
  try {
    payload = jwt.verify(refreshToken, env.jwtRefreshSecret);
  } catch {
    throw sessionEnded();
  }
  if (payload?.tokenType !== 'refresh' || !payload.userId) throw sessionEnded();

  const hash = hashRefreshToken(refreshToken);

  // Tokens issued before sessions existed: accept once and move them to a session.
  if (!payload.sid) {
    const user = await User.findOneAndUpdate(
      { _id: payload.userId, refreshTokens: hash },
      { $pull: { refreshTokens: hash } },
      { new: true }
    );
    if (!user) throw sessionEnded();
    const tokens = await createSession(user, { ...context, method: 'migrated' });
    return { ...tokens, user };
  }

  const session = await Session.findById(payload.sid).select('+pendingToken');
  if (!session || session.revokedAt || session.expiresAt < new Date() || String(session.userId) !== String(payload.userId)) {
    throw sessionEnded();
  }
  const user = await User.findById(session.userId);
  if (!user) throw sessionEnded();

  if (hash === session.tokenHash) {
    const next = tokensFor(user, session._id.toString());
    // Conditional on the current hash, so two concurrent rotations can't both win.
    const rotated = await Session.findOneAndUpdate(
      { _id: session._id, tokenHash: hash, revokedAt: null },
      {
        $set: {
          tokenHash: hashRefreshToken(next.refreshToken),
          prevTokenHash: hash,
          prevValidUntil: new Date(Date.now() + ROTATION_GRACE_MS),
          pendingToken: encrypt(next.refreshToken),
          lastUsedAt: new Date(),
          expiresAt: next.refreshExpiresAt,
          ...(context.ip ? { ip: context.ip } : {}),
        },
      },
      { new: true }
    );
    if (rotated) {
      return { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresIn: next.expiresIn, sessionId: session._id.toString(), user };
    }
    // Lost the race: another request just rotated it. Fall through to the grace path.
    return rotateRefreshToken(refreshToken, context);
  }

  if (hash === session.prevTokenHash && session.prevValidUntil && session.prevValidUntil > new Date() && session.pendingToken) {
    const current = decrypt(session.pendingToken);
    if (current) {
      const accessToken = generateAccessToken({ userId: user._id.toString(), email: user.email, role: user.role, sid: session._id.toString() });
      return { accessToken, refreshToken: current, expiresIn: secondsUntilExpiry(accessToken), sessionId: session._id.toString(), user };
    }
  }

  // An old token used after rotation: someone else has a copy.
  await revokeSession(session._id.toString(), 'refresh_token_reuse');
  logger.warn('Refresh token reuse detected; session revoked', { userId: String(user._id), sessionId: String(session._id) });
  throw ApiError.withCode(401, 'SESSION_REVOKED', 'For your security you were signed out. Sign in again.');
}

// ---------------------------------------------------------------------------
// Revocation and lookup
// ---------------------------------------------------------------------------

const activeCache = new Map<string, { active: boolean; until: number }>();

function forget(sessionId: string): void {
  activeCache.delete(sessionId);
}

export async function revokeSession(sessionId: string, reason: string, userId?: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(sessionId)) return false;
  const result = await Session.updateOne(
    { _id: sessionId, revokedAt: null, ...(userId ? { userId } : {}) },
    { $set: { revokedAt: new Date(), revokedReason: reason }, $unset: { pendingToken: '' } }
  );
  forget(sessionId);
  return result.modifiedCount > 0;
}

/** Ends every session of a user (and legacy refresh tokens), optionally keeping one. */
export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (exceptSessionId && Types.ObjectId.isValid(exceptSessionId)) filter._id = { $ne: exceptSessionId };
  const sessions = await Session.find(filter).select('_id').lean();
  if (sessions.length) {
    await Session.updateMany({ _id: { $in: sessions.map((s) => s._id) } }, { $set: { revokedAt: new Date(), revokedReason: reason }, $unset: { pendingToken: '' } });
  }
  sessions.forEach((s) => forget(String(s._id)));
  await User.updateOne({ _id: userId }, { $set: { refreshTokens: [] } });
  return sessions.length;
}

/** Whether an access token's session is still live. Cached briefly per process. */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const cached = activeCache.get(sessionId);
  if (cached && cached.until > Date.now()) return cached.active;
  const active = Types.ObjectId.isValid(sessionId)
    ? !!(await Session.exists({ _id: sessionId, revokedAt: null, expiresAt: { $gt: new Date() } }))
    : false;
  activeCache.set(sessionId, { active, until: Date.now() + ACTIVE_CACHE_MS });
  if (activeCache.size > 10_000) activeCache.clear();
  return active;
}

export async function listSessions(userId: string): Promise<ISession[]> {
  return Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 }).limit(50).lean() as any;
}
