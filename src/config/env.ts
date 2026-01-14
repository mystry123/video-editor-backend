import * as dotenv from 'dotenv';
dotenv.config();

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
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'your-super-secret-refresh-key-change-in-production',
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
  remotionWebhookSecret: process.env.REMOTION_WEBHOOK_SECRET || '',

  
  
  // Remotion
  remotionServeUrl: process.env.REMOTION_SERVE_URL || '',
  remotionFunctionName: process.env.REMOTION_FUNCTION_NAME || '',
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
