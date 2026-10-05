# Catalog store

Status: **design**, with these pieces built on both backends (files and Postgres): the pack
manifest (`wirehub-pack.json`, `PackManifest`), a read-only layer over a catalog
(`layeredCatalogSource`), install from a directory, an uploaded zip or JSON bundle, or an https
URL (`installPackLayer`, Library → Modules → Install pack…; first-run setup uses the same for the
bundled domain modules — `docs/modules.md`), per-record `license` / `provenance` / `derivedFrom`
fields, and the **pack lifecycle**: update with a record-level diff, disable, read-only marking
with fork to edit (§3), and the **signed store index** with store browsing in the Library (§4:
`scripts/store-index.mjs`, `WIREHUB_STORE_INDEXES`, Library → Browse store). Pack manifest
signatures, publisher keys, review status and yanking are still design. Tracked in beads.

A fresh WireHub has the starter catalog: a few dozen generic records (CC0-1.0). Real work needs
the connectors, stocks and parts of a domain — XLR and speakON for live audio, M12 and
PROFIBUS for a factory floor, the OBD-II connector for a vehicle harness. Every shop
re-entering the same public facts is wasted effort, and every shop re-entering them by hand
is a source of errors. The **catalog store** is a public index of **catalog packs**: signed,
versioned bundles of catalog records, each record optionally carrying its provenance and licence, that
a deployment installs and updates from the Library. The store lists packs published by their
authors, who are responsible for their content and licensing.

Packs are **data, never code**. A pack cannot add behaviour; that is what modules are for
(`docs/modules.md`). That is what makes it safe to install a pack at runtime from the UI,
which modules deliberately cannot do.

## 1. Domain packs

Packs are organised by domain, small enough to review, and may depend on one another
(a pack of PROFIBUS cables depends on the pack that defines the DE-9 bodies).

| Pack (id) | Contents | Main public sources |
| --- | --- | --- |
| `core-bodies` | connector bodies everyone uses: D-sub (DE-9 … DC-37, HD15), DIN / mini-DIN, RJ45/RJ11/RJ12, USB A/B/C/micro, barrel jacks, JST/Molex wire-to-board families, terminal blocks | IEC 60807, IEC 60130-9, IEC 60603-7, USB-IF connector specs, manufacturer drawings |
| `pro-audio` | XLR 3/4/5, TRS 6.35/3.5, TS, RCA, speakON, powerCON, EtherCON, AES/EBU and DMX512 pinouts, mic / instrument / multicore stocks — **bundled today** (`modules/pro-audio`: audio signals, XLR3, RCA and 3.5 mm TRS, mic and stereo stocks, two example cables) | AES14, AES3, ANSI E1.11 (DMX512-A), IEC 61076-2-103, vendor datasheets |
| `pc-serial` | RS-232 (DE-9 DTE/DCE), RS-485 on DE-9, USB 2.0 on Type-A, PC serial and USB example leads — **bundled today** (`modules/pc-serial`: serial and USB signals and pinouts, three example cables) | TIA-574, TIA-232, TIA-485-A, USB 2.0 Specification |
| `fieldbus` | RS-232, RS-422/485, PROFIBUS DP, CAN/CANopen (DE-9, M12), DeviceNet, Modbus RTU, M8/M12 A/B/D/X codings, matching shielded stocks and terminators | TIA-232, TIA-485, IEC 61158/61784, CiA 303-1, IEC 61076-2-101/-104 |
| `networking` | Ethernet MDI/MDI-X (T568A/B), PoE pairs, Cat 5e/6/6A U/UTP, F/UTP, S/FTP stocks, M12 X-coded — **bundled today** (`modules/networking`: MDI signals, RJ45 plugs wired T568A/T568B, a patch cable and a crossover) | IEEE 802.3, TIA-568, ISO/IEC 11801 |
| `av-video` | VGA, DVI, HDMI, DisplayPort, SCART, BNC/RGBHV, S-Video, component video, mini-coax stocks — **bundled today** (`modules/av-video`: video signals, VGA and SCART, a VGA cable) | VESA (DDC, DisplayPort), EN 50049 / IEC 60933 (SCART), published pinouts |
| `usb` | USB 2.0 / 3.x / Type-C cable assemblies and their stocks | USB-IF specifications |
| `automotive` | OBD-II (J1962) connector and pinout, common sealed connector families, automotive wire (FLRY, TXL/GXL) — **bundled today** (`modules/automotive`: bus signals and the OBD-II plug) | SAE J1962 / ISO 15031-3, ISO 6722, SAE J1128 |
| `power-dc` | barrel jacks (5.5 × 2.1 / 2.5), IEC 60320 C13/C14/C5/C7, Anderson Powerpole, XT60, DC stocks by gauge | IEC 60320, manufacturer datasheets, AWG tables (ASTM B258) |
| `test-measurement` | BNC/SMA/N-type RF connectors, banana plugs, coax stocks (RG-58, RG-174, RG-316) | MIL-STD-348, MIL-DTL-17, vendor datasheets |
| `kicad-3d` | links from catalog bodies to KiCad 3D models (no model files in the pack) | KiCad 3D library (see §5) |
| `vocab-*` | vocabulary extensions: signals and levels for a domain (`vocab-fieldbus`, `vocab-audio`) | the standards above |

