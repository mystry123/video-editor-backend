import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { errorHandler } from './middleware/error.middleware';
import { rateLimiter } from './middleware/rateLimit.middleware';
import { attachUsageSummary } from './middleware/quota.middleware';
import routes from './routes';
import { env } from './config/env';
import { seedCaptionPresets } from './seeds/caption-presets.seed';

import geoip from 'geoip-lite';

// Replace your middleware with:
const app: Express = express();

// ============================================
// SECURITY MIDDLEWARE
// GeoIP location detection using geoip-lite
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
  
  if (ip) {
    // Handle localhost/IPv6 localhost
    if (ip === '::1' || ip === '127.0.0.1') {
      res.locals.geoLocation = { country: 'Local', city: 'Localhost' };
    } else {
      const geo = geoip.lookup(ip);
      res.locals.geoLocation = geo ? {
        country: geo.country,
        city: geo.city,
        latitude: geo.ll?.[0],
        longitude: geo.ll?.[1],
      } : null;
    }
  } else {
    res.locals.geoLocation = null;
  }
  
  next();
});


// Helmet for security headers
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: env.corsOrigin.split(',').map((o) => o.trim()), // Support multiple origins
    credentials: true, // Required for cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
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
app.use(
  morgan('combined', {
    skip: (req) => req.url === '/health',
  })
);

// ============================================
// RATE LIMITING
// ============================================

app.use('/api/', rateLimiter);

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================
// API ROUTES
// ============================================

app.use('/api/v1', routes); // Re-enabled with only project routes


// ============================================
// 404 HANDLER
// ============================================

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use(errorHandler);

export default app;
