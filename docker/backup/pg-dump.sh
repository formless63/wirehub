#!/usr/bin/env bash
# Daily pg_dump of the WireHub database into /backups/postgres (the
# backup-dump service in compose.backup.yaml). Dumps once at start, then every
# day at BACKUP_DUMP_AT (HH:MM, container time; TZ sets it). Keeps the newest
# BACKUP_KEEP_DUMPS dumps; restic (Backrest) keeps the history beyond that.
set -euo pipefail
out=/backups/postgres
at="${BACKUP_DUMP_AT:-02:30}"
keep="${BACKUP_KEEP_DUMPS:-7}"
mkdir -p "$out"

dump() {
  local stamp file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$out/wirehub-$stamp.dump"
  if pg_dump -h postgres -U wirehub -d wirehub -Fc -f "$file.partial"; then
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

until pg_isready -h postgres -U wirehub -d wirehub -q; do sleep 2; done
dump
while true; do
  now="$(date +%s)"
  next="$(date -d "today $at" +%s)"
  [ "$next" -gt "$now" ] || next="$(date -d "tomorrow $at" +%s)"
  sleep "$((next - now))"
  dump
done