Shops may publish their own packs (`vendor-…`, `community-…`); a manufacturer may publish
an official pack of its own parts.

## 2. Pack format

A pack is a directory (or a `.tar.gz` of one) laid out like `packages/catalog/data`, plus a
manifest:

```
fieldbus-1.4.0/
  wirehub-pack.json     manifest (below)
  CHANGELOG.md
  bodies.json  interfaces.json  connectors.json  wires.json  components.json
  mechanicals.json  kits.json  pcbas.json        (each optional)
  vocab/signals.json …                           (vocabulary additions)
  designs/*.json                                 (example designs, optional)
  depictions/<id>/…                              (artwork, optional: <id> a connector, body or wire id)
  art/connectors/<id>.json, art/body-layouts.json   (connector drawings and body layouts, optional; specs/drawing-language.md §7)
  wirehub-pack.sig      detached signature over the manifest
```

```jsonc
// wirehub-pack.json
{
  "format": 1,
  "id": "fieldbus",                       // kebab, globally unique in a store
  "name": "Fieldbus connectors and cables",
  "version": "1.4.0",                     // semver of the data
  "publisher": { "id": "wirehub", "name": "WireHub store" },
  "license": "CC-BY-4.0",                 // SPDX: the default for records that name none
  "catalogSchema": 4,                     // the CableDesign / record schema it targets
  "requires": { "wirehub": ">=1.0 <2", "packs": { "core-bodies": "^2.1.0" } },
  "idPrefix": "fb-",                      // optional: every record id starts with it
  "files": { "connectors.json": "sha256-…", "wires.json": "sha256-…" },
  "counts": { "connectors": 42, "wires": 9, "interfaces": 18 },
  "homepage": "https://…", "source": "https://…"   // where the pack is built from
}
```

### Records in a pack

Records are the same types the base already loads — a pack adds nothing the model does not
know. Each record keeps the mandatory `src`, and a pack record adds two optional fields:

```jsonc
{
  "id": "fb-m12-a-5-female",
  "label": "M12 A-coded 5-pin female, CANopen pinout",
  "body": "m12-a-5-female", "interface": "canopen-m12",
  "src": "CiA 303-1 pin assignment; IEC 61076-2-101 A-coding",
  "license": "CC-BY-4.0",                 // when it differs from the pack's
  "provenance": {
    "method": "transcribed",              // transcribed | derived | measured | generated | synthetic
    "sources": [{ "title": "CiA 303-1 v1.9", "url": "https://…", "retrieved": "2026-09-30" }],
    "reviewed": [{ "by": "publisher-id", "on": "2026-10-01" }]
  }
}
```

