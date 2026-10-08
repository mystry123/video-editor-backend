import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('health', () => {
  it('liveness is always ok', async () => {
    expect((await api().get('/health/live')).body).toEqual({ status: 'ok' });
  });

  it('readiness reports dependencies (Redis is absent in tests)', async () => {
    const res = await api().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { mongo: 'ok', redis: 'down' } });
  });
});
