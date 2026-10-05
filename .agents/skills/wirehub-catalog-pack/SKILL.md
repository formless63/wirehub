---
name: wirehub-catalog-pack
description: Build, version, verify and publish a WireHub catalog pack (a data-only bundle of catalog records for one domain, such as modules/av-video/pack) - wirehub-pack.json, layout, semver rules, licence and provenance, install through first-run /setup, testing alone and beside other packs, and the path toward the catalog store. Load when creating or changing a pack, a domain module's data, or when asked how packs install or are shared.
---

# Building a catalog pack

A pack is **data, never code** (`docs/catalog-store.md`). It ships either inside a domain module
(`catalogPacks` in `defineModule`, installed at `/setup`) or, in future, from the catalog store.
Records themselves: `wirehub-catalog-data`. The module shell: `wirehub-module`. Licence caveats for
anything copied from outside: `wirehub-import-public-data`.

## Layout

A pack directory is laid out like `packages/catalog/data/` plus a manifest. Copy
`modules/av-video/pack/` (a full one) or `modules/example/pack/` (the minimum).

```
pack/
  wirehub-pack.json                 manifest (required)
  LICENSE                           the data licence text (CC0-1.0 for bundled packs)
  bodies.json interfaces.json connectors.json wires.json components.json
  mechanicals.json kits.json pcbas.json          each optional
  vocab/signals.json vocab/levels.json ...        vocabulary additions
  designs/<id>.json                               example designs, optional
```

Every `.json` file (except the manifest) is picked up by `packFiles`
(`packages/catalog/src/packs.ts`); a data file's path is its place in the catalog, so a pack's
`vocab/signals.json` extends the starter's list of that name. Files must be canonical JSON
(two-space indent, trailing newline; `packages/catalog/test/canonical-json.test.ts` checks every
bundled pack).

## Manifest: `wirehub-pack.json`

Required by `readPackManifest`: `format: 1`, a kebab-case `id`, `version` (semver of the data),
`license` (SPDX id; the default for the pack's records) and `name`. Used by bundled packs:
`publisher: { id, name }`, `catalogSchema: 4`, `requires: { wirehub: ">=0.1 <1" }` (and
`packs: { "<id>": "<range>" }` for dependencies), `description`, `counts`, `homepage`, `source`.
`files` (sha256 per file), a `idPrefix`, and signatures belong to the store phases and are not
produced or checked yet (`docs/catalog-store.md` sections 2 and 7). The manifest `id` should equal
the `id` of the module's `catalogPacks` entry, and `version`/`license` should match it too.

## What a pack may contain

- **Reuse the base, add only your field's records.** The starter's DE-9 bodies, stocks,
  components, mechanicals and the terminal adapter board are there for every pack to use. An id
  that already exists with different content is an install **conflict**.
- **No shop part numbers** in pack records: leave `partNumber` out; `mpn` and `manufacturer` are
  fine for a specific product. A deployment numbers records when it adopts them.
- Every record keeps `src`; inferred values say so in it.
- Bundled packs say `synthetic example` in the `src` of example designs. A pack of real
  published cables cites the standard or datasheet.
- **Licence and provenance per record.** Today the pack-level `license` is what the install
  records (`packs.json`). The per-record `license`, `provenance` (`method`, `sources`, `reviewed`)
  and `derivedFrom` fields in `docs/catalog-store.md` section 2 are **design only**: the model
  does not define or validate them yet. Do not rely on them; put what the store will need
  (document title, revision, retrieval date) into `src` text now. A record under a different
  licence than the pack's does not belong in the pack until those fields exist; split it into a
  separate pack with its own `license`.
- Pack data you contribute to the repository is **CC0-1.0**, like the starter.

## Versioning (semver on the data)

- **patch**: corrections that cannot break a design (a label, an outer diameter): no id removed, no
  pin removed or renumbered, no signal meaning changed.
- **minor**: additions: records, optional fields, vocabulary entries.
- **major**: anything that can break a design: a record removed or re-identified, a pin removed
  or renumbered, a signal re-assigned, a body changed under a connector.
- Ids are stable within a major version; vocabulary entries are never removed (deprecate).
- Bump `version` in `wirehub-pack.json` **and** in the module's `catalogPacks` entry; installing the
  same version again is a no-op, a different version replaces the installed layer. The store wants
  a `CHANGELOG.md` entry per release (`docs/catalog-store.md` section 2); a pack in this repository
  is covered by the repository changelog (release-please, `CHANGELOG.md`).

## Install: how a pack reaches a hub

`/setup` (`apps/studio/server/setup.ts`) lists `registry.domains()`; the modules a person ticks have
their packs installed by `installPackLayer(catalogDir, packsDir, packDir)`: checked against the
starter plus the other installed packs, copied to `<packsDir>/<id>/`, recorded in
`<packsDir>/packs.json`. The packs directory is `WIREHUB_PACKS_DIR` (`/data/packs` in the container,
the gitignored `data/packs/` in a checkout); the starter catalog is never written. A catalog
record a person later edits is stored locally and shadows the pack's (`localPartOf`). Tag tables
for pack records are derived by the host, so a pack ships none. To try it in the app, start
`pnpm --filter studio dev`, open `/setup` and tick your module (it must be in
`apps/studio/modules.config.ts`).

## Test the pack

Quick check of any pack directory (reads the manifest, `src` on every record, `validateDb` and
`validateDesign` over the starter with the pack laid over it, install into a temporary copy):

```
node .agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs modules/<id>/pack
```

Pass more pack directories to install your pack **beside the others, in both orders**:

```
node .agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs modules/pro-audio/pack modules/av-video/pack
```

Then write the module's test as the bundled ones do (`modules/av-video/test/av-video.test.ts`
and `modules/pro-audio/test/pro-audio.test.ts`):

