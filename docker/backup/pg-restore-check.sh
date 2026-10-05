#!/usr/bin/env bash
# The restore check (specs/postgres-backend.md §8.5): restore a dump into a
# scratch database on the same server, compare every table's row count with
# the counts written beside the dump, drop the scratch database. Run weekly
# by backup-dump; by hand:
#   docker compose run --rm --entrypoint bash backup-dump /run/wirehub/backup/pg-restore-check.sh
# $1: the dump (default /backups/postgres/latest.dump). ADMIN_URL /
# ADMIN_URL_FILE: a role that may create databases (the bundled superuser).
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
dump="${1:-/backups/postgres/latest.dump}"
admin="${ADMIN_URL:-}"
if [ -z "$admin" ] && [ -n "${ADMIN_URL_FILE:-}" ] && [ -r "$ADMIN_URL_FILE" ]; then admin="$(tr -d '\n' < "$ADMIN_URL_FILE")"; fi
[ -n "$admin" ] || { echo "restore-check: no ADMIN_URL" >&2; exit 1; }
[ -r "$dump" ] || { echo "restore-check: no dump at $dump" >&2; exit 1; }
scratch=wirehub_restore_check
maint="$(printf '%s' "$admin" | sed -E 's#(postgres(ql)?://[^/]+)/[^?]*#\1/postgres#')"
target="$(printf '%s' "$admin" | sed -E "s#(postgres(ql)?://[^/]+)/[^?]*#\1/$scratch#")"
psql -d "$maint" -XAtq -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" -c "CREATE DATABASE $scratch TEMPLATE template0"
trap 'psql -d "$maint" -XAtq -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
pg_restore -d "$target" --no-owner --no-acl --exit-on-error "$dump"
if [ -r "$dump.counts" ]; then
  if diff <(bash "$(dirname "$0")/pg-counts.sh" "$target") "$(readlink -f "$dump.counts")" >/dev/null; then
    echo "restore-check: ok — $(basename "$(readlink -f "$dump")") restores, $(wc -l < "$dump.counts") tables with the counts it was taken with"
  else
    echo "restore-check: FAILED — row counts differ from the dump's:" >&2
    diff <(bash "$(dirname "$0")/pg-counts.sh" "$target") "$(readlink -f "$dump.counts")" >&2 || true
    exit 1
  fi
else
  echo "restore-check: ok — $(basename "$dump") restores (no counts file to compare)"
fi
