#!/usr/bin/env bash
# The no-terminal-user deploy test, and the clean-install gate (S8,
# specs/postgres-backend.md §10): an empty directory with nothing but
# compose.yaml, no .env, `docker compose up -d` — then what a person does and
# checks: the secrets were generated, the app answers, the setup code is in its
# log, /setup refuses without it and with it creates the organisation, the
# starter catalog and the admin, the admin signs in and saves a design, an
# upload lands in the bucket, Postgres runs with the generated passwords, the
# worker (which waited for setup) converts a STEP upload and runs a job end to
# end inside its memory cap, a dump as studio_ro restores into a scratch
# database, and the database's export is the starter catalog plus exactly
# that save and that model.
#
#   bash scripts/stack-smoke.sh [--upgrade] [--backup] [--restore] [--old-backrest-config] [image]
#
# --upgrade  first, a hub on the file backend (as before v0.1.0) set up and
#            edited, then started with this compose.yaml's defaults: migrate
#            moves its catalog into the database, and the first admin claims
#            the hub at /setup with the setup code.
# --backup   runs again with COMPOSE_PROFILES=backup (a pack installed at
#            setup this time): the dump (as studio_ro, with row counts), the
#            restore check, a Backrest snapshot and its post-snapshot hook
#            (the marker the deep health check and blob GC read).
# --old-backrest-config  (with --backup) the backup stack starts with a Backrest
#            configuration made before the post-snapshot hooks existed (a plan
#            with none); backup-init must add them, and the snapshot must
#            still touch the marker.
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
upgrade=0
old_config=0
while [ "${1:-}" = "--backup" ] || [ "${1:-}" = "--restore" ] || [ "${1:-}" = "--upgrade" ] || [ "${1:-}" = "--old-backrest-config" ]; do
  [ "$1" = "--old-backrest-config" ] && old_config=1
  [ "$1" = "--backup" ] && backup=1
  [ "$1" = "--restore" ] && restore=1
  [ "$1" = "--upgrade" ] && upgrade=1
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
  for _ in $(seq 1 30); do compose logs --no-log-prefix "$1" 2>/dev/null | contains "$2" && return 0; sleep 1; done
  return 1
}
wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}
# a pattern in all of stdin — never `| grep -q`, which closes the pipe early and,
# under pipefail, fails the writer (curl) with a broken pipe on a long answer
contains() { local input; input="$(cat)"; grep -qE -- "$1" <<<"$input"; }
cli() { # the database commands inside the app container
  compose exec -T wirehub node --experimental-strip-types --no-warnings --import ./server/boot-env.ts server/pg/cli.ts "$@"
}

admin_email="admin@example.com"
admin_password="smoke-test admin password"
jar="$scratch/cookies"

mib() { awk '{ printf "%d", $1 / 1048576 }'; }

