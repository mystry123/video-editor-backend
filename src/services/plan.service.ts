// services/plan.service.ts
//
// Plans are read on almost every request, so they're served from memory.
// The cache loads at startup, refreshes every 60s (so other processes, like
// the worker app, pick up admin edits within a minute) and refreshes
// immediately after a write in this process.

import { Plan } from '../models/Plan';
import { USER_QUOTAS, setPlanResolver, type UserQuota } from '../config/quotas';
import { logger } from '../utils/logger';

const REFRESH_INTERVAL_MS = 60_000;

const DEFAULT_PLAN_NAMES: Record<string, { name: string; description: string }> = {
  free: { name: 'Free', description: 'For trying Shotline out.' },
  pro: { name: 'Pro', description: 'For creators publishing regularly.' },
  team: { name: 'Team', description: 'For teams producing at volume.' },
  admin: { name: 'Admin', description: 'Internal accounts with no limits.' },
};

export interface PlanView {
  key: string;
  name: string;
  description?: string;
  limits: UserQuota;
  updatedAt?: Date;
}

let cache = new Map<string, PlanView>();
let refreshTimer: NodeJS.Timeout | null = null;

/** Stored limits on top of the code defaults, so newly added fields always have a value. */
function withDefaults(key: string, limits: Partial<UserQuota> | undefined): UserQuota {
  return { ...(USER_QUOTAS[key] || USER_QUOTAS.free), ...(limits || {}) };
}

async function refreshCache(): Promise<void> {
  const plans = await Plan.find().lean();
  const next = new Map<string, PlanView>();
  for (const plan of plans) {
    next.set(plan.key, {
      key: plan.key,
      name: plan.name,
      description: plan.description,
      limits: withDefaults(plan.key, plan.limits),
      updatedAt: plan.updatedAt,
    });
  }
  cache = next;
}

/** Creates any missing plan documents from the code defaults. Never overwrites edits. */
async function seedPlans(): Promise<void> {
  await Promise.all(
    Object.entries(USER_QUOTAS).map(([key, limits]) =>
      Plan.updateOne(
        { key },
        { $setOnInsert: { key, ...DEFAULT_PLAN_NAMES[key], limits } },
        { upsert: true }
      )
    )
  );
}

export async function initPlans(): Promise<void> {
  await seedPlans();
  await refreshCache();
  setPlanResolver((key) => cache.get(key)?.limits);

  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refreshCache().catch((error) => logger.warn('Plan cache refresh failed; keeping previous plans', { error: error.message }));
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
  }

  logger.info(`Plans loaded: ${Array.from(cache.keys()).join(', ')}`);
}

export function listPlans(): PlanView[] {
  const order = Object.keys(USER_QUOTAS);
  const plans = order.map(
    (key) =>
      cache.get(key) || {
        key,
        ...DEFAULT_PLAN_NAMES[key],
        limits: withDefaults(key, undefined),
      }
  );
  return plans;
}

export function getPlan(key: string): PlanView | undefined {
  return listPlans().find((plan) => plan.key === key);
}

export async function updatePlan(
  key: string,
  changes: { name?: string; description?: string; limits?: Partial<UserQuota> },
  actorId: string
): Promise<{ before: PlanView; after: PlanView }> {
  const before = getPlan(key);
  if (!before) throw new Error(`Unknown plan ${key}`);

  const $set: Record<string, unknown> = { updatedBy: actorId };
  if (changes.name !== undefined) $set.name = changes.name;
  if (changes.description !== undefined) $set.description = changes.description;
  for (const [field, value] of Object.entries(changes.limits || {})) {
    $set[`limits.${field}`] = value;
  }

  await Plan.updateOne({ key }, { $set }, { upsert: true });
  await refreshCache();

  return { before, after: getPlan(key)! };
}
