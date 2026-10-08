import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    // One in-memory MongoDB per test file; files run in parallel workers.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 120_000, // first run downloads the MongoDB test binary
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-access-secret-0123456789abcdef0123456789',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef01234567',
      JWT_EXPIRES_IN: '15m',
      CDN_URL: 'https://cdn.test',
      S3_BUCKET: 'test-bucket',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5720',
      APPLE_CLIENT_ID: 'com.shotline.test',
    },
  },
});
