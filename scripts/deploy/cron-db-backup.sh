#!/usr/bin/env bash
#
# Nightly production DB backup — pure read-only mysqldump of nogatualliance_sysdb to
# /root/db_exports/nogatu_prod_YYYYMMDD-HHMM.sql.gz. Contains zero application/income logic;
# this is a database-layer operation only.
#
# CRITICAL — must never lock live member traffic:
#   --single-transaction --quick --no-tablespaces ONLY. Never --lock-tables, --master-data, or
#   --flush-logs/--add-locks — any of those would stall live writes on a money-critical system
#   with thousands of active members. `nice`/`ionice` below additionally make this yield CPU/IO
#   priority to the live app under load.
#
# Credentials are read from /var/www/nogatu/.env.prod (DB_USER/DB_PASSWORD/DB_NAME/DB_HOST) at
# run time — NEVER hardcoded here, NEVER echoed/logged. They are written to a mode-600
# mysql --defaults-extra-file in a private tmp path (so the password never appears in `ps`
# output, unlike a CLI -p flag) and that file is removed via a trap on EXIT, success or failure.
#
# BLUE (prod) only — run from /var/www/nogatu, credentials from .env.prod -> nogatualliance_sysdb.
# Do NOT point this at green; green's staging DB does not need a prod-cadence backup and this
# script intentionally only ever reads BLUE's .env.prod.
#
# Crontab (add via `crontab -e` on the BLUE host):
#   # nightly at 01:00 server time (Manila) — clear of the 03:30 income sweep
#   # (scripts/deploy/cron-income-sweep.sh) and the 04:30 ranking rebuild
#   # (scripts/deploy/cron-rebuild-rankings.sh)
#   0 1 * * * /var/www/nogatu/scripts/deploy/cron-db-backup.sh >> /var/log/nogatu-db-backup.log 2>&1
#
# ⚠️ This file must be executable in git, or cron silently no-ops it (Permission denied, no
# output) — this exact bug already happened once in this project (green's unilevel settle, see
# .claude/rules/lessons.md 2026-07-06). After committing, run once:
#   git update-index --chmod=+x scripts/deploy/cron-db-backup.sh
# and verify with `git ls-files -s scripts/deploy/cron-db-backup.sh` (mode must read 100755).
#
set -euo pipefail

APP_DIR="/var/www/nogatu"
ENV_FILE="${APP_DIR}/.env.prod"
BACKUP_DIR="/root/db_exports"
RETENTION_DAYS=14
MIN_BYTES=1048576   # 1 MiB floor — a real prod dump is many MB; smaller means truncated/broken

log() {
  echo "[cron-db-backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
}

if [ ! -d "$APP_DIR" ]; then
  log "APP_DIR ${APP_DIR} does not exist — aborting" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  log "env file ${ENV_FILE} does not exist — aborting" >&2
  exit 1
fi

MYSQLDUMP_BIN="$(command -v mysqldump || true)"
if [ -z "${MYSQLDUMP_BIN}" ]; then
  log "mysqldump binary not found on PATH — aborting" >&2
  exit 1
fi
GZIP_BIN="$(command -v gzip || true)"
if [ -z "${GZIP_BIN}" ]; then
  log "gzip binary not found on PATH — aborting" >&2
  exit 1
fi

# flock must exist and be checked explicitly: if the binary were missing, `flock -n 200` below
# would exit 127, the `if !` would read that as "lock held", and this script would log "skipping"
# and exit 0 — silently never backing up again while looking perfectly healthy in the log.
FLOCK_BIN="$(command -v flock || true)"
if [ -z "${FLOCK_BIN}" ]; then
  log "flock binary not found on PATH — aborting rather than risking concurrent dumps" >&2
  exit 1
fi

# Overlap guard — a second concurrent dump would double the read load on prod for nothing.
# mkdir -p covers a custom LOCKFILE path whose parent directory doesn't exist yet.
LOCKFILE="/tmp/nogatu-db-backup.lock"
mkdir -p "$(dirname "$LOCKFILE")"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  log "another backup run is already in progress — skipping"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