check_worker() { # $1: the app's origin; the admin is signed in ($jar)
  local origin="$1" job="" state="" i
  log_has worker 'working .*import' || fail "the worker did not start working after setup"
  echo "smoke: worker — $(compose logs --no-log-prefix worker | grep -oE 'working [a-z, -]+ for org' | tail -1)"
  # a person's STEP upload converts in the worker (the convert job); the request and its answer are unchanged
  printf '{"name":"cube.step","data":"%s"}' "$(base64 -w0 "$repo/apps/studio/test/fixtures/models/cube-colours.stp")" > "$scratch/upload.json"
  curl -sS -b "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" -H 'if-match: *' --data-binary @"$scratch/upload.json" \
    "$origin/api/models/connectors/de9-male/upload" > "$scratch/upload.out" || true
  contains '"triangles"' < "$scratch/upload.out" || fail "the STEP upload: $(head -c 300 "$scratch/upload.out")"
  log_has worker 'convert [0-9a-f-]+ done' || fail "the STEP upload did not convert in the worker"
  echo "smoke: a STEP upload converted in the worker ($(grep -oE '"peakRssMb": *[0-9]+' "$scratch/upload.out" | head -1 | tr -d ' "') in the conversion child) and is linked"
  # a job by request, end to end: queued, run by the worker, done
  job="$(curl -fsS -b "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" -d '{"kind":"model-cache"}' "$origin/api/jobs" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  [ -n "$job" ] || fail "POST /api/jobs did not queue a job"
  for i in $(seq 1 60); do
    state="$(curl -fsS -b "$jar" "$origin/api/jobs/$job" | grep -oE '"status": *"[a-z]+"' | head -1 | grep -oE '[a-z]+"$' | tr -d '"')"
    [ "$state" = done ] || [ "$state" = failed ] && break
    sleep 1
  done
  [ "$state" = done ] || fail "the model-cache job ended '$state'"
  curl -fsS -b "$jar" "$origin/api/jobs" | contains '"beatAt"' || fail "GET /api/jobs shows no worker heartbeat"
  compose exec -T worker sh -c 'find /tmp/wirehub-worker.beat -mmin -3' | contains 'beat' || fail "the worker's heartbeat file is stale"
  curl -fsS "$origin/healthz?deep=1" > "$scratch/deep.json" || fail "the deep health check failed: $(cat "$scratch/deep.json")"
  tr -d ' \n' < "$scratch/deep.json" | contains '"name":"worker","ok":true' || fail "the deep health check has no passing worker check: $(cat "$scratch/deep.json")"
  echo "smoke: a model-cache job ran end to end in the worker ($job); the heartbeat is fresh, and /healthz?deep=1 passes its worker check"
  # a backup restores: pg_dump as studio_ro (which must read the queue tables the worker made), into a scratch database
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" postgres:18.6-bookworm sh -c '
    set -e; admin="$(cat /run/wirehub/database_admin_url)"
    maint="$(printf %s "$admin" | sed -E "s#(postgres(ql)?://[^/]+)/[^?]*#\1/postgres#")"
    target="$(printf %s "$admin" | sed -E "s#(postgres(ql)?://[^/]+)/[^?]*#\1/smoke_restore#")"
    pg_dump -Fc -d "$(cat /run/wirehub/database_ro_url)" -f /tmp/smoke.dump
    psql -d "$maint" -XAtq -c "CREATE DATABASE smoke_restore TEMPLATE template0"
    pg_restore -d "$target" --no-owner --no-acl --exit-on-error /tmp/smoke.dump
    echo "restored: $(psql -d "$target" -XAt -c "select count(*) from studio.job_run") jobs, $(psql -d "$target" -XAt -c "select count(*) from pgboss.job") queue rows"
    psql -d "$maint" -XAtq -c "DROP DATABASE smoke_restore WITH (FORCE)"' > "$scratch/restore.out" 2>&1 || fail "dump and restore: $(cat "$scratch/restore.out")"
  echo "smoke: a dump as studio_ro restores into a scratch database ($(grep restored: "$scratch/restore.out"))"
  # S6: memory, against the caps
  local worker_peak worker_now app_now
  worker_peak="$(compose exec -T worker cat /sys/fs/cgroup/memory.peak 2>/dev/null | mib || true)"
  worker_now="$(compose exec -T worker cat /sys/fs/cgroup/memory.current | mib)"
  app_now="$(compose exec -T wirehub cat /sys/fs/cgroup/memory.current | mib)"
  echo "smoke: memory — worker ${worker_now} MiB now, peak ${worker_peak:-?} MiB (cap 1536); app ${app_now} MiB (cap 768)"
  [ "${worker_peak:-0}" -lt 1536 ] || fail "the worker's peak reached its cap"
  wait_for "$origin/healthz" 10 || fail "the app stopped answering after the jobs"
  [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$(compose ps -q wirehub)")" = "true 0" ] || fail "the app restarted"
  echo "smoke: the app stays healthy"
}

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
  curl -fsS -X POST -H 'content-type: application/json' -H "origin: $origin" -d "$form,\"code\":\"$code\"}" "$origin/api/setup" | contains '"created"' || fail "/setup did not create the organisation"
  echo "smoke: /setup refused no code; with the code created the organisation, the starter catalog and the admin (modules: $modules)"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/designs")" = 401 ] || fail "after setup, a request without a session was not refused"
  rm -f "$jar"
  curl -fsS -c "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" -d "{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" "$origin/api/auth/sign-in/email" -o /dev/null || fail "the admin could not sign in"
  curl -fsS -b "$jar" "$origin/api/designs" | contains 'de9-crossover' || fail "the signed-in admin does not see the starter catalog"
  echo "smoke: the admin signs in and sees the starter catalog"
  local etag design
  etag="$(curl -fsS -b "$jar" -D - -o "$scratch/design.json" "$origin/api/designs/dc-y-splitter" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
  design="$(sed 's/"label": *"[^"]*"/"label":"Saved by the smoke test"/' "$scratch/design.json")"
  curl -fsS -b "$jar" -X PUT -H 'content-type: application/json' -H "origin: $origin" -H "if-match: $etag" -d "$design" "$origin/api/designs/dc-y-splitter" -o /dev/null || fail "the admin could not save a design"
  curl -fsS -b "$jar" "$origin/api/backup" | contains '"state": "database"' || fail "the indicator does not say the database holds the saves"
  echo "smoke: a design save lands; the indicator says Saved (the database)"
  local photo
  etag="$(curl -fsS -b "$jar" -D - -o /dev/null "$origin/api/drawings/dc-y-splitter" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
  photo="data:image/png;base64,$(printf 'wirehub smoke %s' "$$" | base64)"
  curl -fsS -b "$jar" -X PUT -H 'content-type: application/json' -H "origin: $origin" -H "if-match: $etag" -d "{\"photo\":\"$photo\"}" "$origin/api/drawings/dc-y-splitter/photo" >/dev/null || fail "photo upload"
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" --entrypoint sh rclone/rclone:1.75.1 -c \
    'RCLONE_CONFIG_G_TYPE=s3 RCLONE_CONFIG_G_PROVIDER=Other RCLONE_CONFIG_G_ENDPOINT=http://garage:3900 RCLONE_CONFIG_G_REGION=garage RCLONE_CONFIG_G_FORCE_PATH_STYLE=true RCLONE_CONFIG_G_ACCESS_KEY_ID=$(cat /run/wirehub/s3_backup_access_key_id) RCLONE_CONFIG_G_SECRET_ACCESS_KEY=$(cat /run/wirehub/s3_backup_secret_access_key) rclone ls g:wirehub 2>/dev/null' \
    | contains '/sha256/' || fail "the upload is not in the Garage bucket"
  echo "smoke: an uploaded photo is in the Garage bucket (keys created by Garage)"
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" postgres:18.6-bookworm \
    sh -c 'psql "$(cat /run/wirehub/database_url)" -tAc "select studio.org_count()"' | contains '^1$' || fail "Postgres did not take the generated password"
  echo "smoke: Postgres is up; studio_app connects with its generated password"
  check_worker "$origin"
  if [ "$modules" = "[]" ]; then
    # S8: the database's export is the starter catalog plus exactly the save (and the setup record)
    cli export --out /tmp/smoke-export >/dev/null || fail "pg:export"
    local diff expected
    diff="$(compose exec -T wirehub sh -c 'diff -rq /tmp/smoke-export/data /app/starter-catalog' | sort || true)"
    expected="$(printf '%s\n' \
      'Files /tmp/smoke-export/data/designs/dc-y-splitter.json and /app/starter-catalog/designs/dc-y-splitter.json differ' \
      'Only in /tmp/smoke-export/data/drawings: dc-y-splitter.photo-ref.json' \
      'Only in /tmp/smoke-export/data: assets' \
      'Only in /tmp/smoke-export/data: models.json' \
      'Only in /tmp/smoke-export/data: setup.json' | sort)"
    [ "$diff" = "$expected" ] || fail "the export is not the starter plus the save: $diff"
    echo "smoke: the export is the starter catalog plus the save, the photo, the model link and the setup record — nothing else"
  fi
}

