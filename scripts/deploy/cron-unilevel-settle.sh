#!/usr/bin/env bash
#
# Monthly unilevel settlement — run by cron on the 5th of the month (Asia/Manila).
# Settles the PREVIOUS month's unilevel for ALL members (incl. those who never log in),
# crediting only members with >=200 maintenance points. Idempotent: re-running is a no-op
# (incometype=4 once-per-calendar-month guard), and getUnilevel() returns 0 before the 5th,
# so the released-on-the-5th rule holds even if this runs slightly off-schedule.
#
# BLUE (prod) only: runs from /var/www/nogatu with NODE_ENV=production -> nogatualliance_sysdb.
#
# Crontab (add via `crontab -e`):
#   # 5th of every month at 02:00 UTC = 10:00 Manila (firmly the 5th in Manila)
#   0 2 5 * * /var/www/nogatu/scripts/deploy/cron-unilevel-settle.sh >> /var/log/nogatu-unilevel.log 2>&1
#
set -euo pipefail

APP_DIR="/var/www/nogatu"
cd "$APP_DIR" || { echo "[cron-unilevel] cannot cd to $APP_DIR"; exit 1; }

export NODE_ENV=production

# Resolve a node binary even under cron's minimal PATH.
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for c in /usr/bin/node /usr/local/bin/node /root/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "[cron-unilevel] node binary not found — set the absolute path in this script"; exit 1
fi

echo "[cron-unilevel] $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting settlement using ${NODE_BIN}"
exec "${NODE_BIN}" scripts/settle_unilevel_month.js
