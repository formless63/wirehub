#!/usr/bin/env bash
# The terminal alternative to letting the stack generate its own secrets:
# writes .env from .env.example (beside compose.yaml) with every bootstrap
# secret filled in, for people who want them in a file they keep — a password
# manager, a re-deploy onto fresh volumes. Not needed otherwise: with no .env,
# the bootstrap service generates the same secrets into the `secrets` volume.
#
#   bash setup-env.sh [--force] [dir]     # dir: where compose.yaml is (default: .)
#
# Works from a downloaded copy as well as a checkout. Never overwrites an
# existing .env unless --force; the file is created readable by you only.
set -euo pipefail
force=0
if [ "${1:-}" = "--force" ]; then force=1; shift; fi
dir="${1:-.}"
cd "$dir"
if [ ! -f .env.example ]; then
  echo "No .env.example here; download it beside compose.yaml first:" >&2
  echo "  curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/.env.example" >&2
  exit 1
fi
if [ -e .env ] && [ "$force" != 1 ]; then
  echo ".env exists; leaving it alone (pass --force to replace it)." >&2
  exit 1
fi
hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }
code() {
  local alphabet=ABCDEFGHJKMNPQRSTUVWXYZ23456789 out='' i byte
  for i in $(seq 1 12); do
    byte=$(od -An -tu1 -N1 /dev/urandom | tr -d ' ')
    while [ "$byte" -ge 248 ]; do byte=$(od -An -tu1 -N1 /dev/urandom | tr -d ' '); done
    out+="${alphabet:$((byte % 31)):1}"
    if [ "$i" = 4 ] || [ "$i" = 8 ]; then out+='-'; fi
  done
  printf '%s' "$out"
}
declare -A value=(
  [POSTGRES_PASSWORD]="$(hex 24)"
  [WIREHUB_OWNER_PASSWORD]="$(hex 24)"
  [WIREHUB_APP_PASSWORD]="$(hex 24)"
  [WIREHUB_RO_PASSWORD]="$(hex 24)"
  [BETTER_AUTH_SECRET]="$(b64 32)"
  [GARAGE_RPC_SECRET]="$(hex 32)"
  [GARAGE_ADMIN_TOKEN]="$(b64 32)"
  [WIREHUB_SETUP_CODE]="$(code)"
)
umask 077
tmp="$(mktemp .env.XXXXXX)"
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^#\ ([A-Z0-9_]+)=$ ]] && [ -n "${value[${BASH_REMATCH[1]}]:-}" ]; then
    printf '%s=%s\n' "${BASH_REMATCH[1]}" "${value[${BASH_REMATCH[1]}]}"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > "$tmp"
mv -f "$tmp" .env
echo "Wrote .env with generated secrets (setup code: ${value[WIREHUB_SETUP_CODE]}). Next: docker compose up -d"
