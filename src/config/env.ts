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
  
  // Google Cloud Storage. Credentials come from Application Default
  // Credentials (the VM's service account; locally `gcloud auth
  // application-default login --impersonate-service-account=...`), never keys.
  gcpProjectId: process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT || 'shotline-511017',
  /** Uploads, imports, generated media. Publicly readable. */
  gcsMediaBucket: process.env.GCS_MEDIA_BUCKET || '',
  /** Render outputs. Private: served through signed URLs only. */
  gcsRendersBucket: process.env.GCS_RENDERS_BUCKET || '',
  /** Public base URL of the media bucket (a CDN in front of it, or the bucket itself) */
  cdnUrl: (process.env.CDN_URL || (process.env.GCS_MEDIA_BUCKET ? `https://storage.googleapis.com/${process.env.GCS_MEDIA_BUCKET}` : '')).replace(/\/+$/, ''),

  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
  
  // YOLO Reframe Service
  yoloServiceUrl: process.env.YOLO_SERVICE_URL || 'http://localhost:8000',
  // Sent as X-Internal-Token; must match the YOLO service's YOLO_SHARED_SECRET.
  yoloSharedSecret: process.env.YOLO_SHARED_SECRET || '',
  // Reframe engine v2 service (shotline-reframe). When set, AI reframe uses it
  // instead of the YOLO service.
  reframeServiceUrl: process.env.REFRAME_SERVICE_URL || '',
  reframeServiceToken: process.env.REFRAME_SERVICE_TOKEN || '',
  // Shared with the Remix server (same name there). When it sends this secret,
  // its X-Shotline-Client-IP header is trusted as the browser's IP for rate
  // limiting; without it, every SSR call looks like it comes from the Remix box.
  internalProxySecret: process.env.INTERNAL_PROXY_SECRET || '',
  // Public base URL of this API; render links are <publicApiUrl>/r/<id>?t=...
  publicApiUrl: process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`,

  
  
  // Remotion: renders run on the worker (@remotion/renderer + headless Chrome).
  // The composition bundle: a local directory (the frontend deploy writes
  // /var/www/shotline/remotion-bundles/<sha> and points `current` at it) or an
  // http(s) URL of a bundle. Resolved once per render, so a deploy never
  // changes a render that is already running.
  remotionServeUrl: process.env.REMOTION_SERVE_URL || '',
  // Renders one worker runs at once. Each uses every core it is given.
  renderConcurrency: Math.max(1, Number(process.env.RENDER_CONCURRENCY) || 1),
  // Browser tabs one render uses (Remotion's `concurrency`); empty = Remotion's
  // default (half the cores).
  remotionConcurrency: process.env.REMOTION_CONCURRENCY ? Number(process.env.REMOTION_CONCURRENCY) : null,
  // A render that hasn't finished this long after starting is stopped and failed.
  renderDeadlineMs: Math.max(5, Number(process.env.RENDER_DEADLINE_MINUTES) || 45) * 60_000,

  // ElevenLabs
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',

  // Text to speech: which provider ("elevenlabs" or "sarvam"), see services/tts
  ttsProvider: (process.env.TTS_PROVIDER === 'sarvam' ? 'sarvam' : 'elevenlabs') as 'elevenlabs' | 'sarvam',
  // Sarvam API subscription key (dashboard.sarvam.ai)
  sarvamApiKey: process.env.SARVAM_API_KEY || '',

  // AI assistant: Gemini on Vertex AI (credentials from the environment: gcloud ADC locally,
  // workload identity on servers)
  vertexProject: process.env.VERTEX_PROJECT || 'shotline-511017',
  vertexLocation: process.env.VERTEX_LOCATION || 'global',
  aiModel: process.env.AI_MODEL || 'gemini-3.6-flash',
  /** For requests the fast model gets wrong */
  aiModelStrong: process.env.AI_MODEL_STRONG || 'gemini-2.5-pro',
  /** Used when a model is over its rate limit (429), after one short retry */
  aiModelFallback: process.env.AI_MODEL_FALLBACK || 'gemini-2.5-flash',
  /** Image generation (Gemini image model on Vertex) */
  imageModel: process.env.IMAGE_MODEL || 'gemini-3.1-flash-image',
  /** Cue Director: the director and reviewer (creative judgement) */
  directorModel: process.env.DIRECTOR_MODEL || 'gemini-3.1-pro-preview',
  /** Cue Director: the specialists (fast) */
  directorWorkerModel: process.env.DIRECTOR_WORKER_MODEL || 'gemini-3.6-flash',
  /** Cue Director: watches footage (video input) */
  footageModel: process.env.DIRECTOR_FOOTAGE_MODEL || 'gemini-3.5-flash',
  /** Cue Director learns from past edits (nightly lessons + eval gate); off with DIRECTOR_LEARNING=false */
  directorLearning: process.env.DIRECTOR_LEARNING !== 'false',
  /** The eval gate's footage owner and cases: [{"fileId":"…","request":"…"}] */
  directorEvalUser: process.env.DIRECTOR_EVAL_USER || '',
  directorEvalCases: process.env.DIRECTOR_EVAL_CASES || '',
  /** Stock photos and videos (Pixabay); empty turns stock search off */
  pixabayApiKey: process.env.PIXABAY_API_KEY || '',
  
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
  if (!env.gcsMediaBucket) warnings.push('GCS_MEDIA_BUCKET not set: uploads will fail');
  if (!env.gcsRendersBucket) warnings.push('GCS_RENDERS_BUCKET not set: render links will not work');
  if (!env.remotionServeUrl) warnings.push('REMOTION_SERVE_URL not set (the composition bundle): renders will fail');
  if (env.internalProxySecret && env.internalProxySecret.length < 32) warnings.push('INTERNAL_PROXY_SECRET is shorter than 32 characters; it is ignored');

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
