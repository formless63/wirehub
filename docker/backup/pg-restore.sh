#!/usr/bin/env bash
# Restore the WireHub database from a dump (docs/self-hosting.md, "Restore").
# Replaces the database: stop the app first (docker compose stop wirehub),
# then:
#   docker compose run --rm --entrypoint bash backup-dump /run/wirehub/backup/pg-restore.sh [dump]
# $1: the dump (default /backups/postgres/latest.dump). The roles must exist
# (a first `docker compose up` creates them). Compares the row counts with
# the counts written beside the dump.
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
dump="${1:-/backups/postgres/latest.dump}"
admin="${ADMIN_URL:-}"
if [ -z "$admin" ] && [ -n "${ADMIN_URL_FILE:-}" ] && [ -r "$ADMIN_URL_FILE" ]; then admin="$(tr -d '\n' < "$ADMIN_URL_FILE")"; fi
[ -n "$admin" ] || { echo "restore: no ADMIN_URL" >&2; exit 1; }
[ -r "$dump" ] || { echo "restore: no dump at $dump" >&2; exit 1; }
db="$(printf '%s' "$admin" | sed -E 's#^postgres(ql)?://[^/]+/([^?]*).*#\2#')"
[ -n "$db" ] && [ "$db" != "postgres" ] || db=wirehub
maint="$(printf '%s' "$admin" | sed -E 's#(postgres(ql)?://[^/]+)/[^?]*#\1/postgres#')"
target="$(printf '%s' "$admin" | sed -E "s#(postgres(ql)?://[^/]+)/[^?]*#\1/$db#")"
echo "restore: replacing database $db with $(basename "$(readlink -f "$dump")")"
psql -d "$maint" -XAtq -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$db\" OWNER studio_owner LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' TEMPLATE template0" \
  -c "GRANT CONNECT, CREATE, TEMPORARY ON DATABASE \"$db\" TO studio_owner" \
  -c "GRANT CONNECT ON DATABASE \"$db\" TO studio_app, studio_ro" \
  -c "REVOKE CONNECT ON DATABASE \"$db\" FROM PUBLIC"
pg_restore -d "$target" --exit-on-error "$dump"
if [ -r "$dump.counts" ]; then
  if diff <(bash "$(dirname "$0")/pg-counts.sh" "$target") "$(readlink -f "$dump.counts")" >/dev/null; then
    echo "restore: done — every table has the row count the dump was taken with"
  else
    echo "restore: row counts differ from the dump's:" >&2
    diff <(bash "$(dirname "$0")/pg-counts.sh" "$target") "$(readlink -f "$dump.counts")" >&2 || true
    exit 1
  fi
else
  echo "restore: done (no counts file to compare)"
fi
