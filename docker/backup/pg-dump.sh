#!/usr/bin/env bash
# Daily pg_dump of the WireHub database into /backups/postgres (the
# backup-dump service, profile `backup` in compose.yaml). backup-init copies
# this file from the app image into the secrets volume, which the stock
# Postgres image runs it from. Dumps once at start, then every day at
# BACKUP_DUMP_AT (HH:MM, container time; TZ sets it). Keeps the newest
# BACKUP_KEEP_DUMPS dumps; restic (Backrest) keeps the history beyond that.
#
# The connection is DATABASE_URL, or the file DATABASE_URL_FILE names (the
# bootstrap service writes the bundled Postgres's URL there).
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
    ln -sfn "$(basename "$file")" "$out/latest.dump"
    echo "backup-dump: wrote $(basename "$file") ($(stat -c %s "$file") bytes)"
  else
    rm -f "$file.partial"
    echo "backup-dump: pg_dump failed" >&2
  fi
  # newest first; drop everything after the first $keep
  ls -1t "$out"/wirehub-*.dump 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
}

until pg_isready -d "$url" -q; do sleep 2; done
dump
while true; do
  now="$(date +%s)"
  next="$(date -d "today $at" +%s)"
  [ "$next" -gt "$now" ] || next="$(date -d "tomorrow $at" +%s)"
  sleep "$((next - now))"
  dump
done