if [ "$upgrade" = 1 ]; then
  echo "smoke: --upgrade — a file-backend hub first (WIREHUB_BACKEND=files, sign-in off)"
  origin="http://127.0.0.1:$port"
  WIREHUB_BACKEND=files WIREHUB_ALLOW_FILES_IN_PROD=1 AUTH_ENABLED=false compose up -d --quiet-pull >/dev/null 2>&1 || fail "the file-backend stack did not start"
  wait_for "$origin/healthz" 180 || fail "the file-backend app did not answer"
  code=""
  for _ in $(seq 1 30); do
    code="$(compose logs --no-log-prefix wirehub | grep -oE '^ +[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' | tail -1 | tr -d ' ' || true)"
    [ -n "$code" ] && break
    sleep 1
  done
  curl -fsS -X POST -H 'content-type: application/json' -H "origin: $origin" -d "{\"modules\":[\"networking\"],\"code\":\"$code\"}" "$origin/api/setup" >/dev/null || fail "file-backend setup"
  etag="$(curl -fsS -D - -o "$scratch/design.json" "$origin/api/designs/de9-crossover" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
  curl -fsS -X PUT -H 'content-type: application/json' -H "origin: $origin" -H "if-match: $etag" -d "$(sed 's/"label": *"[^"]*"/"label":"Edited on the file backend"/' "$scratch/design.json")" "$origin/api/designs/de9-crossover" >/dev/null || fail "file-backend save"
  echo "smoke: the file-backend hub is set up (networking) and has a save"
  compose up -d --quiet-pull >/dev/null 2>&1 || fail "the upgraded stack did not start"
  log_has migrate 'adopt: imported' || fail "migrate did not move the file catalog into the database"
  echo "smoke: $(compose logs --no-log-prefix migrate | grep 'adopt:' | tail -1)"
  wait_for "$origin/healthz" 180 || fail "the upgraded app did not answer"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/designs")" = 503 ] || fail "an unclaimed hub answered other than 503"
  curl -fsS "$origin/api/setup" | contains '"claim": true' || fail "/setup does not offer to make the first admin"
  claim="{\"admin\":{\"name\":\"Smoke Admin\",\"email\":\"$admin_email\",\"password\":\"$admin_password\"}"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $origin" -d "$claim}" "$origin/api/setup")" = 403 ] || fail "the claim without the code was not refused"
  curl -fsS -X POST -H 'content-type: application/json' -H "origin: $origin" -d "$claim,\"code\":\"$code\"}" "$origin/api/setup" >/dev/null || fail "the first admin's claim"
  rm -f "$jar"
  curl -fsS -c "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" -d "{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" "$origin/api/auth/sign-in/email" -o /dev/null || fail "the claimed admin could not sign in"
  curl -sS -b "$jar" "$origin/api/designs/de9-crossover" > "$scratch/moved.json" || true
  grep -q 'Edited on the file backend' "$scratch/moved.json" || fail "the save did not move into the database: $(head -c 300 "$scratch/moved.json")"
  curl -fsS -b "$jar" "$origin/api/designs/rj45-patch-t568b" -o /dev/null || fail "the networking pack did not move into the database"
  echo "smoke: the first admin claimed the hub with the setup code; the save and the pack moved into the database"
  compose down -v >/dev/null 2>&1
