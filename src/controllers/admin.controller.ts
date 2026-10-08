// controllers/admin.controller.ts
//
// Admin-only: look up users, change their plan, add per-user limit overrides,
// and edit plan limits. Every change writes an AuditLog entry.

import { Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { AuditLog, type AuditAction } from '../models/AuditLog';
import { ApiError } from '../utils/ApiError';
import { getEffectiveQuota, isOverrideActive, type UserQuota } from '../config/quotas';
import { QUOTA_FIELDS, QUOTA_FIELD_GROUPS, getQuotaField, parseQuotaValue } from '../config/quotaFields';
import { getPlan, listPlans, updatePlan } from '../services/plan.service';
import { getUsageSnapshot } from '../middleware/quota.middleware';

const PLAN_KEYS = ['free', 'pro', 'team', 'admin'];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertObjectId(id: string, what = 'User'): void {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound(`${what} not found`);
}

async function audit(
  req: AuthRequest,
  entry: { action: AuditAction; targetType: 'plan' | 'user'; targetId: string; summary: string; before?: unknown; after?: unknown }
): Promise<void> {
  await AuditLog.create({ actorId: req.user._id, actorEmail: req.user.email, ...entry });
}

function describeValue(key: string, value: unknown): string {
  const field = getQuotaField(key);
  if (value === -1) return 'unlimited';
  if (!field) return JSON.stringify(value);
  switch (field.type) {
    case 'bytes': {
      const gb = Number(value) / 1024 ** 3;
      return gb >= 1 ? `${+gb.toFixed(2)} GB` : `${Math.round(Number(value) / 1024 ** 2)} MB`;
    }
    case 'minutes':
      return `${value} min`;
    case 'seconds':
      return `${value} s`;
    case 'boolean':
      return value ? 'on' : 'off';
    case 'resolutions':
      return (value as string[]).join(', ');
    default:
      return String(value);
  }
}

function serializeOverride(o: any, now = new Date()) {
  return {
    id: String(o._id),
    field: o.field,
    value: o.value,
    expiresAt: o.expiresAt || null,
    note: o.note || null,
    createdAt: o.createdAt,
    active: isOverrideActive(o, now),
  };
}

// GET /admin/users?q=&role=&page=&limit=
export const listUsers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || '');
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 50);

    const filter: Record<string, unknown> = {};
    if (q) {
      const pattern = new RegExp(escapeRegex(q.slice(0, 100)), 'i');
      filter.$or = [{ email: pattern }, { name: pattern }];
    }
    if (PLAN_KEYS.includes(role)) filter.role = role;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('email name avatarUrl role createdAt lastLoginAt planOverrides')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const now = new Date();
    res.json({
      data: users.map((u) => ({
        id: String(u._id),
        email: u.email,
        name: u.name || null,
        avatarUrl: u.avatarUrl || null,
        plan: u.role,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt || null,
        activeOverrides: (u.planOverrides || []).filter((o) => isOverrideActive(o, now)).length,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// GET /admin/users/:id
export const getUserDetail = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertObjectId(req.params.id);
    const user = await User.findById(req.params.id).select('+password').lean();
    if (!user) throw ApiError.notFound('User not found');

    const [usage, history] = await Promise.all([
      getUsageSnapshot(String(user._id)),
      AuditLog.find({ targetType: 'user', targetId: String(user._id) }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    res.json({
      user: {
        id: String(user._id),
        email: user.email,
        name: user.name || null,
        avatarUrl: user.avatarUrl || null,
        plan: user.role,
        isVerified: user.isVerified,
        authProvider: user.authProvider,
        hasPassword: !!user.password,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt || null,
      },
      planLimits: getPlan(user.role)?.limits,
      effectiveLimits: getEffectiveQuota(user as any),
      overrides: (user.planOverrides || []).map((o) => serializeOverride(o)),
      usage,
      history: history.map((h) => ({ at: h.createdAt, by: h.actorEmail, action: h.action, summary: h.summary })),
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /admin/users/:id/plan  { plan }
export const changeUserPlan = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertObjectId(req.params.id);
    const { plan } = req.body as { plan: string };
    if (!PLAN_KEYS.includes(plan)) throw ApiError.badRequest('Choose a valid plan.');
    if (req.params.id === String(req.user._id)) {
      throw ApiError.withCode(409, 'SELF_PLAN_CHANGE', "You can't change your own plan here. Ask another admin.");
    }

    const user = await User.findById(req.params.id).select('email role');
    if (!user) throw ApiError.notFound('User not found');
    const before = user.role;
    if (before === plan) {
      res.json({ plan });
      return;
    }

    user.role = plan as any;
    await user.save();
    await audit(req, {
      action: 'user.plan.change',
      targetType: 'user',
      targetId: String(user._id),
      summary: `Plan changed from ${getPlan(before)?.name || before} to ${getPlan(plan)?.name || plan}`,
      before: { plan: before },
      after: { plan },
    });

    res.json({ plan });
  } catch (error) {
    next(error);
  }
};

// POST /admin/users/:id/overrides  { field, value, expiresAt?, note? }
export const addUserOverride = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertObjectId(req.params.id);
    const { field, value, expiresAt, note } = req.body as {
      field: string;
      value: unknown;
      expiresAt?: string | null;
      note?: string;
    };

    const parsed = parseQuotaValue(field, value);
    if (!parsed.ok) throw ApiError.withCode(400, 'INVALID_LIMIT', parsed.error);

    let expiry: Date | null = null;
    if (expiresAt) {
      expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
        throw ApiError.withCode(400, 'INVALID_EXPIRY', 'The end date has to be in the future.');
      }
    }

    const user = await User.findById(req.params.id).select('email planOverrides');
    if (!user) throw ApiError.notFound('User not found');

    // One override per limit: a new one replaces the old.
    const replaced = user.planOverrides.find((o) => o.field === field);
    user.planOverrides = user.planOverrides.filter((o) => o.field !== field) as any;
    user.planOverrides.push({
      field,
      value: parsed.value,
      expiresAt: expiry,
      note: note?.trim() || undefined,
      createdBy: req.user._id,
      createdAt: new Date(),
    } as any);
    await user.save();

    const label = getQuotaField(field)!.label;
    await audit(req, {
      action: 'user.override.add',
      targetType: 'user',
      targetId: String(user._id),
      summary: `${label} set to ${describeValue(field, parsed.value)}${expiry ? ` until ${expiry.toISOString().slice(0, 10)}` : ''}${note ? ` (${note.trim()})` : ''}`,
      before: replaced ? { field, value: replaced.value, expiresAt: replaced.expiresAt } : undefined,
      after: { field, value: parsed.value, expiresAt: expiry },
    });

    res.status(201).json({ overrides: user.planOverrides.map((o) => serializeOverride(o)) });
  } catch (error) {
    next(error);
  }
};

// DELETE /admin/users/:id/overrides/:overrideId
export const removeUserOverride = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertObjectId(req.params.id);
    const user = await User.findById(req.params.id).select('email planOverrides');
    if (!user) throw ApiError.notFound('User not found');

    const override = user.planOverrides.find((o) => String(o._id) === req.params.overrideId);
    if (!override) throw ApiError.notFound('That override no longer exists.');

    user.planOverrides = user.planOverrides.filter((o) => String(o._id) !== req.params.overrideId) as any;
    await user.save();

    await audit(req, {
      action: 'user.override.remove',
      targetType: 'user',
      targetId: String(user._id),
      summary: `${getQuotaField(override.field)?.label || override.field} override removed (was ${describeValue(override.field, override.value)})`,
      before: { field: override.field, value: override.value, expiresAt: override.expiresAt },
    });

    res.json({ overrides: user.planOverrides.map((o) => serializeOverride(o)) });
  } catch (error) {
    next(error);
  }
};

// GET /admin/plans
export const getPlans = async (_req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const counts = await User.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
    const userCount = new Map(counts.map((c) => [c._id, c.count]));

    res.json({
      plans: listPlans().map((plan) => ({ ...plan, userCount: userCount.get(plan.key) || 0 })),
      fields: QUOTA_FIELDS,
      groups: QUOTA_FIELD_GROUPS,
    });
  } catch (error) {
    next(error);
  }
};

// PUT /admin/plans/:key  { name?, description?, limits? }
export const editPlan = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { key } = req.params;
    if (!PLAN_KEYS.includes(key)) throw ApiError.notFound('Plan not found');

    const { name, description, limits } = req.body as {
      name?: string;
      description?: string;
      limits?: Record<string, unknown>;
    };

    const current = getPlan(key)!;
    const changedLimits: Partial<UserQuota> = {};
    const changes: string[] = [];
    for (const [field, value] of Object.entries(limits || {})) {
      const parsed = parseQuotaValue(field, value);
      if (!parsed.ok) throw ApiError.withCode(400, 'INVALID_LIMIT', parsed.error);
      const previous = (current.limits as any)[field];
      if (JSON.stringify(previous) === JSON.stringify(parsed.value)) continue;
      (changedLimits as any)[field] = parsed.value;
      changes.push(`${getQuotaField(field)!.label}: ${describeValue(field, previous)} → ${describeValue(field, parsed.value)}`);
    }

    const trimmedName = name?.trim();
    if (trimmedName !== undefined && (trimmedName.length < 2 || trimmedName.length > 60)) {
      throw ApiError.badRequest('Plan names are 2–60 characters.');
    }
    if (trimmedName !== undefined && trimmedName !== current.name) changes.push(`Name: ${current.name} → ${trimmedName}`);
    const trimmedDescription = description?.trim();
    if (trimmedDescription !== undefined && trimmedDescription !== (current.description || '')) changes.push('Description updated');

    if (changes.length === 0) {
      res.json({ plan: current, changed: false });
      return;
    }

    const { before, after } = await updatePlan(
      key,
      { name: trimmedName, description: trimmedDescription, limits: changedLimits },
      String(req.user._id)
    );

    await audit(req, {
      action: 'plan.update',
      targetType: 'plan',
      targetId: key,
      summary: `${after.name} plan: ${changes.join('; ')}`,
      before: { name: before.name, description: before.description, limits: before.limits },
      after: { name: after.name, description: after.description, limits: after.limits },
    });

    res.json({ plan: after, changed: true });
  } catch (error) {
    next(error);
  }
};

// GET /admin/audit?targetType=&targetId=&limit=
export const listAudit = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100);
    const filter: Record<string, unknown> = {};
    if (req.query.targetType === 'plan' || req.query.targetType === 'user') filter.targetType = req.query.targetType;
    if (typeof req.query.targetId === 'string' && req.query.targetId) filter.targetId = req.query.targetId;

    const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({
      data: entries.map((e) => ({
        at: e.createdAt,
        by: e.actorEmail,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        summary: e.summary,
      })),
    });
  } catch (error) {
    next(error);
  }
};
