// pm2 apps on the shotline-app VM (/var/www/shotline/ecosystem.config.cjs,
// delivered via instance metadata). Run as the `shotline` user.
//
// The API and the workers are separate processes so reloading the API on a
// deploy never interrupts a render, transcription or reframe job.

module.exports = {
  apps: [
    {
      name: 'shotline-frontend',
      cwd: '/var/www/shotline/frontend',
      script: 'node_modules/@remix-run/serve/dist/cli.js',
      args: './build/server/index.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production', PORT: '3000' },
      max_memory_restart: '1500M',
    },
    {
      name: 'shotline-backend',
      cwd: '/var/www/shotline/backend',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production', ENABLE_WORKERS: 'false' },
      kill_timeout: 15000,
    },
    {
      name: 'shotline-worker',
      cwd: '/var/www/shotline/backend',
      script: 'dist/worker.js',
      env: { NODE_ENV: 'production', WORKER_DRAIN_TIMEOUT_MS: '600000' },
      // A bit above WORKER_DRAIN_TIMEOUT_MS so pm2 doesn't SIGKILL a draining worker.
      kill_timeout: 630000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '6G', // renders run here from Phase 3
    },
  ],
};
