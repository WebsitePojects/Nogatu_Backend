#!/usr/bin/env bash
#
# Nightly income settlement sweep — invokes the EXISTING idempotent income engine
# (calculateAndStoreIncome, via scripts/settle_income_sweep.js --commit) for every member, so
# direct-referral/pairing/leadership/hi-five income no longer waits for the member to personally
# load their dashboard/wallet ("stranded income" until login). Contains zero income math itself.
#
# Idempotent + safe to re-run: the engine reconciles every income type monotonically
# (Math.max(0, entitlement - stored)), takes a per-uid GET_LOCK, and writes inside its own
# transaction with FOR UPDATE — see services/income/calculateAndStoreIncome.js. This cron job is
# pure orchestration; a failed/partial run (crash, box reboot) is safe to simply re-run.
#
# BLUE (prod) variant — run from /var/www/nogatu with NODE_ENV=production -> nogatualliance_sysdb.
# For the GREEN/staging box, copy this file, change APP_DIR to /var/www/nogatu-green and DO NOT
# export NODE_ENV (green has no .env.prod — see .claude/rules/blue-green.md NODE_ENV trap).
#
# Crontab (add via `crontab -e` on the BLUE host):
#   # nightly at 03:30 server time — low-traffic window, well clear of month-rollover unilevel
#   # settlement (scripts/deploy/cron-unilevel-settle.sh, 5th of month 02:00 UTC)
#   30 3 * * * /var/www/nogatu/scripts/deploy/cron-income-sweep.sh >> /var/log/nogatu-income-sweep.log 2>&1
#
# ⚠️ This file must be executable in git, or cron silently no-ops it (Permission denied, no
# output). After committing, run once:
#   git update-index --chmod=+x scripts/deploy/cron-income-sweep.sh
# and verify with `git ls-files -s scripts/deploy/cron-income-sweep.sh` (mode must read 100755).
#
set -euo pipefail

APP_DIR="/var/www/nogatu"
cd "$APP_DIR" || { echo "[cron-income-sweep] cannot cd to $APP_DIR"; exit 1; }

export NODE_ENV=production

# Resolve a node binary even under cron's minimal PATH.
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for c in /usr/bin/node /usr/local/bin/node /root/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "[cron-income-sweep] node binary not found — set the absolute path in this script"; exit 1
fi

echo "[cron-income-sweep] $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting settlement using ${NODE_BIN}"
exec "${NODE_BIN}" scripts/settle_income_sweep.js --commit --sleep-ms 250