1. `readPackManifest(packDir)` matches the module's `catalogPacks` entry.
2. The base alone does not know your field (`db.vocab.signals` lacks your signals), so nothing
   domain-specific leaks into the starter.
3. With `layeredCatalogSource([fsCatalogSource(dataPath('')), fsCatalogSource(packDir)])`, `validateDb`
   and every design's `validateDesign` have no errors.
4. `installPack` into a temporary copy of `dataPath('')` has no `conflicts`, `plan.added` lists what
   you expect, and installing again returns `alreadyInstalled: true`.
5. The base's readers understand your words: `roleOfLabels` (`@wirehub/editor-react`),
   `signalFromLabel`, `readSignalWords` (`@wirehub/model`) with the pack and without it.

### Shared records between packs (the av-video / pro-audio precedent)

SCART carries audio, so `modules/av-video/pack/vocab/signals.json` contains **identical copies** of
the audio signal entries that `modules/pro-audio` defines, so it installs with or without
`pro-audio`. Identical content is skipped; different content under the same id is a conflict. The
rules:

- Copy a shared record byte for byte (same `id`, fields and order), never reworded.
- Test both directions: install A then B, and B then A, with no conflicts
  (`verify-pack.mjs <A> <B>` does both orders; see the test
  `installs into a copy of the starter catalog ... beside the AV / video pack` in
  `modules/pro-audio/test/pro-audio.test.ts`).
- When two packs would genuinely disagree about a record, the fix is a shared dependency
  (`requires.packs`, store design) or one pack taking the other's record by reference, never two
  different records with one id.

## Publishing toward the catalog store

The store (`docs/catalog-store.md`) is a **design** with the file-backend pieces of phases 1 and 2
built: manifest, layered reading, install from a directory. Not built: signing, the store index,
update with diff, `pack verify`, review status. What to do today:

1. Keep the pack a standalone directory that passes `verify-pack.mjs` with the manifest fields
   above, so it can be archived as `<id>-<version>/` later.
2. Submit it to this repository as a domain module (`wirehub-module`, `wirehub-contribute`), where
   it ships bundled and is installed from `/setup`.
3. A shop's own pack stays in the shop's module repository (`docs/modules.md`, "A private module in
   its own repository"), built against `@wirehub/catalog`, never in this repository.
4. For the store: a pack is organised by domain, named `<domain>` (a shop or maker may publish
   `vendor-...` or `community-...`), reproducible when generated (name the converter version and the
   pinned upstream commit in the manifest's `source`), and every cited source passes the
   licence rules in `wirehub-import-public-data`.
