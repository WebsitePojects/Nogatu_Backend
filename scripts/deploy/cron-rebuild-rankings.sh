#!/usr/bin/env bash
#
# Nightly ranking-leaderboard rebuild — invokes the EXISTING rebuild script
# (scripts/rebuild_rankings.js) as a backstop so the leaderboard snapshot in `rankingstab`
# does not go stale between member/admin-triggered refreshes (uplines never recompute on their
# own when a downline repurchases — see .claude/rules/system-health.md §4 and .claude/rules/
# lessons.md 2026-08-03). Contains zero ranking math itself; pure orchestration.
#
# Read-only w.r.t. money: rebuild_rankings.js recomputes `rankingstab` snapshot rows only. It
# never writes payouttotaltab/payouthistorytab/ttlincomeN and never releases a rank incentive
# (that stays a guarded admin action). Takes ~95s for ~7,500 members on prod.
#
# BLUE (prod) variant — run from /var/www/nogatu with NODE_ENV=production -> nogatualliance_sysdb.
# For the GREEN/staging box, copy this file, change APP_DIR to /var/www/nogatu-green and DO NOT
# export NODE_ENV (green has no .env.prod — see .claude/rules/blue-green.md NODE_ENV trap).
#
# Crontab (add via `crontab -e` on the BLUE host):
#   # nightly at 04:30 server time (Manila) — clear of the 03:30 income sweep
#   # (scripts/deploy/cron-income-sweep.sh) and the monthly 02:00-on-the-5th unilevel settle
#   # (scripts/deploy/cron-unilevel-settle.sh)
#   30 4 * * * /var/www/nogatu/scripts/deploy/cron-rebuild-rankings.sh >> /var/log/nogatu-rebuild-rankings.log 2>&1
#
# ⚠️ This file must be executable in git, or cron silently no-ops it (Permission denied, no
# output) — this exact bug already happened once in this project (green's unilevel settle, see
# .claude/rules/lessons.md 2026-07-06). After committing, run once:
#   git update-index --chmod=+x scripts/deploy/cron-rebuild-rankings.sh
# and verify with `git ls-files -s scripts/deploy/cron-rebuild-rankings.sh` (mode must read 100755).
#
set -euo pipefail

APP_DIR="/var/www/nogatu"
cd "$APP_DIR" || { echo "[cron-rebuild-rankings] cannot cd to $APP_DIR"; exit 1; }

export NODE_ENV=production

# Resolve a node binary even under cron's minimal PATH.
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for c in /usr/bin/node /usr/local/bin/node /root/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "[cron-rebuild-rankings] node binary not found — set the absolute path in this script"; exit 1
fi

# flock must exist and be checked explicitly: if the binary were missing, `flock -n 200` below
# would exit 127, the `if !` would read that as "lock held", and this script would log "skipping"
# and exit 0 — silently never rebuilding again while looking perfectly healthy in the log.
FLOCK_BIN="$(command -v flock || true)"
if [ -z "${FLOCK_BIN}" ]; then
  echo "[cron-rebuild-rankings] flock binary not found — aborting rather than risking concurrent rebuilds"; exit 1
fi

# Overlap guard: rebuild_rankings.js takes ~95s and touches every rankingstab row; two
# concurrent runs would be wasted work at best and a lock-contention pileup at worst. flock -n
# fails immediately (never blocks) if another run already holds the lock, and we skip quietly.
LOCKFILE="/tmp/nogatu-rebuild-rankings.lock"
mkdir -p "$(dirname "$LOCKFILE")"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "[cron-rebuild-rankings] $(date -u '+%Y-%m-%dT%H:%M:%SZ') another run is already in progress — skipping"
  exit 0
fi

START_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
START_EPOCH="$(date +%s)"
echo "[cron-rebuild-rankings] ${START_TS} starting rebuild using ${NODE_BIN}"

# NOTE: deliberately NOT `exec`'d (unlike cron-income-sweep.sh / cron-unilevel-settle.sh) —
# exec would replace this shell process, making it impossible to log the end timestamp,
# elapsed time, and exit code below. set +e/-e brackets the call so a non-zero exit from node
# doesn't trip `set -e` before we've logged it and propagated it ourselves.
set +e
"${NODE_BIN}" scripts/rebuild_rankings.js
EXIT_CODE=$?
set -e

END_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
END_EPOCH="$(date +%s)"
ELAPSED=$(( END_EPOCH - START_EPOCH ))

echo "[cron-rebuild-rankings] ${END_TS} finished exit_code=${EXIT_CODE} elapsed_seconds=${ELAPSED}"

exit "${EXIT_CODE}"
