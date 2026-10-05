#!/usr/bin/env bash
# Build, sign and verify a WireHub module store (docs/store-hosting.md).
# Run by the build-store composite action next to it, and by the template test
# (apps/studio/test/store-template.server.test.ts), so both use the same commands.
#
# Input, all environment variables (relative paths are relative to the current directory):
#   STORE_PACKS_DIR   directory whose subdirectories are packs (each has wirehub-pack.json)   [packs]
#   STORE_META        store-meta.json: publishers, review status, yanked versions            [store-meta.json]
#   STORE_OUT         where the static site is written                                       [_site]
#   STORE_ID, STORE_NAME, STORE_HOMEPAGE, STORE_BASE_URL   the index's store entry; ID and NAME required
#   WIREHUB_STORE_SIGNING_KEY   PEM text of the store key (required)
#   WIREHUB_PACK_SIGNING_KEY    PEM text of the publisher key (optional: signs every pack)
# Needs Node 24 and the WireHub workspace installed (`pnpm install --filter studio...`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
tool=(node "$repo/scripts/store-index.mjs")
verify_pack=(node "$repo/.agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs")

packs_dir="${STORE_PACKS_DIR:-packs}"
meta="${STORE_META:-store-meta.json}"
out="${STORE_OUT:-_site}"
# a repository name is not always a kebab-case id
store_id="$(printf '%s' "${STORE_ID:-}" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//')"
store_name="${STORE_NAME:-}"
store_key="${WIREHUB_STORE_SIGNING_KEY:-}"
pack_key="${WIREHUB_PACK_SIGNING_KEY:-}"

fail() { echo "::error title=Store build::$*" >&2; echo "$*" >&2; exit 1; }

[ -n "$store_key" ] || fail "The store signing key is empty. Create the secret WIREHUB_STORE_SIGNING_KEY (the PEM text of wirehub-store.key) in Settings > Secrets and variables > Actions; see docs/store-hosting.md."
[ -n "$store_id" ] && [ -n "$store_name" ] || fail "STORE_ID and STORE_NAME are required."
[ -d "$packs_dir" ] || fail "The packs directory '$packs_dir' does not exist."

if [ -f "$meta" ] && grep -q 'REPLACE-WITH' "$meta"; then
  fail "$meta still has the placeholder publisher key. Put your publisher public key (RW...) there, or remove the publisher entry (and the publisher from the packs' manifests) to publish without pack signatures; see the README."
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf '%s\n' "$store_key" > "$work/store.key"
[ -z "$pack_key" ] || printf '%s\n' "$pack_key" > "$work/publisher.key"

# work on copies: signing rewrites the manifest and adds wirehub-pack.sig
mkdir "$work/packs"
count=0
for dir in "$packs_dir"/*/; do
  [ -f "$dir/wirehub-pack.json" ] || continue
  cp -R "${dir%/}" "$work/packs/$(basename "$dir")"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || fail "No pack found: '$packs_dir' needs subdirectories holding a wirehub-pack.json."

echo "== verify the packs ($count)"
for dir in "$work"/packs/*/; do
  "${verify_pack[@]}" "$dir"
done

if [ -n "$pack_key" ]; then
  echo "== sign the packs as their publisher"
  for dir in "$work"/packs/*/; do
    "${tool[@]}" sign-pack "$dir" --key "$work/publisher.key"
  done
else
  echo "== packs are not signed (no WIREHUB_PACK_SIGNING_KEY); the index signature still covers every bundle"
fi

echo "== bundle and index"
rm -rf "$out"
mkdir -p "$out"
for dir in "$work"/packs/*/; do
  "${tool[@]}" bundle "${dir%/}" --out "$out"
done
build=(build "$out" --store-id "$store_id" --store-name "$store_name")
[ -z "${STORE_HOMEPAGE:-}" ] || build+=(--homepage "$STORE_HOMEPAGE")
[ -z "${STORE_BASE_URL:-}" ] || build+=(--base-url "$STORE_BASE_URL")
[ ! -f "$meta" ] || build+=(--meta "$meta")
"${tool[@]}" "${build[@]}"

echo "== sign the index"
"${tool[@]}" sign "$out/index.json" --key "$work/store.key" --required
pub="$("${tool[@]}" pubkey --key "$work/store.key")"
printf 'untrusted comment: %s store public key\n%s\n' "$store_id" "$pub" > "$out/wirehub-store.pub"

echo "== verify the result"
"${tool[@]}" verify "$out/index.json" --pubkey "$out/wirehub-store.pub"
if [ -n "$pack_key" ]; then
  ppub="$("${tool[@]}" pubkey --key "$work/publisher.key")"
  for bundle in "$out"/*.zip; do
    "${tool[@]}" verify-pack-signature "$bundle" --pubkey "$ppub"
  done
  if [ -f "$meta" ] && ! grep -q "$ppub" "$meta"; then
    echo "::warning title=Publisher not listed::store-meta.json does not list the publisher key $ppub, so hubs install the signed packs on the index signature alone. Add it under \"publishers\"."
  fi
fi

# a human-readable page beside the index: the same browsable page the official store uses
# (site/src/store*.js), reading this store's own index.json, signature and public key
node "$repo/site/build.mjs" store-page "$out/index.html" --name "$store_name"

echo "store: $out ($(ls "$out"/*.zip | wc -l) bundle(s)); public key $pub"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "public-key=$pub"; echo "output-dir=$out"; } >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Store built"; echo; echo "Public key: \`$pub\`"; echo; echo "Give people the index URL and this key (Settings > Store sources)."; } >> "$GITHUB_STEP_SUMMARY"
fi
