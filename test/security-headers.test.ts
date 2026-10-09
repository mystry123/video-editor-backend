import { describe, expect, it, vi } from 'vitest';
import { api } from './helpers';
import { logger } from '../src/utils/logger';

describe('Content-Security-Policy', () => {
  it('forbids everything on JSON API responses', async () => {
    const res = await api().get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('report-uri /csp-report');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('applies to errors and redirects too', async () => {
    expect((await api().get('/api/v1/nope')).headers['content-security-policy']).toContain("default-src 'none'");
    expect((await api().get('/r/not-an-id?t=x')).headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('gives the Swagger UI page a report-only policy that allows its own assets', async () => {
    const res = await api().get('/api/v1/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    const csp = res.headers['content-security-policy-report-only'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // The page only references same-origin scripts.
    const scripts = [...res.text.matchAll(/<script[^>]*src=['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(src.startsWith('./')).toBe(true);
  });
});

describe('POST /csp-report', () => {
  it('logs a report-uri report compactly, without query strings, and answers 204', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const res = await api()
      .post('/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({
        'csp-report': {
          'document-uri': 'https://shotline.in/editor/abc?token=secret',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://evil.example/x.js?a=1',
          'line-number': 12,
          disposition: 'report',
        },
      }));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith('CSP violation', expect.objectContaining({
      csp: expect.objectContaining({
        directive: 'script-src-elem',
        blocked: 'https://evil.example/x.js',
        document: 'https://shotline.in/editor/abc',
        line: 12,
      }),
    }));
    warn.mockRestore();
  });

  it('accepts Reporting API batches', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const res = await api()
      .post('/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send(JSON.stringify([
        { type: 'csp-violation', body: { documentURL: 'https://shotline.in/', effectiveDirective: 'img-src', blockedURL: 'data' } },
        { type: 'deprecation', body: {} },
      ]));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('quietly drops oversized or malformed bodies', async () => {
    const big = await api().post('/csp-report').set('Content-Type', 'application/csp-report').send('x'.repeat(40_000));
    expect(big.status).toBe(204);
    const bad = await api().post('/csp-report').set('Content-Type', 'application/csp-report').send('{not json');
    expect(bad.status).toBe(204);
  });
});
