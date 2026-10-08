import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';

describe('error responses', () => {
  it('use one envelope with a request id', async () => {
    const res = await api().get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body).toEqual({
      success: false,
      error: 'Not found',
      message: 'Not found',
      code: 'ROUTE_NOT_FOUND',
      requestId: res.headers['x-request-id'],
    });
  });

  it('reuse a valid incoming X-Request-Id', async () => {
    const res = await api().get('/api/v1/nope').set('X-Request-Id', 'trace-12345678');
    expect(res.headers['x-request-id']).toBe('trace-12345678');
    expect(res.body.requestId).toBe('trace-12345678');
  });

  it('turn malformed JSON into a 400, not a 500', async () => {
    const res = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('report validation problems with the field path', async () => {
    const { auth } = await createUser();
    const res = await api().put('/api/v1/auth/me').set(auth).send({ name: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('Name must be at least 2 characters');
    expect(res.body.details).toEqual([{ path: 'name', message: 'Name must be at least 2 characters' }]);
  });

  it('use 401 only for missing or invalid sessions', async () => {
    const noAuth = await api().get('/api/v1/auth/me');
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.code).toBe('AUTH_REQUIRED');

    const badToken = await api().get('/api/v1/auth/me').set('Authorization', 'Bearer nonsense');
    expect(badToken.status).toBe(401);
    expect(badToken.body.code).toBe('SESSION_INVALID');

    await createUser({ email: 'login@test.dev', password: 'Password123' });
    const wrongPassword = await api().post('/api/v1/auth/login').send({ email: 'login@test.dev', password: 'nope' });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('return 400 INVALID_ID for malformed ids', async () => {
    const { auth } = await createUser();
    const res = await api().get('/api/v1/templates/not-an-id').set(auth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});
