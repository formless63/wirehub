#!/usr/bin/env bash
# The no-terminal-user deploy test, and the clean-install gate (S8,
# specs/postgres-backend.md §10): an empty directory with nothing but
# compose.yaml, no .env, `docker compose up -d` — then what a person does and
# checks: the secrets were generated, the app answers, the setup code is in its
# log, /setup refuses without it and with it creates the organisation, the
# starter catalog and the admin, the admin signs in and saves a design, an
# upload lands in the bucket, Postgres runs with the generated passwords, and
# the database's export is the starter catalog plus exactly that save.
#
#   bash scripts/stack-smoke.sh [--backup] [--restore] [image]
#
# --backup   runs again with COMPOSE_PROFILES=backup (a pack installed at
#            setup this time): the dump (as studio_ro, with row counts), the
#            restore check, a Backrest snapshot.
# --restore  (with --backup) the restore drill: a second stack, as on another
#            machine, gets the first one's backups and restores the database
#            and the uploaded files; the first admin signs in there and finds
#            the save and the upload.
#
# image: the WireHub image to run (default wirehub:smoke, e.g. built with
# docker build -f docker/app.Dockerfile -t wirehub:smoke .). Ports on
# 127.0.0.1: SMOKE_PORT (5191), SMOKE_BACKREST_PORT (9192), and the drill's
# second stack one above each. Everything it creates is removed at the end.
set -euo pipefail
backup=0
restore=0
while [ "${1:-}" = "--backup" ] || [ "${1:-}" = "--restore" ]; do
  [ "$1" = "--backup" ] && backup=1
  [ "$1" = "--restore" ] && restore=1
  shift
done
image="${1:-wirehub:smoke}"
port="${SMOKE_PORT:-5191}"
backrest_port="${SMOKE_BACKREST_PORT:-9192}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/wirehub-smoke.XXXXXX")"
# the stack's directory holds compose.yaml only; what the checks write goes beside it
scratch="$(mktemp -d "${TMPDIR:-/tmp}/wirehub-smoke-scratch.XXXXXX")"
project="wirehub-smoke-$$"
second="wirehub-smoke-$$-b"
cp -f "$repo/compose.yaml" "$work/compose.yaml"
cd "$work"
export WIREHUB_IMAGE="$image" WIREHUB_PORT="$port" BACKREST_PORT="$backrest_port"
compose() { docker compose -p "$project" "$@"; }
b() { COMPOSE_PROFILES=backup WIREHUB_PORT=$((port + 1)) BACKREST_PORT=$((backrest_port + 1)) docker compose -p "$second" "$@"; }
cleanup() {
  COMPOSE_PROFILES=backup docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  b down -v --remove-orphans >/dev/null 2>&1 || true
  cd / && rm -rf "$work" "$scratch"
}
trap cleanup EXIT
fail() {
  echo "smoke: FAILED — $*" >&2
  COMPOSE_PROFILES=backup compose ps -a >&2 || true
  COMPOSE_PROFILES=backup compose logs --tail 40 >&2 || true
  exit 1
}
log_has() { # service, extended regex — retried: a log can lag behind the container
  for _ in $(seq 1 30); do compose logs --no-log-prefix "$1" 2>/dev/null | grep -qE "$2" && return 0; sleep 1; done
  return 1
}
wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}
cli() { # the database commands inside the app container
  compose exec -T wirehub node --experimental-strip-types --no-warnings --import ./server/boot-env.ts server/pg/cli.ts "$@"
}

admin_email="admin@example.com"
admin_password="smoke-test admin password"
jar="$scratch/cookies"

