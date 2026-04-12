/**
 * PM2 Ecosystem Configuration for RedDwarf
 *
 * R-19: Process manager integration for production deployment.
 *
 * Usage:
 *   pm2 start infra/pm2/ecosystem.config.cjs
 *   pm2 status
 *   pm2 logs reddwarf
 *   pm2 restart reddwarf
 *   pm2 stop reddwarf
 *
 * Prerequisites:
 *   - npm install -g pm2
 *   - .env file configured at repository root
 *   - Docker Compose services (postgres, openclaw) running
 *   - corepack pnpm build completed
 *
 * Log rotation (install once):
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 50M
 *   pm2 set pm2-logrotate:retain 10
 *   pm2 set pm2-logrotate:compress true
 */

const { resolve } = require("path");
const repoRoot = resolve(__dirname, "../..");

module.exports = {
  apps: [
    {
      name: "reddwarf",
      script: resolve(repoRoot, "scripts/start-stack.mjs"),
      cwd: repoRoot,
      interpreter: "node",
      interpreter_args: "--experimental-vm-modules",

      // ── Restart policy ──────────────────────────────────────────────
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,

      // ── Resource limits ─────────────────────────────────────────────
      max_memory_restart: "1G",

      // ── Logging ─────────────────────────────────────────────────────
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      error_file: resolve(repoRoot, "runtime-data/logs/reddwarf-error.log"),
      out_file: resolve(repoRoot, "runtime-data/logs/reddwarf-out.log"),
      merge_logs: true,
      log_type: "json",

      // ── Environment ─────────────────────────────────────────────────
      // PM2 loads .env automatically if node_args includes dotenv,
      // but RedDwarf uses its own loadRepoEnv(), so no extra config needed.
      env: {
        NODE_ENV: "production"
      },

      // ── Graceful shutdown ───────────────────────────────────────────
      kill_timeout: 15000,
      listen_timeout: 30000,
      shutdown_with_message: false,

      // ── Monitoring ──────────────────────────────────────────────────
      // Enable PM2 Plus monitoring if configured
      // pmx: true,

      // ── Cron restart (optional) ─────────────────────────────────────
      // Restart once daily at 4 AM to clear any accumulated memory pressure
      // cron_restart: "0 4 * * *",

      // ── Watch (development only — do not use in production) ─────────
      watch: false,
      ignore_watch: [
        "node_modules",
        "runtime-data",
        "artifacts",
        ".git",
        "*.log"
      ]
    }
  ]
};
