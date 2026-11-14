import * as dotenv from 'dotenv';
// Tests set their own environment (vitest.config.ts) and must never pick up
// real credentials from a developer's .env.
if (process.env.NODE_ENV !== 'test') dotenv.config();

// Development-only fallbacks. Production refuses to start with these (see below).
const DEV_JWT_SECRET = 'your-super-secret-jwt-key-change-in-production';
const DEV_JWT_REFRESH_SECRET = 'your-super-secret-refresh-key-change-in-production';

export const STORAGE_PROVIDERS = ['gcs', 's3'] as const;
export const RENDER_PROVIDERS = ['local', 'lambda'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];
export type RenderProvider = (typeof RENDER_PROVIDERS)[number];

/** The media bucket's public URL when CDN_URL isn't set */
function defaultCdnUrl(source: NodeJS.ProcessEnv = process.env): string {
  if (source.CDN_URL) return source.CDN_URL.replace(/\/+$/, '');
  const provider = (source.STORAGE_PROVIDER || 'gcs').trim().toLowerCase();
  if (provider === 's3') {
    return source.S3_BUCKET && source.AWS_REGION ? `https://${source.S3_BUCKET}.s3.${source.AWS_REGION}.amazonaws.com` : '';
  }
  return source.GCS_MEDIA_BUCKET ? `https://storage.googleapis.com/${source.GCS_MEDIA_BUCKET}` : '';
}

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
  
  // Which cloud holds media and render outputs, and where renders run.
  // Defaults: Google Cloud Storage and the in-process renderer on the worker.
  // See checkProviders() below for what each choice needs.
  storageProvider: (process.env.STORAGE_PROVIDER || 'gcs').trim().toLowerCase() as StorageProvider,
  renderProvider: (process.env.RENDER_PROVIDER || 'local').trim().toLowerCase() as RenderProvider,

  // Google Cloud Storage (STORAGE_PROVIDER=gcs). Credentials come from
  // Application Default Credentials (the VM's service account; locally `gcloud
  // auth application-default login --impersonate-service-account=...`), never keys.
  gcpProjectId: process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT || 'shotline-511017',
  /** Uploads, imports, generated media. Publicly readable. */
  gcsMediaBucket: process.env.GCS_MEDIA_BUCKET || '',
  /** Render outputs. Private: served through signed URLs only. */
  gcsRendersBucket: process.env.GCS_RENDERS_BUCKET || '',

  // AWS (STORAGE_PROVIDER=s3 and/or RENDER_PROVIDER=lambda). Keys are
  // optional: without them the AWS SDK's default credential chain is used
  // (an instance role, AWS_PROFILE, ...).
  awsRegion: process.env.AWS_REGION || '',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  /** S3: uploads, imports, generated media. Publicly readable (or behind CDN_URL). */
  s3Bucket: process.env.S3_BUCKET || '',
  /** S3: render outputs made on the worker (RENDER_PROVIDER=local). Private. */
  s3RendersBucket: process.env.S3_RENDERS_BUCKET || '',

  /** Public base URL of the media bucket (a CDN in front of it, or the bucket itself) */
  cdnUrl: defaultCdnUrl(),

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

  
  
  // Remotion. The composition bundle ("VideoEditor", from the frontend's
  // app/remotion entry):
  // - RENDER_PROVIDER=local: a local directory (the frontend deploy writes
  //   /var/www/shotline/remotion-bundles/<sha> and points `current` at it) or
  //   an http(s) URL of a bundle. Resolved once per render, so a deploy never
  //   changes a render that is already running.
  // - RENDER_PROVIDER=lambda: the URL of a Remotion site deployed to S3.
  remotionServeUrl: process.env.REMOTION_SERVE_URL || '',
  // Renders one worker runs at once (local). Each uses every core it is given.
  renderConcurrency: Math.max(1, Number(process.env.RENDER_CONCURRENCY) || 1),
  // Browser tabs one render uses (Remotion's `concurrency`); empty = Remotion's
  // default (half the cores).
  remotionConcurrency: process.env.REMOTION_CONCURRENCY ? Number(process.env.REMOTION_CONCURRENCY) : null,
  // A render that hasn't finished this long after starting is stopped and failed.
  renderDeadlineMs: Math.max(5, Number(process.env.RENDER_DEADLINE_MINUTES) || 45) * 60_000,

  // Remotion Lambda (RENDER_PROVIDER=lambda). Remotion reads
  // REMOTION_AWS_ACCESS_KEY_ID/SECRET (or AWS_ACCESS_KEY_ID/SECRET) itself.
  remotionAwsAccessKeyID: process.env.REMOTION_AWS_ACCESS_KEY_ID || '',
  remotionAwsSecretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY || '',
  /** An AWS profile Remotion may use instead of keys (REMOTION_AWS_PROFILE or AWS_PROFILE) */
  remotionAwsProfile: process.env.REMOTION_AWS_PROFILE || process.env.AWS_PROFILE || '',
  remotionFunctionName: process.env.REMOTION_FUNCTION_NAME || '',
  /** The bucket Remotion renders into (outputs are private objects there) */
  remotionBucket: process.env.REMOTION_BUCKET || '',
  // Most render Lambdas one render may use at once. Keep it under the AWS
  // account's Lambda concurrency limit (minus one for the orchestrator), or
  // long renders fail with "AWS Concurrency limit reached".
  remotionMaxLambdas: Math.max(1, Number(process.env.REMOTION_MAX_LAMBDAS) || 8),
  // Public URL of POST /api/v1/webhooks/remotion. With the secret set, Lambda
  // renders complete via Remotion's signed webhook instead of a worker polling.
  remotionWebhookUrl: process.env.REMOTION_WEBHOOK_URL || '',
  remotionWebhookSecret: process.env.REMOTION_WEBHOOK_SECRET || '',

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
  if (env.internalProxySecret && env.internalProxySecret.length < 32) warnings.push('INTERNAL_PROXY_SECRET is shorter than 32 characters; it is ignored');

  const providers = checkProviders(env);
  warnings.push(...providers.warnings);

  // The logger imports this module, so report with console here.
  for (const warning of warnings) console.warn(`[env] ${warning}`);

  // A provider that was chosen but can't work stops every environment: there
  // is no useful way to run with half an AWS setup.
  if (providers.fatal.length > 0) {
    console.error(`[env] Refusing to start: storage/render provider settings are incomplete:\n  - ${providers.fatal.join('\n  - ')}`);
    process.exit(1);
  }
  if (fatal.length === 0) return;

  if (isProduction) {
    console.error(`[env] Refusing to start in production:\n  - ${fatal.join('\n  - ')}`);
    process.exit(1);
  }
  for (const problem of fatal) console.warn(`[env] ${problem} (allowed outside production)`);
}

