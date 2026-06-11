/**
 * PM2 Ecosystem — Blue-Green Configuration
 *
 * Blue  (nogatu-mlm)       = live production,  port 5002, /var/www/nogatu
 * Green (nogatu-mlm-green) = staging candidate, port 5003, /var/www/nogatu-green
 *
 * Deploy flow:
 *   1. GitHub Actions deploys to green and runs health/smoke checks
 *   2. scripts/deploy/swap.sh switches Nginx upstream to :5003
 *   3. Blue stays warm as hot standby; rollback = swap.sh blue
 *
 * Scale instances to 'max' (all CPU cores) for 100k-user production load.
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
        NODE_ENV: 'staging',
        PORT: 5003,
      },
      max_memory_restart: '512M',
      restart_delay: 3000,
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