check_stack() { # $1: modules to enable at setup (JSON array)
  local modules="$1"
  echo "smoke: $(ls -A | tr '\n' ' ')— no .env; up -d${COMPOSE_PROFILES:+ with COMPOSE_PROFILES=$COMPOSE_PROFILES}"
  compose up -d --quiet-pull >/dev/null 2>&1 || fail "docker compose up"
  wait_for "http://127.0.0.1:$port/healthz" 180 || fail "the app did not answer on port $port"
  echo "smoke: app answers /healthz"
  log_has bootstrap 'postgres_password: (generated|kept)' || fail "bootstrap did not fill the secrets volume"
  log_has migrate 'applied|up to date' || fail "migrate did not run the migrations"
  log_has migrate 'adopt: a fresh install' || fail "migrate did not leave the fresh install to setup"
  echo "smoke: migrate ran the migrations and left the fresh install to /setup"
  local code=""
  for _ in $(seq 1 30); do
    code="$(compose logs --no-log-prefix wirehub | grep -oE '^ +[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' | tail -1 | tr -d ' ' || true)"
    [ -n "$code" ] && break
    sleep 1
  done
  [ -n "$code" ] || fail "no setup code in the wirehub log"
  echo "smoke: setup code in the log ($code)"
  local origin="http://127.0.0.1:$port"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/designs")" = 503 ] || fail "a hub without an organisation did not answer 503"
  curl -fsS "$origin/setup" -o /dev/null || fail "the setup page did not open"
  local form refused
  form="{\"org\":{\"name\":\"Smoke Shop\",\"slug\":\"smoke-shop\"},\"catalog\":\"starter\",\"modules\":$modules,\"admin\":{\"name\":\"Smoke Admin\",\"email\":\"$admin_email\",\"password\":\"$admin_password\"}"
  refused="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $origin" -d "$form}" "$origin/api/setup")"
  [ "$refused" = 403 ] || fail "/api/setup without the code answered $refused, not 403"
  curl -fsS -X POST -H 'content-type: application/json' -H "origin: $origin" -d "$form,\"code\":\"$code\"}" "$origin/api/setup" | grep -q '"created"' || fail "/setup did not create the organisation"
  echo "smoke: /setup refused no code; with the code created the organisation, the starter catalog and the admin (modules: $modules)"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/designs")" = 401 ] || fail "after setup, a request without a session was not refused"
  rm -f "$jar"
  curl -fsS -c "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" -d "{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" "$origin/api/auth/sign-in/email" -o /dev/null || fail "the admin could not sign in"
  curl -fsS -b "$jar" "$origin/api/designs" | grep -q 'de9-crossover' || fail "the signed-in admin does not see the starter catalog"
  echo "smoke: the admin signs in and sees the starter catalog"
  local etag design
  etag="$(curl -fsS -b "$jar" -D - -o "$scratch/design.json" "$origin/api/designs/dc-y-splitter" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
  design="$(sed 's/"label": *"[^"]*"/"label":"Saved by the smoke test"/' "$scratch/design.json")"
  curl -fsS -b "$jar" -X PUT -H 'content-type: application/json' -H "origin: $origin" -H "if-match: $etag" -d "$design" "$origin/api/designs/dc-y-splitter" -o /dev/null || fail "the admin could not save a design"
  curl -fsS -b "$jar" "$origin/api/backup" | grep -q '"state": "database"' || fail "the indicator does not say the database holds the saves"
  echo "smoke: a design save lands; the indicator says Saved (the database)"
  local photo
  etag="$(curl -fsS -b "$jar" -D - -o /dev/null "$origin/api/drawings/dc-y-splitter" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
  photo="data:image/png;base64,$(printf 'wirehub smoke %s' "$$" | base64)"
  curl -fsS -b "$jar" -X PUT -H 'content-type: application/json' -H "origin: $origin" -H "if-match: $etag" -d "{\"photo\":\"$photo\"}" "$origin/api/drawings/dc-y-splitter/photo" >/dev/null || fail "photo upload"
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" --entrypoint sh rclone/rclone:1.75.1 -c \
    'RCLONE_CONFIG_G_TYPE=s3 RCLONE_CONFIG_G_PROVIDER=Other RCLONE_CONFIG_G_ENDPOINT=http://garage:3900 RCLONE_CONFIG_G_REGION=garage RCLONE_CONFIG_G_FORCE_PATH_STYLE=true RCLONE_CONFIG_G_ACCESS_KEY_ID=$(cat /run/wirehub/s3_backup_access_key_id) RCLONE_CONFIG_G_SECRET_ACCESS_KEY=$(cat /run/wirehub/s3_backup_secret_access_key) rclone ls g:wirehub 2>/dev/null' \
    | grep -qE '/sha256/' || fail "the upload is not in the Garage bucket"
  echo "smoke: an uploaded photo is in the Garage bucket (keys created by Garage)"
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" postgres:18.6-bookworm \
    sh -c 'psql "$(cat /run/wirehub/database_url)" -tAc "select studio.org_count()"' | grep -q '^1$' || fail "Postgres did not take the generated password"
  echo "smoke: Postgres is up; studio_app connects with its generated password"
  if [ "$modules" = "[]" ]; then
    # S8: the database's export is the starter catalog plus exactly the save (and the setup record)
    cli export --out /tmp/smoke-export >/dev/null || fail "pg:export"
    local diff expected
    diff="$(compose exec -T wirehub sh -c 'diff -rq /tmp/smoke-export/data /app/starter-catalog' | sort || true)"
    expected="$(printf '%s\n' \
      'Files /tmp/smoke-export/data/designs/dc-y-splitter.json and /app/starter-catalog/designs/dc-y-splitter.json differ' \
      'Only in /tmp/smoke-export/data/drawings: dc-y-splitter.photo-ref.json' \
      'Only in /tmp/smoke-export/data: assets' \
      'Only in /tmp/smoke-export/data: setup.json' | sort)"
    [ "$diff" = "$expected" ] || fail "the export is not the starter plus the save: $diff"
    echo "smoke: the export is the starter catalog plus the save, the photo and the setup record — nothing else"
  fi
}

