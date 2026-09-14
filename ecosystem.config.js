/**
 * PM2 Ecosystem — Blue-Green Configuration
 *
 * Blue  (nogatu-mlm)       = live production,  port 5002, /var/www/nogatu
 * Green (nogatu-mlm-green) = staging candidate, port 5003, /var/www/nogatu-green
 *
 * Green is staging-only. Production routing remains on blue port 5002 unless a separate
 * promotion/swap is explicitly authorized after QA.
 *
 * Routine staging commands must target green with --only nogatu-mlm-green. The live blue process
 * currently runs as fork/1 on the VPS, so do not recreate it from this shared file during staging.
 */
module.exports = {
  apps: [
    {
      name: 'nogatu-mlm',
      script: 'index.js',
      cwd: '/var/www/nogatu',
      exec_mode: 'cluster',
      instances: 2,
      env: {
        NODE_ENV: 'production',
        PORT: 5002,
      },
      max_memory_restart: '512M',
      restart_delay: 3000,
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'nogatu-mlm-green',
      script: 'index.js',
      cwd: '/var/www/nogatu-green',
      exec_mode: 'cluster',
      instances: 2,
      env: {
        NODE_ENV: 'development',
        PORT: 5003,
        SESSION_COOKIE_SECURE: 'true',
        SESSION_COOKIE_SAMESITE: 'none',
      },
      max_memory_restart: '512M',
      restart_delay: 3000,
      // Green is validated by its listener and HTTP health/readiness probes.
      // Do not make staging worker availability depend on PM2 readiness IPC.
      wait_ready: false,
      listen_timeout: 15000,
      kill_timeout: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