/**
 * What the chosen storage and render providers are missing. AWS choices
 * (s3, lambda) fail fast: they are opt-in, so nothing that runs today
 * depends on them starting with gaps. The defaults (gcs, local) keep warning
 * only, as they always have, so an existing deploy is never blocked by this.
 */
export function checkProviders(e: Pick<
  typeof env,
  | 'storageProvider'
  | 'renderProvider'
  | 'gcsMediaBucket'
  | 'gcsRendersBucket'
  | 'awsRegion'
  | 'awsAccessKeyId'
  | 'awsSecretAccessKey'
  | 's3Bucket'
  | 's3RendersBucket'
  | 'remotionServeUrl'
  | 'remotionFunctionName'
  | 'remotionBucket'
  | 'remotionAwsAccessKeyID'
  | 'remotionAwsSecretAccessKey'
  | 'remotionAwsProfile'
  | 'remotionWebhookUrl'
  | 'remotionWebhookSecret'
>): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const storageOk = (STORAGE_PROVIDERS as readonly string[]).includes(e.storageProvider);
  const renderOk = (RENDER_PROVIDERS as readonly string[]).includes(e.renderProvider);
  if (!storageOk) fatal.push(`STORAGE_PROVIDER must be one of ${STORAGE_PROVIDERS.join(', ')} (got "${e.storageProvider}")`);
  if (!renderOk) fatal.push(`RENDER_PROVIDER must be one of ${RENDER_PROVIDERS.join(', ')} (got "${e.renderProvider}")`);
  const local = e.renderProvider === 'local';
  const usesAws = e.storageProvider === 's3' || e.renderProvider === 'lambda';

  if (usesAws && !e.awsRegion) fatal.push('AWS_REGION is not set');
  if (e.awsAccessKeyId && !e.awsSecretAccessKey) fatal.push('AWS_ACCESS_KEY_ID is set without AWS_SECRET_ACCESS_KEY');
  if (!e.awsAccessKeyId && e.awsSecretAccessKey) fatal.push('AWS_SECRET_ACCESS_KEY is set without AWS_ACCESS_KEY_ID');

  if (e.storageProvider === 'gcs') {
    if (!e.gcsMediaBucket) warnings.push('GCS_MEDIA_BUCKET not set: uploads will fail');
    if (local && !e.gcsRendersBucket) warnings.push('GCS_RENDERS_BUCKET not set: render links will not work');
  } else if (e.storageProvider === 's3') {
    if (!e.s3Bucket) fatal.push('S3_BUCKET is not set (STORAGE_PROVIDER=s3)');
    if (local && !e.s3RendersBucket) fatal.push('S3_RENDERS_BUCKET is not set (STORAGE_PROVIDER=s3 with RENDER_PROVIDER=local)');
    if (!e.awsAccessKeyId) warnings.push('AWS_ACCESS_KEY_ID not set: S3 uses the default AWS credential chain');
  }

  if (e.renderProvider === 'local') {
    if (!e.remotionServeUrl) warnings.push('REMOTION_SERVE_URL not set (the composition bundle): renders will fail');
  } else if (e.renderProvider === 'lambda') {
    if (!e.remotionFunctionName) fatal.push('REMOTION_FUNCTION_NAME is not set (RENDER_PROVIDER=lambda)');
    if (!e.remotionBucket) fatal.push('REMOTION_BUCKET is not set (RENDER_PROVIDER=lambda)');
    if (!/^https:\/\//i.test(e.remotionServeUrl)) {
      fatal.push('REMOTION_SERVE_URL must be the https URL of a Remotion site on S3 (RENDER_PROVIDER=lambda)');
    }
    // Remotion's client takes keys or a profile, not the full AWS credential chain.
    const remotionKeys = Boolean(e.remotionAwsAccessKeyID && e.remotionAwsSecretAccessKey);
    const appKeys = Boolean(e.awsAccessKeyId && e.awsSecretAccessKey);
    if (!remotionKeys && !appKeys && !e.remotionAwsProfile) {
      fatal.push('Remotion Lambda needs REMOTION_AWS_ACCESS_KEY_ID/SECRET, AWS_ACCESS_KEY_ID/SECRET or AWS_PROFILE');
    }
    if (Boolean(e.remotionWebhookUrl) !== Boolean(e.remotionWebhookSecret)) {
      warnings.push('Set both REMOTION_WEBHOOK_URL and REMOTION_WEBHOOK_SECRET to complete renders by webhook; until then workers poll Lambda');
    }
  }
  return { fatal, warnings };
}

if (process.env.NODE_ENV !== 'test') checkEnvironment();
