#!/usr/bin/env bash
# Runtime code modules and Restart WireHub on the real stack (specs/runtime-modules.md):
# compose.yaml's defaults (Postgres, the worker, Garage), first-run setup, the admin
# signs in, installs the example module as a signed bundle by upload (pinning the
# publisher key, consenting), its route answers at once; then Restart WireHub from the
# API the Settings page calls: the app drains and exits with code 75, the worker hears
# it through the database and exits 75 too, `restart: unless-stopped` brings both back,
# the page's way of reconnecting (polling /api/system/boot for a new boot id) sees the
# new process, and the module is loaded again after the restart.
#
#   bash scripts/restart-smoke.sh [image]
#
# image: the WireHub image (default wirehub:smoke; docker build -f docker/app.Dockerfile -t wirehub:smoke .).
# Port on 127.0.0.1: RESTART_SMOKE_PORT (5560). Keys are made for the run and removed with it;
# everything it creates is removed at the end.
set -euo pipefail
image="${1:-wirehub:smoke}"
port="${RESTART_SMOKE_PORT:-5560}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/wirehub-restart.XXXXXX")"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/wirehub-restart-scratch.XXXXXX")"
project="wirehub-restart-$$"
cp -f "$repo/compose.yaml" "$work/compose.yaml"
cd "$work"
export WIREHUB_IMAGE="$image" WIREHUB_PORT="$port"
compose() { docker compose -p "$project" "$@"; }
cleanup() {
  docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  cd / && rm -rf "$work" "$scratch"
}
trap cleanup EXIT
fail() {
  echo "restart-smoke: FAILED — $*" >&2
  compose ps -a >&2 || true
  compose logs --tail 40 wirehub worker >&2 || true
  exit 1
}
contains() { local input; input="$(cat)"; grep -qE -- "$1" <<<"$input"; }
wait_for() { for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done; return 1; }
log_has() { for _ in $(seq 1 "${3:-60}"); do compose logs --no-log-prefix "$1" 2>/dev/null | contains "$2" && return 0; sleep 1; done; return 1; }
restarts() { docker inspect -f '{{.RestartCount}}' "$(compose ps -q "$1")"; }
origin="http://127.0.0.1:$port"
jar="$scratch/cookies"

echo "restart-smoke: up -d with $image on 127.0.0.1:$port"
compose up -d --quiet-pull >/dev/null 2>&1 || fail "docker compose up"
wait_for "$origin/healthz" 180 || fail "the app did not answer"
code=""
for _ in $(seq 1 30); do
  code="$(compose logs --no-log-prefix wirehub | grep -oE '^ +[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' | tail -1 | tr -d ' ' || true)"
  [ -n "$code" ] && break
  sleep 1
done
[ -n "$code" ] || fail "no setup code in the log"
email="owner@example.com"
password="restart-smoke owner password"
curl -fsS -X POST -H 'content-type: application/json' -H "origin: $origin" \
  -d "{\"org\":{\"name\":\"Restart Smoke\",\"slug\":\"restart-smoke\"},\"catalog\":\"starter\",\"modules\":[],\"admin\":{\"name\":\"Smoke Owner\",\"email\":\"$email\",\"password\":\"$password\"},\"code\":\"$code\"}" \
  "$origin/api/setup" | contains '"created"' || fail "first-run setup"
curl -fsS -c "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$origin/api/auth/sign-in/email" -o /dev/null || fail "the owner could not sign in"
log_has worker 'working .*import' || fail "the worker did not start after setup"
echo "restart-smoke: set up; the owner is signed in; the worker works"

