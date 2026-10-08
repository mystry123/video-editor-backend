// services/usage.service.ts
//
// The usage ledger: reserve when work starts, settle (charge the real amount)
// when it finishes, release (refund) when it fails or is cancelled. All three
// are idempotent per (kind, jobId), so retries, duplicate completions and
// sweeps can never double-charge. Totals are per UTC month; a new month is a
// new counter, so nothing ever needs resetting.

import { Types } from 'mongoose';
import { UsageCounter, UsageEntry, type UsageKind } from '../models/Usage';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';

/** How each kind maps to the plan limit, the legacy counter and its error. */
const KINDS: Record<UsageKind, { limitField: string; legacyField: string; perUnit: number; code: string; label: string }> = {
  renderMinutes: { limitField: 'maxRenderMinutes', legacyField: 'renderMinutesUsed', perUnit: 60, code: 'RENDER_MINUTES_EXCEEDED', label: 'render minutes' },
  captionRenderMinutes: { limitField: 'maxCaptionRenderMinutes', legacyField: 'captionRenderMinutesUsed', perUnit: 60, code: 'CAPTION_RENDER_MINUTES_EXCEEDED', label: 'caption render minutes' },
  transcriptionMinutes: { limitField: 'maxTranscriptionMinutes', legacyField: 'transcriptionMinutesUsed', perUnit: 60, code: 'TRANSCRIPTION_MINUTES_EXCEEDED', label: 'transcription minutes' },
  captionExports: { limitField: 'maxCaptionExports', legacyField: 'captionExportsUsed', perUnit: 1, code: 'CAPTION_EXPORT_LIMIT_REACHED', label: 'caption exports' },
};

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodStart(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

/**
 * Where this month's counter starts: the old per-user counter if it was last
 * reset this month (right after the ledger was introduced, so usage already
 * spent this month isn't forgiven), otherwise 0.
 */
async function legacySeed(userId: string, kind: UsageKind, period: string): Promise<number> {
  const user = await User.findById(userId).select('quotaUsage').lean();
  const lastReset = (user as any)?.quotaUsage?.lastReset;
  if (!lastReset || new Date(lastReset) < periodStart(period)) return 0;
  return Math.round(((user as any).quotaUsage?.[KINDS[kind].legacyField] || 0) * KINDS[kind].perUnit);
}

/** Makes sure this month's counter exists before it's changed. */
async function ensureCounter(userId: string, kind: UsageKind, period: string): Promise<void> {
  if (await UsageCounter.exists({ userId, kind, period })) return;
  const seed = await legacySeed(userId, kind, period);
  try {
    await UsageCounter.updateOne({ userId, kind, period }, { $setOnInsert: { total: seed } }, { upsert: true });
  } catch (error: any) {
    if (error?.code !== 11000) throw error; // another request created it first
  }
}

/** This month's usage for a kind, in seconds (minutes kinds) or a count. Read-only. */
export async function getMonthlyTotal(userId: string, kind: UsageKind): Promise<number> {
  const period = currentPeriod();
  const counter = await UsageCounter.findOne({ userId, kind, period }).lean();
  return counter ? counter.total : legacySeed(userId, kind, period);
}

function format(kind: UsageKind, units: number): string {
  if (KINDS[kind].perUnit === 60) {
    const minutes = units / 60;
    return minutes < 1 ? `${Math.round(units)} sec` : `${Math.round(minutes * 10) / 10} min`;
  }
  return String(units);
}

/**
 * Reserves `amount` for a job, or throws 403 with the kind's quota code if
 * that would exceed `limit` (in plan units: minutes or a count; -1 =
 * unlimited). Calling it again for the same job is a no-op.
 */
export async function reserveUsage(
  userId: string | Types.ObjectId,
  kind: UsageKind,
  jobId: string,
  amount: number,
  limit: number
): Promise<void> {
  const uid = String(userId);
  const units = Math.max(0, Math.round(amount));
  const existing = await UsageEntry.findOne({ kind, jobId }).lean();
  if (existing && existing.state !== 'released') return;

  const period = currentPeriod();
  await ensureCounter(uid, kind, period);

  const limitUnits = limit === -1 ? Infinity : Math.round(limit * KINDS[kind].perUnit);
  const counter = await UsageCounter.findOneAndUpdate(
    { userId: uid, kind, period, ...(limitUnits === Infinity ? {} : { total: { $lte: limitUnits - units } }) },
    { $inc: { total: units } },
    { new: true }
  );
  if (!counter) {
    const used = await getMonthlyTotal(uid, kind);
    const remaining = Math.max(0, limitUnits - used);
    throw ApiError.withCode(
      403,
      KINDS[kind].code,
      units > 0 && remaining > 0
        ? `This needs ${format(kind, units)} of ${KINDS[kind].label}, but you have ${format(kind, remaining)} left this month.`
        : `You've used all your ${KINDS[kind].label} for this month.`,
      { used: used / KINDS[kind].perUnit, limit, needed: units / KINDS[kind].perUnit }
    );
  }

  try {
    if (existing) {
      // A released reservation for the same job (e.g. a user retry) is reused.
      await UsageEntry.updateOne(
        { _id: existing._id, state: 'released' },
        { $set: { state: 'reserved', amount: units, period, reason: undefined }, $unset: { releasedAt: '' } }
      );
    } else {
      await UsageEntry.create({ userId: uid, kind, jobId, period, amount: units, state: 'reserved' });
    }
  } catch (error: any) {
    // Lost a race with a parallel reserve for the same job: undo our increment.
    await UsageCounter.updateOne({ userId: uid, kind, period }, { $inc: { total: -units } });
    if (error?.code !== 11000) throw error;
  }
}

/**
 * Charges a job's real usage. With a reservation, adjusts it to `actual`;
 * without one (jobs started before the ledger), charges `actual` directly.
 */
export async function settleUsage(
  userId: string | Types.ObjectId,
  kind: UsageKind,
  jobId: string,
  actual?: number
): Promise<void> {
  const uid = String(userId);
  const reserved = await UsageEntry.findOneAndUpdate(
    { kind, jobId, state: 'reserved' },
    { $set: { state: 'settled', settledAt: new Date(), ...(actual !== undefined ? { amount: Math.max(0, Math.round(actual)) } : {}) } },
    { new: false }
  );
  if (reserved) {
    const delta = actual !== undefined ? Math.max(0, Math.round(actual)) - reserved.amount : 0;
    if (delta !== 0) await UsageCounter.updateOne({ userId: reserved.userId, kind, period: reserved.period }, { $inc: { total: delta } });
    return;
  }

  // No reservation: charge directly, once.
  if (await UsageEntry.exists({ kind, jobId })) return;
  const units = Math.max(0, Math.round(actual || 0));
  const period = currentPeriod();
  try {
    await UsageEntry.create({ userId: uid, kind, jobId, period, amount: units, state: 'settled', settledAt: new Date() });
  } catch (error: any) {
    if (error?.code === 11000) return;
    throw error;
  }
  await ensureCounter(uid, kind, period);
  await UsageCounter.updateOne({ userId: uid, kind, period }, { $inc: { total: units } });
}

/** Refunds a job's reservation (failed, cancelled, never started). No-op if already settled or released. */
export async function releaseUsage(kind: UsageKind, jobId: string, reason: string): Promise<void> {
  const entry = await UsageEntry.findOneAndUpdate(
    { kind, jobId, state: 'reserved' },
    { $set: { state: 'released', releasedAt: new Date(), reason } },
    { new: false }
  );
  if (entry) {
    await UsageCounter.updateOne({ userId: entry.userId, kind, period: entry.period }, { $inc: { total: -entry.amount } });
  }
}

/** Releases every reservation a job may hold. */
export async function releaseAllUsage(jobId: string, reason: string): Promise<void> {
  for (const kind of Object.keys(KINDS) as UsageKind[]) {
    await releaseUsage(kind, jobId, reason);
  }
}
