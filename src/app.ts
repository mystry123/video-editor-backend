import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';

import { requestId } from './middleware/requestId.middleware';
import { sendError } from './utils/errorResponse';
import { errorHandler } from './middleware/error.middleware';
import { rateLimiter } from './middleware/rateLimit.middleware';
import { attachUsageSummary } from './middleware/quota.middleware';
import routes from './routes';
import { env } from './config/env';
import mongoose from 'mongoose';
import { isRedisReady } from './config/redis';
import renderLinkRoutes from './routes/renderLink.routes';
import { openApiSpec } from './docs/openapi';

import geoip from 'geoip-lite';

// Replace your middleware with:
const app: Express = express();

// ============================================


// Trust exactly the proxies in front of us (nginx on EC2 = 1), so req.ip is
// the real client. `true` trusted every hop, letting a client choose its own
// IP via X-Forwarded-For and dodge rate limits.
app.set('trust proxy', Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY ?? 1));

// Request id first, so every log line and error body can carry it.
app.use(requestId);

// SECURITY MIDDLEWARE
// GeoIP location detection using geoip-lite
app.use((req, res, next) => {
  // req.ip already honours the trusted proxy setting above; reading the
  // leftmost X-Forwarded-For would let clients pick their own location.
  const ip = req.ip;

  const cleanIp = ip?.startsWith('::ffff:') ? ip.substring(7) : ip;

  if (cleanIp && cleanIp !== '127.0.0.1') {
    const geo = geoip.lookup(cleanIp);
    res.locals.geoLocation = geo ? {
      ip: cleanIp,
      country: geo.country,
      city: geo.city,
      latitude: geo.ll?.[0],
      longitude: geo.ll?.[1],
    } : null;
  } else {
    res.locals.geoLocation = null;
  }

  next();
});


// Helmet for security headers (relaxed CSP so Swagger UI assets load)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// CORS configuration
app.use(
  cors({
    origin: env.corsOrigin.split(',').map((o) => o.trim()), // Support multiple origins
    credentials: true, // Required for cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  })
);

// ============================================
// BODY PARSING & COOKIES
// ============================================
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // Parse cookies

// ============================================
// LOGGING
// ============================================

// Skip logging for health checks
morgan.token('id', (req) => (req as any).id);
app.use(
  morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":user-agent" rid=:id', {
    skip: (req) => req.url === '/health' || env.nodeEnv === 'test',
  })
);

// ============================================
// RATE LIMITING
// ============================================

app.use('/api/', rateLimiter);

// ============================================
// HEALTH CHECK
// ============================================

// Liveness: the process is up and serving requests.
app.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Readiness: dependencies. 503 when the database is unreachable; Redis being
// down is reported as degraded (reads still work, new jobs fail fast).
app.get('/health/ready', (_req: Request, res: Response) => {
  const mongo = mongoose.connection.readyState === 1;
  const redis = isRedisReady();
  res.status(mongo ? 200 : 503).json({
    status: mongo && redis ? 'ok' : mongo ? 'degraded' : 'unavailable',
    checks: { mongo: mongo ? 'ok' : 'down', redis: redis ? 'ok' : 'down' },
    uptime: Math.round(process.uptime()),
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================
// API DOCS (public)
// ============================================

// Public on purpose: these are the docs for API/Zapier customers (every
// endpoint they describe still requires auth).
app.use(
  '/api/v1/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Shotline Render API',
  })
);
app.get('/api/v1/docs.json', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

// ============================================
// API ROUTES
// ============================================

// Render links live outside /api so they stay short: <PUBLIC_API_URL>/r/<id>?t=...
app.use('/r', renderLinkRoutes);
app.use('/api/v1', routes); // Re-enabled with only project routes


// ============================================
// 404 HANDLER
// ============================================

app.use((req: Request, res: Response) => {
  sendError(req, res, 404, 'Not found', 'ROUTE_NOT_FOUND');
});

// ============================================
// ERROR HANDLING
// ============================================

app.use(errorHandler);

export default app;
