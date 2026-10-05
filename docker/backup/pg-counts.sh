#!/usr/bin/env bash
# Every WireHub table's row count, one "<schema>.<table> <count>" per line in
# name order: written beside each dump (pg-dump.sh) and compared after a
# restore (pg-restore.sh, pg-restore-check.sh). $1: a connection URL.
set -euo pipefail
url="$1"
psql -d "$url" -XAt -v ON_ERROR_STOP=1 -c "
  SELECT string_agg(format('SELECT %L || '' '' || count(*) FROM %I.%I', schemaname || '.' || tablename, schemaname, tablename), ' UNION ALL ' ORDER BY schemaname, tablename)
    FROM pg_tables WHERE schemaname IN ('studio', 'auth', 'wirehub_migrations')" \
  | psql -d "$url" -XAt -v ON_ERROR_STOP=1 \
  | sort