- **No shop part numbers.** Pack records carry manufacturer part numbers (`mpn`,
  `manufacturer`) where a record is a specific product, never a shop's internal number. A
  deployment assigns its own numbers through its `PartNumberScheme` when it adopts a
  record (the scheme's `suggest` proposes one).
- **Ids are stable.** A record id never changes meaning within a major version.
- **Inferred values say so** in `src`, as everywhere in the catalog.

### Versioning

Semver on the data:

- **patch** — corrections to values (a pin label, an outer diameter) that cannot break a
  design: no id removed, no pin removed, no signal meaning changed.
- **minor** — additions: new records, new optional fields, new vocabulary entries.
- **major** — anything that can break a design: a record removed or re-identified, a pin
  removed or renumbered, a signal re-assigned, a body changed under a connector.

Every release has a `CHANGELOG.md` entry, and the store keeps every published version
forever (a design built on 1.2.0 can always be re-validated against 1.2.0).

## 3. Installing and updating

Installed pack records are **read-only** in the deployment and marked with their origin
(`packs.json` names the pack and version per record id; the pack's files are a layer under the
catalog in the file backend). A shop that needs a change to a pack record **forks** it: the
Library makes a local copy with a new id and `derivedFrom: { pack, id, version }`, and designs
move to the copy only when someone chooses to.

**Implemented today.** First-run setup installs a pack as a **layer**:
`installPackLayer(catalogDir, packsDir, packDir)` (`packages/catalog/src/packs.ts`) checks the
pack against the catalog with the other installed packs under it — a record id already used
for something different is a conflict, and nothing is written — then copies it to
`<packsDir>/<id>/` and records it in `<packsDir>/packs.json` (pack, version, licence, the ids
it added). Installing the same version again is a no-op; another version replaces the layer.
The packs directory is `WIREHUB_PACKS_DIR`: the `packs` volume (`/data/packs`) in the
container, the gitignored `data/packs/` in a checkout — never the starter catalog. The live
catalog reads through `catalogWithPacksSource` (the catalog's own files first, then each
installed pack), and the file stores leave records a pack supplies unchanged out of the
catalog's own files (`localPartOf`): an edited pack record is stored locally and shadows the
pack's. Derived tag tables, which cover pack records too, are written beside the packs
(`<packsDir>/derived/`) once one is installed. `installPack(catalogDir, packDir)` still merges
a pack into a catalog directory (records appended, `packs.json` beside them) for a tool that
builds a catalog copy with a pack in it; `layeredCatalogSource([local, pack…])` reads a
catalog with packs over it without writing — what a module's tests use.

**Install** (Library → Browse store; built as described in §4, "As built"):

1. The studio fetches the store index (§4), verifies its signature, and lists packs with
   their licence, publisher, review status and size.
2. Choosing a pack resolves its `requires` (base version, other packs) and shows the plan:
   packs to install, records added, licences involved, id conflicts with local records.
3. The pack archive is downloaded, its manifest signature and every file hash verified.
4. The records are validated with `validateDb` against the deployment's catalog plus the
   pack. Any error stops the install; nothing is written.
5. The pack is written in one unit of work (a transaction in the database backend; one
   journaled write in the file backend), and the install is recorded (who, when, what).

**Update**: the same, plus a **diff preview** — records added, changed (field by field) and
removed — and the list of designs that use a changed or removed record, each re-validated
against the new version before anything is applied. A removed record still used by a design
is never deleted under it: the update **retires** it (kept in the catalog as a record of the
deployment's own, with its licence and `derivedFrom` noted; no longer the pack's). Updates
across a major version are never automatic. Rollback re-installs the previous version
through the same path.

**The lifecycle, as built** (`packages/catalog/src/pack-lifecycle.ts`, `apps/studio/server/packs.ts`,
the Library's Modules page). One handler serves both backends: it plans and applies on a catalog
directory, and the Postgres backend runs it over a scratch copy it commits as **one change set**
(the same way first-run setup does), so there is nothing backend-specific to keep in step.

- **Which pack a record came from.** `packs.json` (the install record, a file in the packs
  directory on files and a catalog document in the database) lists per pack the ids it added to
  each record file (`added`) and its version. That is the origin: no extra column was needed on
  Postgres, because packs are flattened into ordinary records there and `packs.json` is
  flattened with them. An identical record that was already in the catalog is not the pack's, and
  disabling leaves it.
- **Update with a diff.** `GET /api/packs/:id/update` compares the installed records with the
  version this build bundles, field by field (`added` / `changed` / `removed` / `unchanged`), and
  reports conflicts (a new record clashing with a different local one), references (a dropped
  record that a record outside the pack still uses, which blocks), new library or design errors
  after the change (only *new* ones block), a licence change and a major version. `POST` applies
  it as one swap of the pack layer (files) or one change set (Postgres); a major version needs
  `{ "acceptMajor": true }`. A downgrade goes through the same path. A dropped record that is
  still used is **retired**, not refused: it stays (in the catalog's own files, editable), the pack
  stops owning it, and the plan lists it under `retired`, with the records that use it under
  `references` (informational). Disabling a pack still refuses while something uses its records.
- **Disable.** `DELETE /api/packs/:id` removes the pack's records when nothing outside the pack
  references them (a record naming a pack id in a non-prose field: a connector's `body`, an
  interface's `bodies`, a design's instance `def`, a kit line, a vocabulary `deprecatedBy` …).
  Otherwise it refuses with 409 and lists every reference; nothing is removed.
- **Read-only and fork.** Records from a pack answer `PUT` and `DELETE` with 409 on the
  definition routes; the list carries `packs` (id → pack and version) and a single record the
  `X-WireHub-Pack` header. `POST /api/definitions/:kind/:id/fork` copies the record under a new
  id with `derivedFrom: { pack, id, version }`. The Library shows "From pack X 1.0.0 —
  read-only" and a **Fork to edit** action. A pack's vocabulary
  entries (`PATCH /api/vocab/:list/:entry`) and designs (`PUT`, rename and `DELETE` on
  `/api/designs/:id`) answer 409 the same way, pointing at an entry of your own or at
  `POST /api/designs/:id/duplicate`. The Library list marks such rows with a **Pack** flag, and
  `GET /api/me` carries the person's `role`: viewers do not see "Install pack…", update or disable.
- **Install pack… (from a file or URL).** `POST /api/packs/install` takes a zip of the pack
  directory, a JSON bundle (`{ "manifest": …, "files": { "connectors.json": […] } }`) or an
  https URL, verifies it as `scripts/verify-pack.mjs` does (manifest, `src` on every record, the
  library validates with it, no clashes), shows the same diff, and with `apply` installs it as
  one change set recorded with its id and version, so update and disable work on it. A pack that
  is installed already is updated through the same door. URLs are fetched by the server: https
  only, no credentials, public addresses only, redirects re-checked, 8 MB and 15 s limits.
  Administration only: no API token may write `/api/packs`.

**Offline / air-gapped**: a pack archive can be installed from a file (Library → Packs →
Install from file) with the same verification; a deployment may run its own mirror of the
index.

Packs a **module** ships (`CatalogPackContribution`) use the same format and the same
install path; a domain module's packs are installed at first-run setup when a person
picks the module (`docs/modules.md`).

**Licences are per pack and per record.** Packs are data, not code: the AGPL of WireHub
does not reach them (`MODULE-EXCEPTION.md` §3). A pack names its licence in its manifest
(SPDX), a record may name its own, and the install plan shows every licence involved, as
information. The starter catalog (`packages/catalog/data`) and the bundled packs are
CC0-1.0, each directory with a `LICENSE` file saying so; the catalog's code stays
AGPL-3.0-only. Third-party packs carry the licence their authors chose.

## 4. The store, trust and signing

- **The index** is a static JSON document (`index.json`) listing packs, versions, archive
  URLs, sizes, sha256 hashes and publisher ids, signed by the store key. It can be served
  from any static host or object store, and mirrored. No server-side logic is needed to run
  a store.
- **Signatures**: ed25519 detached signatures (minisign-compatible) over the index and over
  each pack manifest; the manifest pins every file by sha256, so one signature covers the
  pack. Publishers sign their own packs; the store signs the index that lists them.
- **Trust roots** are deployment configuration: by default the official store key; an
  administrator may add publisher keys (a manufacturer, the shop's own) or remove the
  default. A pack signed by an untrusted key, or unsigned, installs only from file and only
  by an administrator, with a warning recorded in the install log.
- **What a signature means**: that the pack is the one its publisher published, unmodified.
  It does not mean the data is right. Correctness is shown separately as a **review status**
  per pack and per record — `reviewed` (checked against the cited source by someone other
  than the transcriber), `community`, `generated` (machine-converted, e.g. from KiCad), or
  `synthetic`.
- **Generated packs are reproducible**: a pack built by a converter (KiCad library → bodies
  and model links) names the converter version and the pinned upstream commit in its
  manifest, so anyone can rebuild it and compare hashes.
- **Key rotation and revocation**: the index carries a list of revoked keys and yanked
  versions; a yanked version stays downloadable for re-validation but is never offered for
  install and is flagged on deployments that have it.

### As built (phase 3)

**The index.** `index.json` (`StoreIndex`, `packages/catalog/src/store-index.ts`):

```jsonc
{
  "format": 1,
  "store": { "id": "wirehub", "name": "WireHub bundled packs", "homepage": "https://…" },
  "generated": "2026-10-05T00:00:00Z",          // optional, as the builder said
  "packs": [
    {
      "id": "pro-audio", "name": "Pro audio", "description": "…",
      "domain": "pro-audio",                      // the manifest's `domain`, else its id
      "license": "CC0-1.0",                       // as the author states it: information
      "author": { "id": "wirehub", "name": "WireHub bundled modules" },  // `author`, else `publisher`
      "homepage": "https://…",
      "versions": [                               // newest first
        { "version": "0.1.0", "url": "pro-audio-0.1.0.zip",   // relative to the index, or absolute https
          "sha256": "…64 hex…", "size": 23456, "requires": { "wirehub": ">=0.1 <1" } }
      ]
    }
  ]
}
```

A bundle is what Install pack… takes: a zip of the pack directory or a JSON bundle.

**The signature** is `index.json.minisig` beside the index: a minisign signature (the prehashed
`ED` algorithm: ed25519 over the BLAKE2b-512 of the file, plus the global signature over the
trusted comment), so `minisign -Vm index.json -P <key>` verifies it too. The public key is
minisign's one-line form (`RW…`). The private key is a PKCS#8 PEM ed25519 key, and the key id is
the first 8 bytes of the public key's sha256, so the public key can always be printed from the
private one. Pack manifests are not signed yet: the index pins every bundle by sha256 and size,
and the index signature covers that.

**What a hub does** (`apps/studio/server/store.ts`). `WIREHUB_STORE_INDEXES` lists the indexes it
trusts, each `<https url> <public key>` (comma separated; `docs/self-hosting.md`).
`GET /api/packs/store` fetches each index and its `.minisig` (https only, public addresses, the
same limits as a pack URL), **refuses an index whose signature does not match the configured key**
(or that has none), and lists the packs of the others with the version installed here and what
can be done (`install`, `update`, `current`). `POST /api/packs/store/install`
`{ index, id, version?, apply?, sha256?, acceptMajor? }` re-fetches and re-verifies the index,
downloads the bundle it names, **refuses it unless its size and sha256 match the index** and its
manifest is the pack and version listed, then hands it to `POST /api/packs/install`: without
`apply` the record-level diff, with it one change set. Being under `/api/packs`, it is for owners
and editors; viewers see the list, and no API token may install. The Library's **Browse store**
page (`/library/store`) has search, a domain filter, the disclaimer, the licence as information,
and Install / Update buttons that show the diff before applying.

**Building and signing an index** (`scripts/store-index.mjs`, plain Node 24, no install):

```
node scripts/store-index.mjs keygen --out ~/wirehub-store-keys     # once; never inside a repository
node scripts/store-index.mjs bundle path/to/my-pack --out my-store/    # my-pack-1.2.0.zip (deterministic)
node scripts/store-index.mjs build my-store/ --store-id acme --store-name "Acme packs"
node scripts/store-index.mjs sign my-store/index.json --key ~/wirehub-store-keys/wirehub-store.key
node scripts/store-index.mjs verify my-store/index.json --pubkey ~/wirehub-store-keys/wirehub-store.pub
node scripts/store-index.mjs pubkey --key ~/wirehub-store-keys/wirehub-store.key   # prints RW…
```

`sign` and `pubkey` also read the key from `WIREHUB_STORE_SIGNING_KEY` (the PEM text). Without a
key `sign` says the index is left unsigned and exits 0 (`--required` makes it fail).

**Hosting your own index.** A store is static files: put the bundles, `index.json` and
`index.json.minisig` in one directory on any https host (GitHub Pages, an object store, a web
server), keep every version you published in it (the index lists what the directory holds, and a
design built on an old version can be re-validated against it), rebuild and re-sign after every
change, and give people the index URL and your public key for `WIREHUB_STORE_INDEXES`. Keep the
private key out of the repository (a CI secret, as below). A mirror copies the directory as is:
the signature still verifies. You are responsible for what your packs contain and the licence you
give them; WireHub does not review store content.

**The official index** of WireHub's bundled packs (`modules/*/pack`, not the example) is built by
the pages workflow (`.github/workflows/pages.yml`: `store-index.mjs official`) and published at
`https://formless63.github.io/wirehub/store/index.json`, signed in CI with the GitHub Actions secret
`WIREHUB_STORE_SIGNING_KEY` (the PEM text of the private key). Without the secret the workflow
publishes it unsigned and says so with a warning; hubs refuse it until it is signed. Its public key
is `OFFICIAL_STORE_PUBLIC_KEY` in `apps/studio/server/store.ts`, **still a placeholder (empty)**:
once the owner has created the key (`keygen`) and stored the secret, `store-index.mjs pubkey --key
<file>` prints the line to record there, after which hubs trust the official index by default and
the workflow fails if the secret's key and the recorded one differ.

Official index public key: *(placeholder, not yet created)*

## 5. Sources, licences and responsibility

Not legal advice. Two cases, kept apart.

**Packs published by third parties** (a shop, a manufacturer, a community maintainer) are
published by their authors, who are responsible for their content and for the licence they
choose. WireHub does not restrict, review or police how an author sources data, and the store
does not gatekeep on it. The per-record `license` and `provenance` fields (§2) are
**information** for the person installing a pack, shown in the install plan; WireHub does not
verify them. If you build a pack, check the terms of your sources; an official API or download is
often easier than scraping a page.

**The bundled modules and the starter catalog in this repository** are published as CC0-1.0, so
they contain only data the project can license that way: facts (pin assignments, contact counts,
dimensions) cited to their source, our own measurements and synthetic examples, written in our own
words, with no text, tables or figures copied from a standard or datasheet.

Some sources worth knowing about when you cite or link:

| Source | Notes |
| --- | --- |
| **KiCad libraries** (symbols, footprints, 3D models; gitlab.com/kicad/libraries) | CC BY-SA 4.0 with the KiCad libraries exception. A pack that *contains* KiCad-derived data (converted models, extracted geometry) carries that licence and attribution; a pack that **links** to the upstream file at a pinned commit with its sha256 (as the base's model import does) keeps its own licence simple. |
| **Standards** (TIA/EIA, IEC, ISO, IEEE, SAE, AES, ESTA, VESA, USB-IF) | Pin assignments and dimensions are facts, cited by number and clause. The documents' text and figures belong to their publishers. |
| **HDMI, DisplayPort** | Cite the public source you used and say when it is secondary. Product names are plain names, not logos. |
| **Manufacturer datasheets and catalogues** | Specifications are facts; a site's terms may say more about bulk use. Manufacturer CAD and 3D models are usually better linked than included. |
| **Distributor data** (Digi-Key, Mouser, Octopart APIs) | Their terms often cover a deployment's own lookups (a module) more readily than republishing. |
| **Wikipedia / Commons** | CC BY-SA text and per-file image licences; handy for cross-checking. |
| **Own measurements** | `method: "measured"`, with what was measured and how. |

Trademarks (USB, HDMI, product names) appear as plain nominative names.

## 6. Where it plugs into the base

- **Model**: records gain optional `license`, `provenance` and `derivedFrom` fields (added
  to the model types and validated by `validateDb`); `src` stays mandatory.
- **Catalog (file backend)**: `data/packs/<id>/` with its manifest; the loader merges pack
  records read-only under the local ones and refuses a local record that shadows a pack id
  without forking it.
- **Postgres backend** (`specs/postgres-backend.md`): pack records live in the same tables as
  ordinary records, and `packs.json` (a catalog document) says which pack and version each came
  from (`pack_id` / `pack_version` columns were considered and not needed); installs, updates
  and disables are one change set through the normal write path, so they are audited and
  versioned like any other change.
- **Modules**: `CatalogPackContribution` packs install at build time through the same
  verification.
- **UI**: Modules → Catalog packs (installed list, update with diff, disable, Install pack…),
  and in the Library a read-only chip and Fork to edit on a record that came from a pack, and
  Library → **Browse store** (the packs of the trusted store indexes, install and update with diff).

## 7. Phases

1. Model fields (`license`, `provenance`, `derivedFrom`; **done**) and the pack manifest type
   (done); a `pack verify` command (hashes, schema, `validateDb`; the skill's `verify-pack.mjs`
   covers the last two).
2. Loading of installed packs; install from file or URL; fork a record; update with a diff and
   disable (**done**, both backends).
3. The signed static index, store browsing and install/update with diff in the Library
   (**done**, both backends; the official index's public key awaits the owner's key).
4. First packs: `core-bodies`, `pro-audio`, `fieldbus`, `networking`, each reviewed against
   cited sources; the KiCad model-link pack built reproducibly.
5. Signed pack manifests, publisher keys, review status workflow, yanking and revocation.
