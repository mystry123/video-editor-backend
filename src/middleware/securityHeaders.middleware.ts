// middleware/securityHeaders.middleware.ts
//
// Security headers for the API.
//
// The API answers with JSON and redirects (OAuth callbacks, /r/:id render
// links), never with pages, so its Content-Security-Policy can forbid
// everything: if a response were ever rendered as a document (a reflected
// error page, an HTML file served by mistake), nothing in it could run, load
// or be framed. A JSON body has no subresources, so enforcing this can't break
// API clients.
//
// The one HTML page is the Swagger UI under /api/v1/docs. It needs its own
// scripts and stylesheet plus an inline <style> block, and gets a relaxed
// policy in report-only mode, so a missed source shows up in /csp-report
// instead of breaking the docs.

import helmet from 'helmet';
import type { RequestHandler } from 'express';

export const CSP_REPORT_PATH = '/csp-report';

/** Enforced on every API response. */
export const apiSecurityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      reportUri: [CSP_REPORT_PATH],
    },
  },
  // Same-origin resource policy by default (fine for JSON); the routes that
  // other sites load opt out with allowCrossOriginLoads. COEP stays off: it
  // only matters for pages, and Swagger UI doesn't need it.
  crossOriginEmbedderPolicy: false,
});

/**
 * For responses other origins load directly rather than through CORS:
 * render links (/r/:id, played by <video> on shotline.in and anywhere a link
 * is shared; the token guards them) and /csp-report. With the default
 * same-origin policy the browser blocks them (ERR_BLOCKED_BY_RESPONSE).
 */
export const allowCrossOriginLoads: RequestHandler = (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
};

/**
 * Swagger UI (/api/v1/docs): report-only. Mount after apiSecurityHeaders so
 * it replaces the enforced policy for the docs page only.
 */
export const docsSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  res.setHeader(
    'Content-Security-Policy-Report-Only',
    [
      "default-src 'self'",
      "script-src 'self'",
      // swagger-ui-express writes an inline <style> block into its page.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      `report-uri ${CSP_REPORT_PATH}`,
    ].join('; ')
  );
  next();
};
