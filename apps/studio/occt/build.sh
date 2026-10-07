#!/usr/bin/env bash
# Build the optional LGPL occurrence-aware reader, without native runtime dependencies.
set -euo pipefail
output=${1:?Usage: build.sh OUTPUT_DIRECTORY [BUILD_DIRECTORY]}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=${2:-$(mktemp -d)}
mkdir -p "$work" "$output"
work=$(cd -- "$work" && pwd)
output=$(cd -- "$output" && pwd)
importer=c2148e54b456b571238d35cac037d304053d64b2
occt=d2abb6d844231cb8f29be6894440874a4700e4a5
image=emscripten/emsdk@sha256:9d6522879357a363ada61862481cc12c5f772d5e9738b8addf95d38490cdc6ea
fetch() {
  local url=$1 file=$2 hash=$3
  if [[ ! -f "$file" ]]; then curl --fail --location --silent --show-error "$url" -o "$file"; fi
  printf '%s  %s\n' "$hash" "$file" | sha256sum --check --status
}
fetch "https://github.com/kovacsv/occt-import-js/archive/$importer.tar.gz" "$work/importer.tar.gz" 2bd3799b2ac56cbf3f0df6300a51c8890e137bd001462702b356f621e33ff192
fetch "https://github.com/Open-Cascade-SAS/OCCT/archive/$occt.tar.gz" "$work/occt.tar.gz" 2715d89a1bc44dfd34dab88f729c445ea93f6b57d6539b0c89614a80ae144a6c
stamp="$work/source-stamp"
recipe=$(printf '%s\n' "$importer" "$occt" "$(sha256sum "$root/occurrence-styles.patch" | cut -d' ' -f1)" | sha256sum | cut -d' ' -f1)
tree_hash() {
  (cd "$work/source" && find . -path ./build -prune -o -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -d' ' -f1
}
if [[ -f "$work/source/CMakeLists.txt" ]]; then
  [[ -f "$stamp" ]] || { printf 'Unstamped source directory; use a fresh build directory.\n' >&2; exit 1; }
  expected=$(printf '%s\n%s\n' "$recipe" "$(tree_hash)")
  [[ $(cat "$stamp") == "$expected" ]] || { printf 'Source/build recipe changed; use a fresh build directory.\n' >&2; exit 1; }
else
  mkdir -p "$work/source"
  tar -xzf "$work/importer.tar.gz" --strip-components=1 -C "$work/source"
  mkdir -p "$work/source/occt"
  tar -xzf "$work/occt.tar.gz" --strip-components=1 -C "$work/source/occt"
  (cd "$work/source" && patch --batch --forward -p1 < "$root/occurrence-styles.patch")
  printf '%s\n%s\n' "$recipe" "$(tree_hash)" > "$stamp"
fi
# A fixed container path removes host paths from compiler-generated output.
# Limit build competition on a shared machine; the WASM works on either CPU architecture.
docker run --rm --platform linux/amd64 --cpus=4 --memory=5g \
  --mount "type=bind,src=$work/source,dst=/src" "$image" bash -lc \
  'cd /src && emcmake cmake -S . -B build/wasm -DEMSCRIPTEN=1 -DCMAKE_BUILD_TYPE=Release && cmake --build build/wasm -j4'
cp -f "$work/source/build/wasm/Release/occt-import-js.js" "$output/occt-import-js.cjs"
cp -f "$work/source/build/wasm/Release/occt-import-js.wasm" "$output/occt-import-js.wasm"
cp -f "$work/source/LICENSE.md" "$output/LICENSE.occt-import-js.md"
cp -f "$work/source/occt/LICENSE_LGPL_21.txt" "$output/LICENSE.occt.txt"
cp -f "$work/source/occt/OCCT_LGPL_EXCEPTION.txt" "$output/OCCT_LGPL_EXCEPTION.txt"
node "$root/manifest.mjs" "$output" "$root/occurrence-styles.patch"
printf 'Built optional reader in %s. Compare manifest.json with the supported manifest before use.\n' "$output"
