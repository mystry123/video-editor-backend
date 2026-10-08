import { describe, expect, it } from 'vitest';
import { getEffectiveQuota, USER_QUOTAS } from '../../src/config/quotas';
import { parseQuotaValue } from '../../src/config/quotaFields';
import { getStartOfMonth } from '../../src/middleware/quota.middleware';

describe('getEffectiveQuota', () => {
  it('applies active overrides and ignores expired ones', () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const quota = getEffectiveQuota({
      role: 'free',
      planOverrides: [
        { field: 'maxRenderMinutes', value: 30, expiresAt: future },
        { field: 'maxResolution', value: '1080p', expiresAt: null },
        { field: 'maxStorage', value: 1, expiresAt: past },
      ],
    });
    expect(quota.maxRenderMinutes).toBe(30);
    expect(quota.maxResolution).toBe('1080p');
    expect(quota.maxStorage).toBe(USER_QUOTAS.free.maxStorage);
  });

  it('ignores overrides for unknown fields and falls back to free for unknown plans', () => {
    const quota = getEffectiveQuota({ role: 'nope', planOverrides: [{ field: 'notALimit', value: 1 }] });
    expect(quota).toEqual(expect.objectContaining({ maxRenderMinutes: USER_QUOTAS.free.maxRenderMinutes }));
    expect((quota as any).notALimit).toBeUndefined();
  });
});

describe('parseQuotaValue', () => {
  it('accepts valid values per type', () => {
    expect(parseQuotaValue('maxRenderMinutes', 12.5)).toEqual({ ok: true, value: 12.5 });
    expect(parseQuotaValue('maxRenderMinutes', -1)).toEqual({ ok: true, value: -1 });
    expect(parseQuotaValue('maxResolution', '4k')).toEqual({ ok: true, value: '4k' });
    expect(parseQuotaValue('watermarkFree', true)).toEqual({ ok: true, value: true });
    expect(parseQuotaValue('allowedCaptionResolutions', ['720p', '720p', '1080p'])).toEqual({ ok: true, value: ['720p', '1080p'] });
  });

  it('rejects invalid values with a readable message', () => {
    const negative = parseQuotaValue('maxTemplates', -5);
    expect(negative.ok).toBe(false);
    expect(parseQuotaValue('maxResolution', '8k').ok).toBe(false);
    expect(parseQuotaValue('allowedCaptionResolutions', []).ok).toBe(false);
    const unknown = parseQuotaValue('bogus', 1);
    expect(unknown).toEqual({ ok: false, error: 'Unknown limit "bogus"' });
  });
});

describe('getStartOfMonth', () => {
  it('is midnight UTC on the 1st', () => {
    const start = getStartOfMonth();
    expect(start.getUTCDate()).toBe(1);
    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCMinutes()).toBe(0);
  });
});
