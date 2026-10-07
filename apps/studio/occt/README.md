# Optional occurrence-aware STEP reader

The regular `occt-import-js` npm reader remains the default. This opt-in reader
preserves surface colors on placed/nested assembly occurrences and their exact
product/instance names. It uses OCCT's `XCAFPrs::CollectStyleSettings` in the root
coordinate frame, resolves inherited colors with specific face overrides, and
matches located topology. Conflicting assignments to the same located shape are
left unknown. No color or source identity is guessed from mesh order, presentation mesh
names or bounding boxes. Source labels come from the actual product/occurrence
references.

The patch is based on importer **0.0.23**, commit
`c2148e54b456b571238d35cac037d304053d64b2`, its OCCT submodule
`d2abb6d844231cb8f29be6894440874a4700e4a5`, and upstream's Emscripten **3.1.69**.
Source archives and the build container are pinned by SHA256 in `build.sh`.
The reader has no native runtime dependency: the resulting WASM runs on both
amd64 and arm64 under the existing memory-capped conversion child. Building uses
an amd64 Emscripten container (emulation is required on an arm64 builder), up to
four CPU cores and 5 GiB; allow substantial time for the full OCCT compilation.
The build directory retains objects for incremental rebuilds.

```sh
bash apps/studio/occt/build.sh /tmp/occt-styles-artifact /tmp/occt-styles-build
```

Use only an artifact whose `manifest.json` exactly equals
`supported-manifest.json`. The app additionally verifies both JavaScript and
WASM hashes before execution, rejects symlinked directories/files, bounds reads,
and supplies the verified WASM bytes directly to the factory. A different build
requires a separately reviewed profile; replacing a supported manifest changes
its cache recipe and must never be used to overwrite an earlier profile's keys.
Do not modify an artifact in place while a process is using it.

Mount the verified output directory **read-only** on every process that can
convert models (normally the worker, plus app/import tooling when applicable),
then set `WIREHUB_OCCT_STYLES_DIR` to that mount's absolute path. There is no
network lookup, download, or browser import of this artifact. Opted-in STEP/IGES,
assembly and multi-STL conversions refuse if the artifact is missing, unverified
or unsupported, including assemblies that otherwise tolerate missing component
files. Direct single-STL conversion and GLB pass-through keep their existing
format paths and need no reader artifact; the occurrence reader changes neither
format. Their explicit profile keys are still distinct from historical keys.

Explicitly request the `occurrence` profile when creating a source key:

```ts
sourceKey(files, triangleBudget, build, 'occurrence')
```

`buildLinkedModel` infers that exact profile from the key and forwards it to the
reader/painter. The suffix incorporates the supported artifact manifest, and is
always added when explicitly requested, including STEP embedded in a board file.
Source-only components are supported; an explicit opt-in also separates STL-only
keys, although the style reader does not change STL geometry. `identityKey`, old
geometry/legacy keys, and existing board-texture-2 keys keep their previous
recipes and readers. The default importer/upload behavior is unchanged. An
actual art edit retains an already selected occurrence profile; same-art pack
reconciliation never opts a link in. Do not rewrite signed packs or historical
revision links. To opt current records in, validate source hashes, build the new
key first, then change only the current model link through the normal guarded
unit of work.

For paired board art, source-identified `_soldermask` shell surfaces receive the
supplied top/bottom textures without deleting their geometry. Other products,
silkscreen and anonymous surfaces retain their source appearance. Painting
requires exactly one identified board body; ambiguous or split-color board
bodies retain source styles instead of borrowing another body's art/bounds.
Surface opacity/material transparency is not recovered by this first profile;
its reader preserves RGB styles and exact source labels.

## Regressions and source licenses

The build/regression inputs in `test/fixtures/step-styles/` are synthetic boxes,
repeated/nested instances, face overrides and named coating shells. Regenerate
with its `generate.py`; the build-only authoring dependency is
`cadquery-ocp==8.0.1.1.0` (OCCT LGPL-2.1 with its exception), not an application
runtime dependency. Fixture headers remove author, workstation and time values.

```sh
WIREHUB_OCCT_STYLES_DIR=/tmp/occt-styles-artifact \
  pnpm --filter studio exec vitest run --maxWorkers=2 \
  test/occurrence-reader.server.test.ts test/occurrence-styles.server.test.ts
```

Importer modifications are distributed as an LGPL-2.1 source patch. OCCT uses
LGPL-2.1 with `OCCT_LGPL_EXCEPTION.txt`. `build.sh` copies their license texts to
the output. When distributing the modified WASM, provide this patch, the pinned
source/build instructions and corresponding source archives to satisfy the
library licenses; the patch does not change the WireHub repository license.

Primary API references: [OCCT style collection](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/src/XCAFPrs/XCAFPrs.hxx),
[upstream importer](https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2).

Coating artwork requires the exact common source-product stem (`<stem>_PCB` and `<stem>_SolderMask`) and identical nonempty reader assembly ancestry. The ancestry records local OCAF label tags along parent occurrence references, excluding the leaf. Placed model instances prefix that reader-local context, so unrelated mask products and repeated assemblies retain their own appearance. Missing or conflicting identity refuses coating paint.