fi

check_stack '[]'
if [ "$backup" = 1 ]; then
  compose down -v >/dev/null 2>&1
  export COMPOSE_PROFILES=backup
  if [ "$old_config" = 1 ]; then
    # a hub configured before the hooks: Backrest's config volume already holds a plan with none
    export BACKUP_REPOSITORY_PASSWORD="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d " \n")"
    docker volume create --label "com.docker.compose.project=$project" --label com.docker.compose.volume=backrest_config "${project}_backrest_config" >/dev/null
    docker run --rm -i -v "${project}_backrest_config:/config" alpine sh -c 'cat > /config/config.json' <<EOF || fail "seeding the old Backrest config"
{"modno":3,"version":6,"instance":"wirehub","repos":[{"id":"wirehub","uri":"/repos/wirehub","password":"$BACKUP_REPOSITORY_PASSWORD","autoInitialize":true,"autoUnlock":true}],"plans":[{"id":"wirehub","repo":"wirehub","paths":["/sources"],"schedule":{"cron":"0 3 * * *","clock":"CLOCK_LOCAL"},"retention":{"policyTimeBucketed":{"daily":7,"weekly":4,"monthly":12}}}]}
EOF
  fi
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
    echo "$snapshots" | contains '"paths":\["/sources"\]' && break
    sleep 2
  done
  echo "$snapshots" | contains '"paths":\["/sources"\]' || fail "no snapshot of /sources"
  echo "smoke: Backrest took a snapshot of /sources (dump, bucket mirror, catalog, auth, packs)"
  # the post-snapshot hook touches the marker the app and the worker read (read-only mounts): the deep check and blob GC see the backup
  for _ in $(seq 1 30); do compose exec -T wirehub test -f /backup-marker/.last-snapshot 2>/dev/null && break; sleep 1; done
  compose exec -T wirehub test -f /backup-marker/.last-snapshot || fail "the Backrest hook did not touch the backup marker"
  compose exec -T worker test -f /backup-marker/.last-snapshot || fail "the worker does not see the backup marker"
  compose exec -T wirehub sh -c 'touch /backup-marker/x 2>/dev/null' && fail "the app can write the backup marker volume (it should be read-only)"
  curl -fsS "http://127.0.0.1:$port/healthz?deep=1" > "$scratch/deep.json" || fail "the deep health check failed after the snapshot: $(cat "$scratch/deep.json")"
  tr -d ' \n' < "$scratch/deep.json" | contains '"name":"backup","ok":true' || fail "the deep health check has no passing backup check: $(cat "$scratch/deep.json")"
  tr -d ' \n' < "$scratch/deep.json" | contains '"name":"jobs","ok":true' || fail "the deep health check has no passing jobs check: $(cat "$scratch/deep.json")"
  if [ "$old_config" = 1 ]; then
    compose logs --no-log-prefix backup-init | contains 'added the snapshot marker hooks' || fail "backup-init did not patch the old Backrest config: $(compose logs --no-log-prefix backup-init | tail -5)"
    echo "smoke: backup-init added the marker hooks to the pre-existing Backrest config"
  fi
  echo "smoke: the hook touched the backup marker (read-only in the app and the worker); /healthz?deep=1 passes its backup and jobs checks"

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
    curl -fsS -b "$jar" "$origin2/api/designs/dc-y-splitter" | contains 'Saved by the smoke test' || fail "the restored hub does not have the save"
    curl -fsS -b "$jar" "$origin2/api/drawings/dc-y-splitter" | contains 'data:image/png;base64' || fail "the restored hub does not serve the upload"
    echo "smoke: restore drill — $(grep -E 'restore: done|blob-restore: copied' "$scratch/restore.log" | tr '\n' ' ')"
    echo "smoke: on the second stack the first admin signs in, and finds the save and the upload"
  fi
fi
echo "smoke: passed"