check_stack '[]'
if [ "$backup" = 1 ]; then
  compose down -v >/dev/null 2>&1
  export COMPOSE_PROFILES=backup
  check_stack '["pc-serial"]'
  curl -fsS -b "$jar" "http://127.0.0.1:$port/api/designs/db9-null-modem" -o /dev/null || fail "the pc-serial pack's design is not there"
  echo "smoke: the pc-serial pack installed at setup"
  # a fresh dump with the save in it (backup-dump dumps at start)
  compose restart backup-dump >/dev/null
  for _ in $(seq 1 60); do [ "$(compose logs --no-log-prefix backup-dump | grep -c 'backup-dump: wrote')" -ge 2 ] && break; sleep 1; done
  log_has backup-dump 'tables counted' || fail "backup-dump did not dump (as studio_ro) with row counts"
  echo "smoke: $(compose logs --no-log-prefix backup-dump | grep 'backup-dump: wrote' | tail -1)"
  compose run --rm -T --entrypoint bash backup-dump /run/wirehub/backup/pg-restore-check.sh > "$scratch/check.log" 2>&1 || true
  grep -q 'restore-check: ok' "$scratch/check.log" || fail "the restore check: $(cat "$scratch/check.log")"
  echo "smoke: $(grep 'restore-check: ok' "$scratch/check.log")"
  # a fresh mirror with the upload in it (backup-mirror syncs at start, then every BACKUP_MIRROR_INTERVAL)
  compose restart backup-mirror >/dev/null 2>&1
  log_has backup-mirror 'synced [1-9]' || fail "backup-mirror did not mirror the bucket"
  wait_for "http://127.0.0.1:$backrest_port/" 60 || fail "Backrest did not answer"
  curl -fsS -X POST -H 'content-type: application/json' -d '{"value":"wirehub"}' "http://127.0.0.1:$backrest_port/v1.Backrest/Backup" >/dev/null || fail "Backrest backup"
  snapshots=""
  for _ in $(seq 1 60); do
    snapshots="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"repoId":"wirehub"}' "http://127.0.0.1:$backrest_port/v1.Backrest/ListSnapshots" || true)"
    echo "$snapshots" | grep -q '"paths":\["/sources"\]' && break
    sleep 2
  done
  echo "$snapshots" | grep -q '"paths":\["/sources"\]' || fail "no snapshot of /sources"
  echo "smoke: Backrest took a snapshot of /sources (dump, bucket mirror, catalog, auth, packs)"

  if [ "$restore" = 1 ]; then
    # the drill: another stack, as on another machine; started once (roles, bucket), setup left alone
    b up -d --quiet-pull >/dev/null 2>&1 || fail "the second stack did not start"
    wait_for "http://127.0.0.1:$((port + 1))/healthz" 180 || fail "the second stack's app did not answer"
    # the first stack's backups/ — what Backrest restores from its snapshot
    docker run --rm -v "${project}_backups:/from:ro" -v "${second}_backups:/to" alpine sh -c 'rm -rf /to/* && cp -a /from/. /to/' || fail "copying the backups"
    b stop wirehub >/dev/null 2>&1
    b run --rm -T --entrypoint bash backup-dump /run/wirehub/backup/pg-restore.sh > "$scratch/restore.log" 2>&1 || true
    grep -q 'restore: done' "$scratch/restore.log" || fail "pg-restore: $(cat "$scratch/restore.log")"
    b run --rm -T --entrypoint sh backup-mirror /run/wirehub/backup/blob-restore.sh >> "$scratch/restore.log" 2>&1 || true
    grep -q 'blob-restore: copied' "$scratch/restore.log" || fail "blob-restore: $(cat "$scratch/restore.log")"
    b start wirehub >/dev/null 2>&1
    wait_for "http://127.0.0.1:$((port + 1))/healthz" 120 || fail "the restored app did not answer"
    origin2="http://127.0.0.1:$((port + 1))"
    rm -f "$jar"
    curl -fsS -c "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin2" -d "{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" "$origin2/api/auth/sign-in/email" -o /dev/null || fail "the first stack's admin could not sign in to the restored one"
    curl -fsS -b "$jar" "$origin2/api/designs/dc-y-splitter" | grep -q 'Saved by the smoke test' || fail "the restored hub does not have the save"
    curl -fsS -b "$jar" "$origin2/api/drawings/dc-y-splitter" | grep -q 'data:image/png;base64' || fail "the restored hub does not serve the upload"
    echo "smoke: restore drill — $(grep -E 'restore: done|blob-restore: copied' "$scratch/restore.log" | tr '\n' ' ')"
    echo "smoke: on the second stack the first admin signs in, and finds the save and the upload"
  fi
fi
echo "smoke: passed"
