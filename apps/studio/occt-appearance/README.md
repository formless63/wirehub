# Optional source-opacity reader

The `appearance` profile extends the separately supported `occurrence` RGB
reader with explicitly supplied OCCT surface RGBA. It preserves face overrides,
located occurrence opacity, exact source labels and all source triangles.
Alpha zero is transparent; missing alpha uses glTF's opaque default. The GLB
writer uses `BLEND` only for supplied alpha below one. It does not infer a metal,
plastic, polished finish, roughness or refractive index from an RGB color or name.
The pinned STEP reader supplies RGB and transparency, not visual PBR finishes;
its material table contains physical names/density, not those rendering values.
Existing uploaded GLBs continue to pass through with their original PBR materials.

This is a distinct, immutable recipe. The npm/default reader and the original
RGB artifact in `../occt` remain supported and unchanged. A new appearance key
includes this directory's supported manifest and `board-coating-2`. Each reader
has its own loader and WASM instance; configuring a new reader never changes the
reader inferred from an installed or historical key.

Build with the pinned importer/OCCT archives and Emscripten image:

```sh
bash apps/studio/occt-appearance/build.sh /tmp/occt-appearance /tmp/occt-appearance-build
```

The recipe uses importer 0.0.23 at `c2148e54b456b571238d35cac037d304053d64b2`,
OCCT `d2abb6d844231cb8f29be6894440874a4700e4a5` and Emscripten 3.1.69.
Allow substantial time for an initial OCCT compilation; incremental importer
builds reuse verified source objects. It uses at most four CPU cores and 5 GiB.
The build runs at a fixed `/src` path and rejects a reused source directory whose
recipe or source bytes changed. Compare the resulting manifest to
`supported-manifest.json` exactly. Preserve both source archives, this patch,
build/manifest scripts, instructions and all emitted LGPL/exception licenses
beside distributed artifacts as the corresponding source. No generated binary
is checked into this repository. WASM runs with the existing bounded child on
amd64 and arm64; building requires an amd64 Docker image or emulation.

Mount the artifact directory read-only on app and worker, with its absolute path
in `WIREHUB_OCCT_APPEARANCE_DIR`. Keep `WIREHUB_OCCT_STYLES_DIR` mounted separately
when older occurrence keys need rebuilding. There is no download or fallback.
The loader verifies fixed filenames, manifest and exact bounded JS/WASM bytes,
rejects symlinks, and executes only those verified bytes.

Set `WIREHUB_MODEL_PROFILE=appearance` to select it for future Library uploads and
board-file imports. The default is `exporter`; `occurrence` is also supported.
Unknown configuration refuses new uploads without affecting existing model
reads. Missing/unsupported artifacts refuse STEP and board-file uploads before
any link or source document is written. Existing GLB/STL format paths need no
STEP artifact; their supplied material bytes and geometry remain unchanged. Direct converter calls for single STL and GLB
keep their format paths; opted-in STEP/IGES, assemblies and multi-STL require the
artifact. Module importers may explicitly use `sourceKey(files,budget,build,
'appearance')` and forward `boardTextureProfile:'appearance'` to conversion.
Signed pack installation never silently rewrites its authored model links.

For existing current source links, `reprofileModelLink(link,'appearance')` retains
all source hashes, original budget and embedded/placed/assembly recipe. Resolve
and verify every source, then use `buildLinkedModel` to build and seed the new key
before acquiring a record lease and saving the current link with the ordinary
owner-authenticated unit of work. Recheck the previous link and served art before
commit. The helper performs no writes. Do not select candidates by STEP filename:
embedded board models and assembly recipes carry the same explicit profile.
Do not rewrite signed packs or historical revision links, alias old cache bytes
under new keys, or overwrite old keys with the new output.

Paired board art retains source coating geometry and alpha. Exact board/mask
product stems and assembly context must match. A single original board reader
mesh split into color groups can be painted when all groups share opacity;
differing opacity groups retain their source appearance and are not flattened
into one painted body. Unknown/unrelated masks keep their source appearance.
Transparency uses ordinary glTF blending; overlapping transparent surfaces can
still have the renderer's usual ordering limitations.

Synthetic fixtures are generated with build-only `cadquery-ocp==8.0.1.1.0` (MIT),
using the OCCT STEP writer; no native writer is a runtime dependency. Run:

```sh
WIREHUB_OCCT_APPEARANCE_DIR=/tmp/occt-appearance \
WIREHUB_OCCT_STYLES_DIR=/tmp/occt-styles \
pnpm --filter studio exec vitest run test/appearance-styles.server.test.ts --maxWorkers=2
```

The gate checks raw geometry and RGB against the old pinned reader, repeated
occurrence/face alpha, actual embedded GLB material values, and unchanged legacy
cold-build bytes. Pure configuration/manifest/profile tests run without artifacts.
