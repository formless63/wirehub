#!/usr/bin/env bash
# Daily pg_dump of the WireHub database into /backups/postgres (the
# backup-dump service, profile `backup` in compose.yaml). backup-init copies
# this file from the app image into the secrets volume, which the stock
# Postgres image runs it from. Dumps once at start, then every day at
# BACKUP_DUMP_AT (HH:MM, container time; TZ sets it). Keeps the newest
# BACKUP_KEEP_DUMPS dumps; restic (Backrest) keeps the history beyond that.
#
# The connection is DATABASE_URL, or the file DATABASE_URL_FILE names: the
# read-only role studio_ro (BYPASSRLS, SELECT only), whose URL the bootstrap
# service writes. Beside each dump, <dump>.counts holds every table's row
# count, which a restore and the weekly restore check compare against.
#
# The weekly restore check (BACKUP_CHECK_DAY, 0-6 with 0 = Sunday; default 0)
# restores the newest dump into a scratch database and compares the counts —
# it needs the admin connection (ADMIN_URL / ADMIN_URL_FILE) to create it.
set -euo pipefail
out=/backups/postgres
at="${BACKUP_DUMP_AT:-02:30}"
keep="${BACKUP_KEEP_DUMPS:-7}"
url="${DATABASE_URL:-}"
if [ -z "$url" ] && [ -n "${DATABASE_URL_FILE:-}" ] && [ -r "$DATABASE_URL_FILE" ]; then
  url="$(tr -d '\n' < "$DATABASE_URL_FILE")"
fi
if [ -z "$url" ]; then
  echo "backup-dump: no DATABASE_URL (or DATABASE_URL_FILE) to dump" >&2
  exit 1
fi
mkdir -p "$out"

dump() {
  local stamp file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$out/wirehub-$stamp.dump"
  if pg_dump -d "$url" -Fc -f "$file.partial"; then
    mv -f "$file.partial" "$file"
    bash "$(dirname "$0")/pg-counts.sh" "$url" > "$file.counts" || echo "backup-dump: could not count rows" >&2
    ln -sfn "$(basename "$file")" "$out/latest.dump"
    ln -sfn "$(basename "$file").counts" "$out/latest.dump.counts"
    echo "ok $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/dump.status"
    echo "backup-dump: wrote $(basename "$file") ($(stat -c %s "$file") bytes, $(wc -l < "$file.counts") tables counted)"
  else
    rm -f "$file.partial"
    echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/dump.status"
    echo "backup-dump: pg_dump failed" >&2
  fi
  # newest first; drop everything after the first $keep
  ls -1t "$out"/wirehub-*.dump 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old" "$old.counts"; done
}

admin="${ADMIN_URL:-}"
if [ -z "$admin" ] && [ -n "${ADMIN_URL_FILE:-}" ] && [ -r "$ADMIN_URL_FILE" ]; then admin="$(tr -d '\n' < "$ADMIN_URL_FILE")"; fi
check() {
  [ -n "$admin" ] || return 0
  [ "$(date +%w)" = "${BACKUP_CHECK_DAY:-0}" ] || return 0
  ADMIN_URL="$admin" bash "$(dirname "$0")/pg-restore-check.sh" "$out/latest.dump" || echo "backup-dump: RESTORE CHECK FAILED" >&2
}

until pg_isready -d "$url" -q; do sleep 2; done
dump
while true; do
  now="$(date +%s)"
  next="$(date -d "today $at" +%s)"
  [ "$next" -gt "$now" ] || next="$(date -d "tomorrow $at" +%s)"
  sleep "$((next - now))"
  dump
  check
done