# --- Read DB_USER/DB_PASSWORD/DB_NAME/DB_HOST out of .env.prod defensively -----------------
# Handles trailing CR (CRLF-saved file) and single/double-quoted values; takes the LAST match
# per key (matches how a real .env file with an accidental duplicate line would behave). Never
# echoed — only assigned to shell variables and written straight into the defaults-extra-file.
env_value() {
  key="$1"
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  [ -z "$line" ] && { printf ''; return 0; }
  val="${line#${key}=}"
  val="${val%$'\r'}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

DB_USER="$(env_value DB_USER)"
DB_PASSWORD="$(env_value DB_PASSWORD)"
DB_NAME="$(env_value DB_NAME)"
DB_HOST="$(env_value DB_HOST)"

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_HOST" ]; then
  log "missing DB_USER/DB_NAME/DB_HOST in ${ENV_FILE} — aborting" >&2
  exit 1
fi

# --- Private mode-600 defaults-extra-file so the password never appears in `ps` output -----
DEFAULTS_FILE="$(mktemp /tmp/nogatu-db-backup.XXXXXX.cnf)"
chmod 600 "$DEFAULTS_FILE"
trap 'rm -f "$DEFAULTS_FILE"' EXIT

# printf '%s\n' rather than echo: bash's builtin echo does not re-expand a variable's contents
# (a password containing $ or \ is already emitted literally), but echo's backslash handling is
# implementation-defined across shells, so printf keeps this correct if the interpreter ever changes.
{
  printf '%s\n' '[client]'
  printf 'user=%s\n'     "${DB_USER}"
  printf 'password=%s\n' "${DB_PASSWORD}"
  printf 'host=%s\n'     "${DB_HOST}"
} > "$DEFAULTS_FILE"

# --- Build the dump command, yielding CPU/IO priority to live traffic ----------------------
NICE_BIN="$(command -v nice || true)"
IONICE_BIN="$(command -v ionice || true)"

DUMP_CMD=("$MYSQLDUMP_BIN" "--defaults-extra-file=${DEFAULTS_FILE}" \
  --single-transaction --quick --no-tablespaces "$DB_NAME")
if [ -n "$IONICE_BIN" ]; then
  DUMP_CMD=("$IONICE_BIN" -c2 -n7 "${DUMP_CMD[@]}")
else
  log "ionice not found — continuing without IO deprioritization"
fi
if [ -n "$NICE_BIN" ]; then
  DUMP_CMD=("$NICE_BIN" -n 19 "${DUMP_CMD[@]}")
else
  log "nice not found — continuing without CPU deprioritization"
fi

# Filename uses server-LOCAL time (Manila) to match the project's existing manual-backup naming
# precedent (e.g. nogatu_prod_PRE_SWEEP_20260706-1214.sql.gz); log lines above/below use UTC to
# match cron-income-sweep.sh / cron-unilevel-settle.sh convention. Both are internally
# consistent, just two different, deliberate clocks for two different purposes.
OUT_FILE="${BACKUP_DIR}/nogatu_prod_$(date '+%Y%m%d-%H%M').sql.gz"
TMP_OUT="${OUT_FILE}.partial"

# Extend the cleanup trap now that TMP_OUT exists, so a killed run (SIGTERM/SIGINT, or a reboot
# mid-dump) does not leave a partial archive behind forever — the prune pattern below matches
# only completed .sql.gz files, so a stray .partial would never be reclaimed. On the success
# path the `mv` has already consumed TMP_OUT, making this rm a no-op. Assigned AFTER TMP_OUT is
# set because `set -u` would abort inside the trap on an unset variable.
trap 'rm -f "$DEFAULTS_FILE" "$TMP_OUT"' EXIT

# Sweep partials stranded by PREVIOUS killed runs (flock guarantees no live run owns one).
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'nogatu_prod_*.sql.gz.partial' -delete 2>/dev/null || true

START_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
START_EPOCH="$(date +%s)"
log "starting dump of ${DB_NAME}@${DB_HOST} -> ${OUT_FILE}"

# set +e/-e brackets the pipeline so a mid-pipe failure (e.g. mysqldump auth error, or gzip
# hitting ENOSPC on a full disk) is caught and handled explicitly instead of aborting the
# script before we can clean up the partial file and log a clear error. `pipefail` (from
# `set -euo pipefail` above) is still active the whole time, and PIPESTATUS gives us the exit
# code of EACH stage regardless, so a failing mysqldump piped into a succeeding gzip is still
# correctly detected as a failure.
set +e
"${DUMP_CMD[@]}" | "$GZIP_BIN" > "$TMP_OUT"
# Copy the WHOLE array in one go: PIPESTATUS is rebuilt by every command, including a simple
# assignment, so reading ${PIPESTATUS[0]} into a variable first would leave a 1-element array
# and make ${PIPESTATUS[1]} an unbound variable under `set -u` (this failed on the first real
# run). Snapshot it, then index the copy.
PIPE_STATUS=("${PIPESTATUS[@]}")
DUMP_EXIT=${PIPE_STATUS[0]:-1}
GZIP_EXIT=${PIPE_STATUS[1]:-1}
set -e

if [ "$DUMP_EXIT" -ne 0 ] || [ "$GZIP_EXIT" -ne 0 ]; then
  log "dump failed (mysqldump exit=${DUMP_EXIT}, gzip exit=${GZIP_EXIT}) — removing partial file" >&2
  rm -f "$TMP_OUT"
  exit 1
fi

if [ ! -s "$TMP_OUT" ]; then
  log "dump produced no output file — aborting" >&2
  rm -f "$TMP_OUT"
  exit 1
fi

ACTUAL_BYTES="$(wc -c < "$TMP_OUT" | tr -d '[:space:]')"

if [ "$ACTUAL_BYTES" -lt "$MIN_BYTES" ]; then
  log "backup too small (${ACTUAL_BYTES} bytes, floor ${MIN_BYTES}) — treating as truncated/failed, deleting" >&2
  rm -f "$TMP_OUT"
  exit 1
fi

mv "$TMP_OUT" "$OUT_FILE"

END_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
END_EPOCH="$(date +%s)"
ELAPSED=$(( END_EPOCH - START_EPOCH ))

log "finished ${OUT_FILE} bytes=${ACTUAL_BYTES} elapsed_seconds=${ELAPSED} (started ${START_TS}, ended ${END_TS})"

# --- Prune old backups — ONLY this exact dated filename pattern, never a broad glob --------
# nogatu_prod_YYYYMMDD-HHMM.sql.gz specifically, so a differently-named one-off backup (e.g. a
# manual nogatu_prod_PRE_SWEEP_*.sql.gz snapshot) is never touched by this script.
PRUNED="$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name 'nogatu_prod_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9].sql.gz' \
  -mtime "+${RETENTION_DAYS}" -print -delete)"

if [ -n "$PRUNED" ]; then
  log "pruned backups older than ${RETENTION_DAYS} days:"
  while IFS= read -r f; do
    log "  removed ${f}"
  done <<< "$PRUNED"
fi

exit 0
