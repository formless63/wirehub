#!/usr/bin/env bash
# Writes .env from .env.example, generating every secret marked GENERATED.
# Never overwrites an existing .env (pass --force to replace it). The file is
# created readable by you only.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0"/..)"
if [ -e .env ] && [ "${1:-}" != "--force" ]; then
  echo ".env exists; leaving it alone (scripts/setup-env.sh --force replaces it)." >&2
  exit 1
fi
hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }
declare -A value=(
  [S3_ACCESS_KEY_ID]="GK$(hex 12)"
  [S3_SECRET_ACCESS_KEY]="$(hex 32)"
  [S3_BACKUP_ACCESS_KEY_ID]="GK$(hex 12)"
  [S3_BACKUP_SECRET_ACCESS_KEY]="$(hex 32)"
  [GARAGE_RPC_SECRET]="$(hex 32)"
  [GARAGE_ADMIN_TOKEN]="$(b64 32)"
  [POSTGRES_PASSWORD]="$(hex 24)"
  [BETTER_AUTH_SECRET]="$(b64 32)"
)
umask 077
tmp="$(mktemp .env.XXXXXX)"
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^([A-Z0-9_]+)=[[:space:]]*#[[:space:]]*GENERATED ]]; then
    printf '%s=%s\n' "${BASH_REMATCH[1]}" "${value[${BASH_REMATCH[1]}]}"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > "$tmp"
mv -f "$tmp" .env
echo "Wrote .env with generated secrets. Next: docker compose up -d"
