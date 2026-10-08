// pm2 apps for the EC2 box (/var/www/shotline/ecosystem.config.cjs).
// Copy the backend/worker entries into the box's real file; paths there may differ.
//
// The API and the workers are separate processes so `pm2 reload shotline-backend`
// (every deploy) never interrupts a render, transcription or reframe job.
// Deploy order: reload the API first, then the worker; the worker drains its
// active jobs before restarting.

module.exports = {
  apps: [
    {
      name: 'shotline-backend',
      cwd: '/var/www/shotline/video-editor-backend',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        // Workers run in shotline-worker, not in the API process.
        ENABLE_WORKERS: 'false',
      },
      kill_timeout: 15000,
    },
    {
      name: 'shotline-worker',
      cwd: '/var/www/shotline/video-editor-backend',
      script: 'dist/worker.js',
      env: {
        NODE_ENV: 'production',
        // How long active jobs may run after a stop/restart request.
        WORKER_DRAIN_TIMEOUT_MS: '600000',
      },
      // A bit above WORKER_DRAIN_TIMEOUT_MS so pm2 doesn't SIGKILL a draining worker.
      kill_timeout: 630000,
      // Exits when Redis is unreachable; restart with growing delays.
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '1500M',
    },
  ],
};
