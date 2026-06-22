#!/usr/bin/env bash
#
# Monthly unilevel settlement — GREEN / STAGING variant.
# Same logic as cron-unilevel-settle.sh but runs from /var/www/nogatu-green with NO NODE_ENV,
# so loadBackendEnv() loads .env.dev -> nogatualliance_staging (the isolated staging DB).
#
# ⚠️ Do NOT export NODE_ENV here: green has no .env.prod, and (since the env hardening) a
# missing env file now THROWS rather than silently falling back to the prod DB defaults.
#
# Idempotent: incometype=4 once-per-calendar-month guard + getUnilevel()=0 before the 5th.
#
# Crontab (staging — add via `crontab -e`):
#   # 5th of every month at 02:10 UTC = 10:10 Manila (offset 10 min from the blue job)
#   10 2 5 * * /var/www/nogatu-green/scripts/deploy/cron-unilevel-settle-green.sh >> /var/log/nogatu-unilevel-green.log 2>&1
#
set -euo pipefail

APP_DIR="/var/www/nogatu-green"
cd "$APP_DIR" || { echo "[cron-unilevel-green] cannot cd to $APP_DIR"; exit 1; }

# NO NODE_ENV — bare run loads .env.dev -> nogatualliance_staging.
unset NODE_ENV || true

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for c in /usr/bin/node /usr/local/bin/node /root/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "[cron-unilevel-green] node binary not found — set the absolute path in this script"; exit 1
fi

echo "[cron-unilevel-green] $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting STAGING settlement using ${NODE_BIN}"
exec "${NODE_BIN}" scripts/settle_unilevel_month.js
