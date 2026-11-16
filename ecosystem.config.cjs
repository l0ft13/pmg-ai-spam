// pm2 process file. Build first (npm run build), then: pm2 start ecosystem.config.cjs
// Settings come from .env in this folder, which the app loads itself on start.
module.exports = {
  apps: [
    {
      name: "exchange-spam-triage",
      script: "dist/index.js",
      cwd: __dirname,
      // One process only: the poller must not run twice against the same quarantine.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // A bad .env makes the app exit at once; back off instead of spinning.
      exp_backoff_restart_delay: 2000,
      max_restarts: 20,
      min_uptime: "20s",
      max_memory_restart: "400M",
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