# the example module, built and signed for this run (a throwaway publisher key)
node "$repo/scripts/store-index.mjs" publisher-keygen --out "$scratch/keys" --id smoke --name "Smoke publisher" > /dev/null
pub="$(node "$repo/scripts/store-index.mjs" pubkey --key "$scratch/keys/wirehub-publisher.key")"
(cd "$repo/apps/studio" && INIT_CWD="$PWD" node --experimental-strip-types --no-warnings scripts/wirehub-module.ts build ../../modules/example --out "$scratch/out" --key "$scratch/keys/wirehub-publisher.key" --publisher-id smoke --publisher-name "Smoke publisher" --zip) > /dev/null || fail "wirehub-module build"
printf '{"zip":"%s","trustKey":"%s","apply":true,"consent":{"code":"example@0.1.0"}}' "$(base64 -w0 "$scratch/out/example-0.1.0.zip")" "$pub" > "$scratch/install.json"
curl -sS -b "$jar" -X POST -H 'content-type: application/json' -H "origin: $origin" --data-binary @"$scratch/install.json" "$origin/api/packs/install" > "$scratch/install.out"
contains '"installed": *true' < "$scratch/install.out" || fail "the install: $(tr -d "\n" < "$scratch/install.out" | head -c 700)"
contains '"state": *"loaded"' < "$scratch/install.out" || fail "the module did not load: $(tr -d "\n" < "$scratch/install.out" | head -c 700)"
curl -fsS -b "$jar" "$origin/api/modules/example/status" | contains '"ok": *true' || fail "the module's route did not answer after the install"
echo "restart-smoke: the example module installed by upload runs at once (its route answers, no restart)"

boot="$(curl -fsS -b "$jar" "$origin/api/system/boot" | grep -oE '"bootId": *"[^"]+"' | grep -oE '[0-9a-f-]{36}')"
[ -n "$boot" ] || fail "no boot id"
app_before="$(restarts wirehub)"
worker_before="$(restarts worker)"
answer="$(curl -sS -b "$jar" -o "$scratch/restart.out" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $origin" -d '{}' "$origin/api/system/restart")"
[ "$answer" = 202 ] || fail "Restart WireHub answered $answer: $(cat "$scratch/restart.out")"
echo "restart-smoke: Restart WireHub answered 202; waiting for the app to come back (the page polls /api/system/boot)"
back=""
for _ in $(seq 1 120); do
  now="$(curl -fsS -b "$jar" "$origin/api/system/boot" 2>/dev/null | grep -oE '"bootId": *"[^"]+"' | grep -oE '[0-9a-f-]{36}' || true)"
  if [ -n "$now" ] && [ "$now" != "$boot" ]; then back="$now"; break; fi
  sleep 1
done
[ -n "$back" ] || fail "the app did not come back with a new boot id"
log_has wirehub 'exiting with code 75 \(restart requested, not a crash\)' 5 || fail "the app's log does not say it exited for a restart"
[ "$(restarts wirehub)" -gt "$app_before" ] || fail "the app container was not restarted by its policy"
docker inspect -f '{{.State.Running}}' "$(compose ps -q wirehub)" | contains true || fail "the app is not running"
echo "restart-smoke: the app drained, exited 75 (logged as a requested restart), its restart policy started it again (restarts $app_before -> $(restarts wirehub)); new boot id $back"
log_has worker 'exiting with code 75 \(restart requested, not a crash\)' 60 || fail "the worker did not exit for the restart"
for _ in $(seq 1 60); do [ "$(restarts worker)" -gt "$worker_before" ] && break; sleep 1; done
[ "$(restarts worker)" -gt "$worker_before" ] || fail "the worker container was not restarted"
log_has worker 'working .*import' 120 || fail "the worker did not start working again"
echo "restart-smoke: the worker heard it through the database, exited 75 and came back (restarts $worker_before -> $(restarts worker))"
curl -fsS -b "$jar" "$origin/api/code-modules" | contains '"state": *"loaded"' || fail "the module is not loaded after the restart"
curl -fsS -b "$jar" "$origin/api/modules/example/status" | contains '"ok": *true' || fail "the module's route does not answer after the restart"
# the stream stays open: curl stops it after 3 s (exit 28), what it read is what counts
{ curl -sS -N -b "$jar" --max-time 3 "$origin/api/events" 2>/dev/null || true; } | contains 'event: *hello' || fail "the event stream does not reconnect"
echo "restart-smoke: the page reconnects (boot id, event stream), the session holds, and the module runs in the new process"
echo "restart-smoke: passed"
