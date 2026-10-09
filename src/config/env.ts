import * as dotenv from 'dotenv';
// Tests set their own environment (vitest.config.ts) and must never pick up
// real credentials from a developer's .env.
if (process.env.NODE_ENV !== 'test') dotenv.config();

// Development-only fallbacks. Production refuses to start with these (see below).
const DEV_JWT_SECRET = 'your-super-secret-jwt-key-change-in-production';
const DEV_JWT_REFRESH_SECRET = 'your-super-secret-refresh-key-change-in-production';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5720',

  
  // MongoDB
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/video-editor',
  
  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '14949', 10),
  redisPassword: process.env.REDIS_PASSWORD || '',
  
  // JWT
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || DEV_JWT_REFRESH_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '5m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '1d',
  
  // OAuth - Google
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/google/callback',
  
  // OAuth - Apple
  appleClientId: process.env.APPLE_CLIENT_ID || '', // Service ID
  appleTeamId: process.env.APPLE_TEAM_ID || '',
  appleKeyId: process.env.APPLE_KEY_ID || '',
  applePrivateKey: process.env.APPLE_PRIVATE_KEY || '', // Contents of .p8 file
  appleCallbackUrl: process.env.APPLE_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/apple/callback',
  
  // OAuth - Facebook
  facebookAppId: process.env.FACEBOOK_APP_ID || '',
  facebookAppSecret: process.env.FACEBOOK_APP_SECRET || '',
  facebookCallbackUrl: process.env.FACEBOOK_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/facebook/callback',
  
  // AWS
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  remotionAwsAccessKeyID: process.env.REMOTION_AWS_ACCESS_KEY_ID || '',
  remotionAwsSecretAccessKey:process.env.REMOTION_AWS_SECRET_ACCESS_KEY || '',
  s3Bucket: process.env.S3_BUCKET || '',
  cdnUrl: process.env.CDN_URL || '',
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
  
  // YOLO Reframe Service
  yoloServiceUrl: process.env.YOLO_SERVICE_URL || 'http://localhost:8000',
  // Sent as X-Internal-Token; must match the YOLO service's YOLO_SHARED_SECRET.
  yoloSharedSecret: process.env.YOLO_SHARED_SECRET || '',
  // Reframe engine v2 service (shotline-reframe). When set, AI reframe uses it
  // instead of the YOLO service.
  reframeServiceUrl: process.env.REFRAME_SERVICE_URL || '',
  reframeServiceToken: process.env.REFRAME_SERVICE_TOKEN || '',
  remotionWebhookSecret: process.env.REMOTION_WEBHOOK_SECRET || '',
  // Shared with the Remix server (same name there). When it sends this secret,
  // its X-Shotline-Client-IP header is trusted as the browser's IP for rate
  // limiting; without it, every SSR call looks like it comes from the Remix box.
  internalProxySecret: process.env.INTERNAL_PROXY_SECRET || '',
  // Public URL of POST /api/v1/webhooks/remotion. With the secret set, renders
  // complete via Remotion's webhook instead of a worker polling Lambda.
  remotionWebhookUrl: process.env.REMOTION_WEBHOOK_URL || '',
  // Public base URL of this API; render links are <publicApiUrl>/r/<id>?t=...
  publicApiUrl: process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`,

  
  
  // Remotion
  remotionServeUrl: process.env.REMOTION_SERVE_URL || '',
  remotionFunctionName: process.env.REMOTION_FUNCTION_NAME || '',
  // Most render Lambdas one render may use at once. Keep it under the AWS
  // account's Lambda concurrency limit (minus one for the orchestrator), or
  // long renders fail with "AWS Concurrency limit reached".
  remotionMaxLambdas: Math.max(1, Number(process.env.REMOTION_MAX_LAMBDAS) || 8),
  remotionBucket: process.env.REMOTION_BUCKET || '',
  
  // ElevenLabs
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  
  // Email (optional - for password reset)
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  emailFrom: process.env.EMAIL_FROM || 'noreply@yourdomain.com',
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ============================================================================
// Startup checks
//
// Production stops here (before any connection is made) when a setting is
// missing that would make the server unsafe — e.g. JWTs signed with a secret
// that's published in this repo. Settings that only break one feature log a
// warning instead, so a deploy isn't blocked by an unused integration.
// ============================================================================

function checkEnvironment(): void {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const isProduction = env.nodeEnv === 'production';

  if (!process.env.JWT_SECRET || env.jwtSecret === DEV_JWT_SECRET) fatal.push('JWT_SECRET is not set');
  if (!process.env.JWT_REFRESH_SECRET || env.jwtRefreshSecret === DEV_JWT_REFRESH_SECRET) fatal.push('JWT_REFRESH_SECRET is not set');
  if (env.jwtSecret === env.jwtRefreshSecret) fatal.push('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  if (!process.env.MONGODB_URI) fatal.push('MONGODB_URI is not set');
  // Render links would point at localhost and be useless to users.
  if (!process.env.PUBLIC_API_URL) fatal.push('PUBLIC_API_URL is not set (render links are built from it)');

  if (env.jwtSecret.length < 32 || env.jwtRefreshSecret.length < 32) warnings.push('JWT secrets should be at least 32 characters');
  if (env.corsOrigin === '*') warnings.push('CORS_ORIGIN is "*"; set it to the frontend origin(s)');
  if (!env.s3Bucket || !env.cdnUrl) warnings.push('S3_BUCKET / CDN_URL not set: uploads will fail');
  if (!env.remotionServeUrl || !env.remotionFunctionName) warnings.push('REMOTION_SERVE_URL / REMOTION_FUNCTION_NAME not set: renders will fail');
  if (env.internalProxySecret && env.internalProxySecret.length < 32) warnings.push('INTERNAL_PROXY_SECRET is shorter than 32 characters; it is ignored');
  if (Boolean(env.remotionWebhookUrl) !== Boolean(env.remotionWebhookSecret)) {
    warnings.push('Set both REMOTION_WEBHOOK_URL and REMOTION_WEBHOOK_SECRET to complete renders by webhook; until then workers poll Lambda');
  }

  // The logger imports this module, so report with console here.
  for (const warning of warnings) console.warn(`[env] ${warning}`);
  if (fatal.length === 0) return;

  if (isProduction) {
    console.error(`[env] Refusing to start in production:\n  - ${fatal.join('\n  - ')}`);
    process.exit(1);
  }
  for (const problem of fatal) console.warn(`[env] ${problem} (allowed outside production)`);
}

if (process.env.NODE_ENV !== 'test') checkEnvironment();
