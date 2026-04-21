module.exports = {
  apps: [
    {
      name: 'api',
      script: 'src/index.ts',
      interpreter: 'bun',
      watch: false,
      autorestart: true,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
      merge_logs: true,
      log_type: 'json',
      env: { PM2_APP_NAME: 'api' },
    },
    {
      name: 'worker-manager',
      script: 'src/workers/index.ts',
      interpreter: 'bun',
      watch: false,
      autorestart: true,
      max_memory_restart: '768M',
      exp_backoff_restart_delay: 100,
      merge_logs: true,
      log_type: 'json',
      env: { PM2_APP_NAME: 'worker-manager' },
    },
  ],
};
