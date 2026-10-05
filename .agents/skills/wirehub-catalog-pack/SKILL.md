---
name: wirehub-catalog-pack
description: Build, version, verify and publish a WireHub catalog pack (a data-only bundle of catalog records for one domain, such as modules/av-video/pack) - wirehub-pack.json, layout, semver rules, licence and provenance, install through first-run /setup, testing alone and beside other packs, and publishing in a signed catalog store index (scripts/store-index.mjs). Load when creating or changing a pack, a domain module's data, or when asked how packs install or are shared.
---

# Building a catalog pack

A pack is **data, never code** (`docs/catalog-store.md`). It ships either inside a domain module
(`catalogPacks` in `defineModule`, installed at `/setup`) or, in future, from the catalog store.
Records themselves: `wirehub-catalog-data`. The module shell: `wirehub-module`. Notes on
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
  validation-rules.json                           declarative design rules, optional (below)
  bench-rules.json                                work instructions as data, optional (below)
  pcba-pads.json                                  pads per board terminal, optional (below)
```

Images under `depictions/` and `art/` (`svg png jpg jpeg webp`, lowercase extensions) ship with the
pack: an uploaded zip, a JSON bundle (an image's `files` value is its base64) and a store bundle all
carry them, at most 2 MiB each and 12 MiB in all; an SVG is stripped of scripts, handlers and
external references on install. `packs.json` records the images the pack owns, so an update
replaces or removes them and a disable deletes them (the catalog's own files are never touched).
`store-index.mjs bundle` includes them and refuses an image a studio would not install
(`docs/catalog-store.md` section 3).

Every `.json` file (except the manifest) is picked up by `packFiles`
(`packages/catalog/src/packs.ts`); a data file's path is its place in the catalog, so a pack's
`vocab/signals.json` extends the starter's list of that name. Files must be canonical JSON
(two-space indent, trailing newline; `packages/catalog/test/canonical-json.test.ts` checks every
bundled pack).

## Manifest: `wirehub-pack.json`

Required by `readPackManifest`: `format: 1`, a kebab-case `id`, `version` (semver of the data),
`license` (SPDX id; the default for the pack's records) and `name`. Used by bundled packs:
`publisher: { id, name }`, `catalogSchema: 4`, `requires: { wirehub: ">=0.1 <1" }` (and
`packs: { "<id>": "<range>" }` for dependencies), `description`, `counts`, `homepage`, `source`, and
`domain` (the field the store filters by; the id when absent). `files` (sha256 per file), a
`idPrefix`, and manifest signatures belong to later store phases and are not produced or checked
yet (a store index pins each bundle by sha256 instead) (`docs/catalog-store.md` sections 2 and 7). The manifest `id` should equal
the `id` of the module's `catalogPacks` entry, and `version`/`license` should match it too.

## Configuration in a pack: rules and a numbering scheme

A pack can carry configuration as data, not only records (`docs/catalog-store.md` section 2):

- **`validation-rules.json`**: an array of rule records (`docs/validation-rules.md`; each with `id`,
  `severity`, `each`, `where?`, `require`, `message`, `src`). It merges by id like a record file, runs
  inside `validateDb` / `validateDesign`, and an install that would add errors to the library is
  refused, so write a rule a design of the starter or your own example designs satisfies (or make it
  a `warning`). `verify-pack.mjs` reports a rule the language cannot use. A hub owner can switch a pack
  rule off or change it by saving a rule with the same id in Settings.
- **`bench-rules.json`**: an array of bench rule records (`docs/modules.md`, "Bench work instructions";
  each `{ id, phase, src, when?, steps: [{ text, src, tools?, checks?, images? }] }`). The catalog reads
  it at runtime, so the build sheet prints the steps at once, and a disable restores the generic ones.
  `verify-pack.mjs` reports a rule that cannot be printed.
- **`pcba-pads.json`**: `{ "src": "…", "boards": { "<board id>": { "src": "…", "terminals": { "GND": [{ "ref": "GND1", "side": "top" }] } } } }`.
  A pack owns the pads of the boards it lists; the install preview validates designs against them.
- **`partNumberScheme`** in `wirehub-pack.json`: a declarative numbering definition
  (`docs/part-numbers.md`) the pack **offers**. Installing never switches the hub's scheme: the install
  answer carries `offers.partNumberScheme`, Settings, Part numbers lists it, and an owner confirms the
  switch. Offer one only when the pack's records come with a convention that needs it; verification
  refuses a definition that cannot be used. The manifest is what a publisher signature covers.
- The pack carries **no shop part numbers** and no `part-numbers.json` of its own (the layered read
  would make it the hub's scheme silently).

## What a pack may contain

- **Reuse the base, add only your field's records.** The starter's DE-9 bodies, stocks,
  components, mechanicals and the terminal adapter board are there for every pack to use. An id
  that already exists with different content is an install **conflict**.
- **No shop part numbers** in pack records: leave `partNumber` out; `mpn` and `manufacturer` are
  fine for a specific product. A deployment numbers records when it adopts them.
- Every record keeps `src`; inferred values say so in it.
- Bundled packs say `synthetic example` in the `src` of example designs. A pack of real
  published cables cites the standard or datasheet.
- **Licence and provenance per record.** Every record may carry `license` (an SPDX expression),
  `provenance` (`{ method, sources: [{ title?, url?, retrieved? }], reviewed? }`) and `derivedFrom`
  (set by a fork, never by a pack author); the model defines them (`packages/model/src/provenance.ts`)
  and `validateDb` checks their shape. Bundled packs give every record `"license": "CC0-1.0"` and a
  `provenance` whose `method` (`transcribed`, `derived` for an inferred value, `synthetic`,
  `measured`, `generated`) and first source `title` come from the record's `src`; add a `url` and
  `retrieved` date when you cite a web page. `src` stays mandatory. A record under a different
  licence than the pack's may name its own `license`. The fields are information for whoever
  installs the pack; WireHub does not verify them.
- Pack data you contribute to this repository (a bundled module) is **CC0-1.0**, like the starter, so
  it holds only data the project can license that way. A pack you publish elsewhere carries the
  licence you choose.

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
the gitignored `data/packs/` in a checkout); the starter catalog is never written. Records from a pack are read-only in the app (fork to edit makes a local copy); a legacy local edit shadows the pack's (`localPartOf`). A hub owner can also install your pack without a module: Modules, Catalog packs, Install pack... takes a zip of the pack directory, a JSON bundle (`{ manifest, files }`) or an https URL, previews the diff and installs it recorded with its id and version, so later versions update through the same door and `DELETE /api/packs/<id>` disables it. Tag tables
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

## Publishing in the catalog store

The store (`docs/catalog-store.md` section 4) is a **signed static index**: `index.json` lists packs,
their versions, bundle URLs, sizes and sha256 hashes, and `index.json.minisig` beside it is a
minisign-compatible ed25519 signature. A hub trusts an index by URL and public key
(`WIREHUB_STORE_INDEXES`), refuses one whose signature does not match, refuses a bundle whose size or
sha256 differs from the index, and installs through the same lifecycle as Install pack... (diff, then
one change set; Library, Browse store). Built too: manifest, layered reading, install from a
directory, per-record provenance, update with a diff, disable, read-only marking with fork to edit,
and phase 5: the publisher's signature over the manifest (`wirehub-pack.sig`, the manifest pinning
every file by sha256 in `files`), publishers and their keys in the index, review status per version
(`unreviewed`, `reviewed`, `flagged`: information the index publisher sets, not a gate), yanked
versions and revoked keys (`docs/catalog-store.md`, "As built (phase 5)").

1. Keep the pack a standalone directory that passes `verify-pack.mjs` with the manifest fields
   above (give it a `domain`).
2. **Bundled in this repository** (a domain module; `wirehub-module`, `wirehub-contribute`): it ships
   with WireHub, is installed from `/setup`, and the pages workflow
   (`.github/workflows/pages.yml`) puts it in the official index (`store-index.mjs official`) signed
   with the `WIREHUB_STORE_SIGNING_KEY` secret. Bump its version as above.
3. **Your own store** (a shop, maker or community pack, never in this repository). The easy way is
   the **store template** (`templates/store/`, `docs/store-hosting.md`): a GitHub template repository
   whose workflow calls this repository's `.github/actions/build-store` action (verify, bundle,
   index, sign with secrets, publish on Pages; pin the action's ref to pin the tooling). Put each pack
   version in its own directory under `packs/` and keep the old ones. By hand, bundle, index,
   sign and host it yourself, keeping the private key out of every repository:

   ```
   node scripts/store-index.mjs keygen --out ~/wirehub-store-keys
   node scripts/store-index.mjs bundle path/to/pack --out my-store/
   node scripts/store-index.mjs build my-store/ --store-id my-store --store-name "My packs"
   node scripts/store-index.mjs sign my-store/index.json --key ~/wirehub-store-keys/wirehub-store.key
   node scripts/store-index.mjs verify my-store/index.json --pubkey ~/wirehub-store-keys/wirehub-store.pub
   ```

   Copy `~/wirehub-store-keys/wirehub-store.pub` (the public key, never the `.key`) into `my-store/` so a hub can offer "fetch key from the store". Serve `my-store/` over https, keep old bundles in it, re-run `build` and `sign` after each release, and
   publish the index URL and the `RW...` public key (`pubkey --key ...` prints it) for hubs to add to
   `WIREHUB_STORE_INDEXES`.

   **Sharing it.** Anyone with the owner or editor role adds a store in the app: Settings > Store sources,
   the index URL and the public key (paste the `RW...` line, or "fetch key from the store's
   `wirehub-store.pub`", which is trust on first use). The page shows the store's name, publishers, pack
   count and the key fingerprint; tell people the fingerprint through another channel
   (`node scripts/store-index.mjs pubkey --key ...` prints the key) so they can compare. A deployment
   can lock sources to `WIREHUB_STORE_INDEXES` (Settings > Integrations, or `WIREHUB_STORE_ALLOW_USER_SOURCES=false`).

   To sign the packs as their publisher (hubs then verify it on top of the index), name the publisher
   in the manifest (`"publisher": { "id", "name" }`), make a publisher key once, sign the pack after
   every change (before `bundle`, which refuses a pack changed since signing), and list the publisher
   in the store's metadata:

   ```
   node scripts/store-index.mjs publisher-keygen --out ~/my-publisher-keys --id my-shop --name "My shop"
   node scripts/store-index.mjs sign-pack path/to/pack --key ~/my-publisher-keys/wirehub-publisher.key
   node scripts/store-index.mjs verify-pack-signature path/to/pack --pubkey ~/my-publisher-keys/wirehub-publisher.pub
   node scripts/store-index.mjs publisher my-store/ --id my-shop --name "My shop" --pubkey RW...
   ```

   Review status, yanking and revocation are store metadata too (`review`, `yank`, `unyank`,
   `revoke`, all editing `my-store/store-meta.json`); run `build` and `sign` after each. Yank a
   broken version rather than deleting its bundle: designs built on it can still be re-validated.
4. A pack is organised by domain, named `<domain>` (a shop or maker may publish `vendor-...` or
   `community-...`), reproducible when generated (name the converter version and the pinned upstream
   commit in the manifest's `source`), and every cited source passes the notes in
   `wirehub-import-public-data`. The store lists packs published by their authors, who are responsible
   for their content and licensing; WireHub shows the licence and provenance as information and does
   not review them.
