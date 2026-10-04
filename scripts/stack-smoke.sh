#!/usr/bin/env bash
# The no-terminal-user deploy test: an empty directory with nothing but
# compose.yaml, no .env, `docker compose up -d` — then checks what a person
# would: the secrets were generated, the app answers, the setup code is in
# its log, /setup takes it, an upload lands in the bucket, Postgres is up
# with the generated password. With --backup it runs again with
# COMPOSE_PROFILES=backup and takes a snapshot through Backrest. Everything it
# creates (containers, volumes, networks) is removed at the end.
#
#   bash scripts/stack-smoke.sh [--backup] [image]
#
# image: the WireHub image to run (default wirehub:smoke, e.g. built with
# docker build -f docker/app.Dockerfile -t wirehub:smoke .). Ports:
# SMOKE_PORT (5191) and SMOKE_BACKREST_PORT (5192) on 127.0.0.1.
set -euo pipefail
backup=0
if [ "${1:-}" = "--backup" ]; then backup=1; shift; fi
image="${1:-wirehub:smoke}"
port="${SMOKE_PORT:-5191}"
backrest_port="${SMOKE_BACKREST_PORT:-9192}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/wirehub-smoke.XXXXXX")"
project="wirehub-smoke-$$"
cp -f "$repo/compose.yaml" "$work/compose.yaml"
cd "$work"
export WIREHUB_IMAGE="$image" WIREHUB_PORT="$port" BACKREST_PORT="$backrest_port"
compose() { docker compose -p "$project" "$@"; }
cleanup() {
  COMPOSE_PROFILES=backup compose down -v --remove-orphans >/dev/null 2>&1 || true
  cd / && rm -rf "$work"
}
trap cleanup EXIT
fail() {
  echo "smoke: FAILED — $*" >&2
  COMPOSE_PROFILES=backup compose ps -a >&2 || true
  COMPOSE_PROFILES=backup compose logs --tail 40 >&2 || true
  exit 1
}
wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}

check_stack() {
  echo "smoke: $(ls -A | tr '\n' ' ')— no .env; up -d${COMPOSE_PROFILES:+ with COMPOSE_PROFILES=$COMPOSE_PROFILES}"
  compose up -d --quiet-pull >/dev/null 2>&1 || fail "docker compose up"
  wait_for "http://127.0.0.1:$port/healthz" 120 || fail "the app did not answer on port $port"
  echo "smoke: app answers /healthz"
  compose logs --no-log-prefix bootstrap | grep -q 'postgres_password: \(generated\|kept\)' || fail "bootstrap did not fill the secrets volume"
  echo "smoke: $(compose logs --no-log-prefix bootstrap | tail -2 | head -1)"
  local code=""
  for _ in $(seq 1 30); do
    code="$(compose logs --no-log-prefix wirehub | grep -oE '^ +[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' | tail -1 | tr -d ' ' || true)"
    [ -n "$code" ] && break
    sleep 1
  done
  [ -n "$code" ] || fail "no setup code in the wirehub log"
  echo "smoke: setup code in the log ($code)"
  local origin="http://127.0.0.1:$port"
  local refused
  refused="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $origin" -d '{"modules":[]}' "$origin/api/setup")"
  [ "$refused" = 403 ] || fail "/api/setup without the code answered $refused, not 403"
  curl -fsS -X POST -H 'content-type: application/json' -H "origin: $origin" -d "{\"modules\":[\"pc-serial\"],\"code\":\"$code\"}" "$origin/api/setup" | grep -q '"needed": false' || fail "/setup did not take the code"
  echo "smoke: /setup refused no code, took the code, installed pc-serial"
  compose exec -T wirehub test -f /data/packs/pc-serial/wirehub-pack.json || fail "the pack is not in /data/packs"
  local etag photo
  etag="$(curl -fsS -D - -o /dev/null "$origin/api/drawings/db9-null-modem" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
  photo="data:image/png;base64,$(printf 'wirehub smoke %s' "$$" | base64)"
  curl -fsS -X PUT -H 'content-type: application/json' -H "origin: $origin" -H "if-match: $etag" -d "{\"photo\":\"$photo\"}" "$origin/api/drawings/db9-null-modem/photo" >/dev/null || fail "photo upload"
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" --entrypoint sh rclone/rclone:1.75.1 -c \
    'RCLONE_CONFIG_G_TYPE=s3 RCLONE_CONFIG_G_PROVIDER=Other RCLONE_CONFIG_G_ENDPOINT=http://garage:3900 RCLONE_CONFIG_G_REGION=garage RCLONE_CONFIG_G_FORCE_PATH_STYLE=true RCLONE_CONFIG_G_ACCESS_KEY_ID=$(cat /run/wirehub/s3_backup_access_key_id) RCLONE_CONFIG_G_SECRET_ACCESS_KEY=$(cat /run/wirehub/s3_backup_secret_access_key) rclone ls g:wirehub 2>/dev/null' \
    | grep -q 'assets/.*\.png' || fail "the upload is not in the Garage bucket"
  echo "smoke: an uploaded photo is in the Garage bucket (keys created by Garage)"
  docker run --rm --network "${project}_internal" -v "${project}_secrets:/run/wirehub:ro" postgres:18.6-bookworm \
    sh -c 'psql "$(cat /run/wirehub/database_url)" -tAc "select 1"' | grep -q '^1$' || fail "Postgres did not take the generated password"
  echo "smoke: Postgres is up with the generated password"
}

check_stack
if [ "$backup" = 1 ]; then
  compose down -v >/dev/null 2>&1
  export COMPOSE_PROFILES=backup
  check_stack
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
fi
echo "smoke: passed"
