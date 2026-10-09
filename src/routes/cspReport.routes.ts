// routes/cspReport.routes.ts
//
// POST /csp-report — browsers send Content-Security-Policy violations here,
// from the web app's (report-only) policy and the API's own. Each report is
// logged as one compact line; nothing is stored. Always 204, even for junk,
// so the endpoint can't be used to probe anything.
//
// Two formats exist:
//  - report-uri:  application/csp-report  {"csp-report": {...}}
//  - Reporting API: application/reports+json  [{type: "csp-violation", body: {...}}]

import express, { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { cspReportLimiter } from '../middleware/rateLimit.middleware';
import { logger } from '../utils/logger';

const router: ExpressRouter = Router();

const MAX_FIELD = 300;

/** Origin + path only: report URLs can carry tokens in their query string (e.g. /r/:id?t=...). */
function stripUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, MAX_FIELD);
  } catch {
    // Keywords like "inline", "eval", "data", or a bare scheme.
    return value.split(/[?#]/)[0].slice(0, MAX_FIELD);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_FIELD) : undefined;
}

type Report = Record<string, unknown>;

/** Normalizes one violation from either format (kebab-case or camelCase keys). */
function summarize(body: Report | undefined) {
  if (!body || typeof body !== 'object') return null;
  return {
    directive: text(body['effective-directive'] ?? body.effectiveDirective ?? body['violated-directive']),
    blocked: stripUrl(body['blocked-uri'] ?? body.blockedURL),
    document: stripUrl(body['document-uri'] ?? body.documentURL),
    source: stripUrl(body['source-file'] ?? body.sourceFile),
    line: Number(body['line-number'] ?? body.lineNumber) || undefined,
    disposition: text(body.disposition),
    sample: text(body['script-sample'] ?? body.sample)?.slice(0, 80),
  };
}

const parseReports = express.json({
  type: ['application/csp-report', 'application/reports+json', 'application/json'],
  limit: '16kb',
});

router.post('/', cspReportLimiter, parseReports, (req: Request, res: Response) => {
  const payload = req.body;
  const bodies: Array<Report | undefined> = Array.isArray(payload)
    ? payload.filter((r: Report) => r?.type === 'csp-violation').map((r: Report) => r.body as Report)
    : [payload?.['csp-report']];

  // Browsers batch Reporting API reports; a handful per request is plenty.
  for (const body of bodies.slice(0, 10)) {
    const violation = summarize(body);
    if (violation) logger.warn('CSP violation', { csp: violation, ua: text(req.header('user-agent'))?.slice(0, 120) });
  }
  res.status(204).end();
});

// Oversized or malformed bodies: still a quiet 204 (the parser's error would
// otherwise reach the global handler and log a stack trace per report).
router.use((_err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  res.status(204).end();
});

export default router;
