# Catalog store

Status: **design**, with these pieces built on both backends (files and Postgres): the pack
manifest (`wirehub-pack.json`, `PackManifest`), a read-only layer over a catalog
(`layeredCatalogSource`), install from a directory, an uploaded zip or JSON bundle, or an https
URL (`installPackLayer`, Library → Modules → Install pack…; first-run setup uses the same for the
bundled domain modules — `docs/modules.md`), per-record `license` / `provenance` / `derivedFrom`
fields, and the **pack lifecycle**: update with a record-level diff, disable, read-only marking
with fork to edit (§3), the **signed store index** with store browsing in the Library (§4:
`scripts/store-index.mjs`, `WIREHUB_STORE_INDEXES`, Library → Browse store), and **phase 5**:
signed pack manifests (`wirehub-pack.sig`), publisher keys in the index, review status per
version, yanked versions and revoked keys (§4, "As built (phase 5)"). Tracked in beads.

A fresh WireHub has the starter catalog: a few dozen generic records (CC0-1.0). Real work needs
the connectors, stocks and parts of a domain — XLR and speakON for live audio, M12 and
PROFIBUS for a factory floor, the OBD-II connector for a vehicle harness. Every shop
re-entering the same public facts is wasted effort, and every shop re-entering them by hand
is a source of errors. The **catalog store** is a public index of **catalog packs**: signed,
versioned bundles of catalog records, each record optionally carrying its provenance and licence, that
a deployment installs and updates from the Library. The store lists packs published by their
authors, who are responsible for their content and licensing.

A data pack is **data, never code**: it cannot add behaviour, which is what makes it safe for
owners and editors to install from the UI. Behaviour is what modules are for (`docs/modules.md`),
and a pack may also **carry a code module** (§2, "A pack with code"): then it is the owners' to
install, it must be signed by a publisher the hub trusts, and the owner consents to what the code
may do (`specs/runtime-modules.md`).

Open **Store** (`/library/store`) to browse modules and catalog packs from the stores this
hub trusts. Search by name or filter **Content type** to code modules or catalog packs.
**Configure stores** opens Settings → Stores (`/settings?section=stores`): check the index
URL and public-key fingerprint before trusting a new store. Adding a store does not install
anything. **Manage installed modules** opens Settings → Modules
(`/settings?section=modules`) for runtime module status, enable/disable and publisher keys.
Installed data packs and file/URL uploads remain on `/modules`.

A fresh deployment trusts the official signed index by default, unless its administrator
sets `WIREHUB_STORE_INDEXES` to an empty value, `none`, or another list. The modules built into
the image are already available; domain catalog data is installed only when selected at
setup. Optional runtime modules appear in the Store only after a publisher ships a signed
bundle in a configured index. Having a module package in the source repository does not
publish it or install it. The official Pages generator currently publishes the bundled
domain catalog packs; it does not automatically build optional runtime code bundles.
If a module is absent, check store availability and review filters, or obtain its signed
bundle from the publisher. The code badge describes the index's advertised version;
the downloaded install preview remains authoritative and asks for owner consent to run code.

Pack updates and disables also track drawing metadata, board build sidecars, and model links
in `packs.json` (`auxiliary`). Model ownership is per record key, so links from another pack or
the deployment remain. An untouched sidecar or link follows the pack; a locally edited one
stays and becomes the deployment's own. Older merged installs without auxiliary hashes are
left alone because their ownership cannot be established; layered installs can recover it
from the layer. Photo pointers and asset index entries retain their shared-asset lifecycle.
Additional auxiliary record lists are owned by id, tag objects by leaf key, and singleton
configuration documents by file hash. Local keys and edits win. Anonymous list members are
not assigned guessed ownership after a merged install.

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
  validation-rules.json                          (declarative design rules, optional; docs/validation-rules.md)
  bench-rules.json                               (the shop's work instructions as data, optional; docs/modules.md "Bench work instructions")
  pcba-pads.json                                 (pads per board terminal, optional; { src, boards: { <board id>: { src, terminals } } })
  depictions/<id>/…                              (artwork, optional: <id> a connector, body or wire id)
  art/connectors/<id>.json, art/body-layouts.json   (connector drawings and body layouts, optional; specs/drawing-language.md §7)
  drawing-art.json                               (traced faces, plugs and cutaways by definition id, optional; docs/modules.md "The hub's own identity")
  docs/**/*.pdf, assets/**/*.pdf                 (vendor datasheets, optional; linked from records by sha256)
  fonts/<name>.ttf|otf|woff2 + fonts/<name>.json (a licensed typeface and the licence it comes under, optional)
  wirehub-pack.sig      the publisher's signature over the manifest (§4, phase 5)
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
  "partNumberScheme": { "type": "declarative", "template": "…", "segments": [ … ] },   // optional: a numbering scheme the pack offers (docs/part-numbers.md)
  "files": { "connectors.json": "…64 hex…", "wires.json": "…64 hex…" },   // written by sign-pack (§4)
  "counts": { "connectors": 42, "wires": 9, "interfaces": 18 },
  "homepage": "https://…", "source": "https://…"   // where the pack is built from
}
```

### A pack with code

A pack may carry a **code module** (`specs/runtime-modules.md` §1): a `module` block in the manifest
(the module's id, version, label, the `apiVersion` of `@wirehub/modules` it was built against, its
entries, the extension points and permissions it declares) and its entries at
`code/<module id>/server.mjs`, `browser.mjs` and `browser.css`. They are pinned in `files` like
every other file, so the publisher's signature covers them; a code-only pack has no record files.
`pnpm --filter studio wirehub-module build <module package> --key …` writes such a pack.

- **Install** takes the same doors and the same diff as any pack, plus: owners only (never a
  token), the pack signed by a publisher the index lists (a store install) or by a key the owner
  pins (`trustKey` on an upload, or Settings > Code modules), an API this hub runs, and the owner's
  consent (`consent: { code: "<id>@<version>" }`) after the preview's `code` block. Anything else
  is refused, nothing written. `packs.json` records the module with the sha256 of its entries and
  how it was trusted.
- **Where the code lives**: in the pack's layer (files) or as catalog files in the blob store
  (Postgres), owned by the pack like its images: an update replaces them, removing the pack removes
  them and the module.
- **Index and store**: index format 1 optionally includes a per-version `module` summary
  (id, version, label, API version, extension points and permissions) copied from the manifest.
  Browse store marks the offered version as a **Code module** and shows its stated permissions.
  Older indexes remain valid; a missing summary does not prove a pack contains only data.
  The downloaded manifest and installation preview determine owner consent. The store template
  builds module packages under `modules/` into signed packs (`templates/store/README.md`).

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
- **A pack may carry configuration as data**, not only records. `validation-rules.json` is an array
  of rule records (each with `src`, merged by id like any record file): the rules install with the
  pack, run inside the validators, and an install that would add errors to the library is refused.
  `bench-rules.json` (the shop's work instructions, `docs/modules.md`) works the same way: read from the
  catalog at runtime, so the build sheet prints a pack's steps the moment it is installed and the generic
  steps return when it is disabled. `drawing-art.json` (faces, plugs and cutaways by definition id, the
  shape a module's `art.drawing` has) is kept key by key like the pad table, so a pack owns its art; a
  cutaway's SVG is stripped of scripts and external references on install. `pcba-pads.json` (the pads of a board's terminals) is kept board by
  board, so a pack owns the pads of its boards: an update replaces them, a disable removes them, and a
  board the catalog already has with different pads is a conflict. The install **preview** reads every
  such data file the way the installed catalog will (the pad table, rules, bench rules, drawing art, tag tables), so
  the errors it shows are the errors the library will have afterwards, not a different set.
  The manifest's `partNumberScheme` is a numbering scheme the pack **offers**: installing the pack
  never switches the hub's scheme; Settings lists the offer and an owner confirms the switch
  (`docs/part-numbers.md`). The manifest is covered by the publisher's signature, so a signed pack's
  scheme is too.
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
The file backend's stores read every kind of file through those layers, so a hub shows what a
pack supplies exactly as the Postgres backend does (the S1 gate's `api-parity-file-stores`):
records, designs, builds, drawing sidecars, versions, model links, the shared asset index, the
wire library (`wire-parts.json`, `wire-recipes.json`, `strip-practice.json`), the tag review, the
part-number configuration and the depictions with their reviewed board maps. A write goes to the
catalog's own file only, and keeps a pack's unchanged records in the pack.

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
  **Preview, files and Postgres agree.** A pack that previews as applicable applies on both
  backends, and `adopt` / `pg:import` take what the API installed. The preview runs the database
  codec over the catalog with the pack in it and lists what it would refuse in `problems`
  (`applicable: false`; applying answers 422). Documents are installed in canonical JSON
  (`JSON.stringify(v, null, 2) + "\n"`; `models.json` links and `assets/index.json` entries in the
  store's order) whatever form they were shipped in. `src` is asked of every record, of a board's
  builds (each build) and of documents; not of a drawing's sidecars (`drawings/<id>.json`, the photo
  pointer `drawings/<id>.photo-ref.json` = exactly `{ "assetId" }`) nor of saved versions
  (`designs/_versions/…`). `models.json` links are keyed `<kind>/<id>` of the eight Library kinds, or
  `revisions/<part>/<revision>` for the model of a part revision no record shows (`<part>` is a record id or a part
  number such as `ABC-123456-00`, upper case allowed; `GET /api/models/revisions/<part>/<rev>` answers for either
  spelling of the same record). When `adopt` or
  `pg:import` still refuses a file (a pack installed by an earlier version, say), the error names the
  file and whether it came from the catalog or from which pack.
  **Vendor PDFs and fonts travel with the pack too.** A PDF under `docs/**` or `assets/**` (a
  datasheet; `.pdf`, lowercase) and a font under `fonts/**` (`.ttf`, `.otf`, `.woff2`) are kept like
  images: pinned by the manifest's `files` and covered by the signature, owned by the pack in
  `packs.json` (an update replaces or removes them, a disable deletes them), installed beside the
  catalog's data (`data/docs/…`, `data/fonts/…`; a pack's `assets/…` goes to `data/pack-assets/…`
  because `data/assets/` is the shared library, named by hash) and served by content address from
  `GET /api/blobs/<sha256>`. A PDF is at most 4 MiB (6 MiB for a pack's PDFs together), starts with
  `%PDF-` and is refused if it holds a script, launch action, embedded file, rich media or form
  submission (a best-effort scan: it is served as an attachment regardless). A font is at most
  2 MiB (6 MiB together), its header must match its extension, and it ships with
  `fonts/<name>.json`, `{ "family"?, "license", "src" }`, naming the terms that let documents embed it;
  a pack that ships a font without that is refused. A record links a PDF with
  `"vendorDocs": [{ "asset": "<sha256 of the PDF>", "label": "…", "src": "…" }]` (any record
  kind; `validateDb` checks the shape), which opens in the app at `/api/assets/<sha256>`. A served
  PDF or font carries `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`: nothing in it can run in the app's origin.
  **Images travel with the pack.** Besides `.json`, a zip or bundle carries the images under
  `depictions/**` and `art/**` (`svg`, `png`, `jpg`/`jpeg`, `webp`, lowercase extensions; in a JSON
  bundle a `files` entry for an image is the file, base64). Anything else is ignored in a zip and
  refused in a bundle. Each image is at most 2 MiB and a pack's images 12 MiB together; the bytes
  must be the type the name says; an SVG is stripped of scripts, styles, `foreignObject`,
  embedded images, animation, event handlers, `style` attributes, external references and
  DOCTYPE/entity declarations (`stripUnsafeSvg`, the safety half of the artwork upload's sanitiser:
  the drawing is not repainted or rescaled) and is refused if no `<svg>` is left. The images then
  follow the pack like its records (an upload, a URL and a store install take this one path, on both
  backends): `packs.json` records which of them the pack owns (`assets`, path to sha256), an update
  replaces the ones it still owns and removes the ones the new version drops, a disable removes
  them, and a file the catalog holds of its own is never overwritten or removed
  (`reconcileAssets`). On Postgres they go to the blob store with the same change set and are
  served by content address at `GET /api/blobs/<sha256>`; on the file backend they live in the
  pack's layer and are served at the same address.

  **A drawing's photo travels with the pack.** A pack adds an image to the shared asset library as
  `assets/<sha256>.png` (or `.jpg`; named by the hash of its bytes, which is checked) together with its entry in
  the pack's `assets/index.json` (`{ id, mime, originalName, src, bytes }`, a pack's entries are layered and
  installed in the store's order). The photo pointer `drawings/<id>.photo-ref.json` stays exactly
  `{ "assetId" }` and names that entry. The image is owned by the pack in `packs.json` like its other files:
  an update replaces it (and the pointer), a disable removes the image, its entry and a pointer at it; a
  file or entry the catalog holds of its own is never overwritten. On the file backend the bytes stay in the
  pack's layer and `GET /api/assets/<sha256>` serves them; on Postgres they become an `asset` row and blob
  with the same change set (no migration: the asset table already holds them).

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
- **Trust roots** are deployment configuration, plus the stores an owner or editor adds in
  Settings (see "Store sources" below): the store indexes a hub trusts, each by its
  key (`WIREHUB_STORE_INDEXES`). An index lists its publishers and their keys, so trusting an
  index trusts the publisher keys it vouches for. A pack the index pins but whose publisher it
  does not list installs on the index's signature and sha256 alone, and says so; a pack from a
  file installs as before (an owner or editor, with the diff).
- **What a signature means**: that the pack is the one its publisher published, unmodified.
  It does not mean the data is right. Correctness is shown separately as a **review status**
  per version — `unreviewed` (the default), `reviewed` (with who and when) or `flagged` (with
  a reason) — set by the index publisher. It is **information, not a gate**: WireHub does not
  police third-party content; a deployment may choose to hide unreviewed versions.
- **Generated packs are reproducible**: a pack built by a converter (KiCad library → bodies
  and model links) names the converter version and the pinned upstream commit in its
  manifest, so anyone can rebuild it and compare hashes.
- **Key rotation and revocation**: the index carries a list of revoked keys and yanked
  versions; a yanked version stays downloadable for re-validation but is never offered for
  install (an owner can still force one) and is flagged on deployments that have it. A
  publisher rotating its key signs with both keys for a while (`wirehub-pack.sig` holds one
  signature per key) and keeps the old key in its `keys` until it is retired or revoked.

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

A bundle is what Install pack… takes: a zip of the pack directory or a JSON bundle. `bundle` zips
every file of the pack directory in sorted order (so `depictions/**` and `art/**` images are in
it, with the PDFs under `docs/`/`assets/` and the fonts under `fonts/`) and refuses a pack whose images,
PDFs or fonts a studio would not install (wrong type or extension case, a name outside the allowed
characters, too large, not the type its name says).

**The signature** is `index.json.minisig` beside the index: a minisign signature (the prehashed
`ED` algorithm: ed25519 over the BLAKE2b-512 of the file, plus the global signature over the
trusted comment), so `minisign -Vm index.json -P <key>` verifies it too. The public key is
minisign's one-line form (`RW…`). The private key is a PKCS#8 PEM ed25519 key, and the key id is
the first 8 bytes of the public key's sha256, so the public key can always be printed from the
private one. The index pins every bundle by sha256 and size, and the index signature covers that;
phase 5 adds the publisher's own signature over each pack (below).

**What a hub does** (`apps/studio/server/store.ts`). `WIREHUB_STORE_INDEXES` lists the indexes it
trusts, each `<https url> <public key>` (comma separated; `docs/self-hosting.md`).
`GET /api/packs/store` fetches each index and its `.minisig` (https only, public addresses, the
4 MiB index / 16 KiB signature limits and the pack URL timeout), **refuses an index whose signature does not match the configured key**
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

**Hosting your own index.** `docs/store-hosting.md` is the short way: a GitHub template repository (`templates/store`) and a reusable action that build, sign and publish a store with no tooling of your own. By hand, a store is static files: put the bundles, `index.json` and
`index.json.minisig` in one directory on any https host (GitHub Pages, an object store, a web
server), keep every version you published in it (the index lists what the directory holds, and a
design built on an old version can be re-validated against it), rebuild and re-sign after every
change, and give people the index URL and your public key (for `WIREHUB_STORE_INDEXES`, or to paste into Settings > Store sources). Put a copy of `wirehub-store.pub` (public) beside `index.json` so the app can offer "fetch key from the store"; people should still compare the fingerprint with you. Keep the
private key out of the repository (a CI secret, as below). A mirror copies the directory as is:
the signature still verifies. You are responsible for what your packs contain and the licence you
give them; WireHub does not review store content.

**The official index** of WireHub's bundled packs (`modules/*/pack`, not the example) is built by
the pages workflow (`.github/workflows/pages.yml`: `store-index.mjs official`) and published at
`https://formless63.github.io/wirehub/store/index.json`, signed in CI with the GitHub Actions secret
`WIREHUB_STORE_SIGNING_KEY` (the PEM text of the private key). Without the secret the workflow
publishes it unsigned and says so with a warning; hubs refuse it until it is signed. Its public key
is `OFFICIAL_STORE_PUBLIC_KEY` in `apps/studio/server/store.ts`, recorded on 2026-10-05: hubs trust
the official index by default, and the workflow fails if the secret's key and the recorded one differ.

Official index public key (key id 289BB53D1B721017): `RWQXEHIbPbWbKH32jyM29IRDsITWmTwGdtDQzcVaY2peD2aQnCHCoVlj`

**The official publisher** is `wirehub` ("WireHub"), recorded in `scripts/official-store-meta.json`
with the public key `RWS7FUOto59buesmRailZTdc4XlAWM8BZoyFe8NeXwcHfLyeJVAIMl+h` (`store-index.mjs
official-publisher-key` prints it). Its private key is the GitHub Actions secret
`WIREHUB_PACK_SIGNING_KEY`. When the secret is set the pages workflow signs every `modules/*/pack`
(`sign-pack`), checks the signatures against the recorded key (a mismatch fails the build), and
builds the index with `--meta scripts/official-store-meta.json`, so each bundled pack carries
`signedBy`. Without the secret it publishes as before: unsigned packs, an index listing no
publishers, and a warning.

### Store sources: adding stores in the app

People add more stores, their own private ones or other creators', in Settings > Store sources
(owners and editors; viewers read). Browse store then lists the packs of every enabled store,
grouped by store, with a store filter; each pack says which store it is from, and a store that is
down or fails verification is named and left out without hiding the others.

- **Where stores come from.** The deployment's (`WIREHUB_STORE_INDEXES`, and the official index
  by default) are shown read-only, marked "set by the server", the official one with
  its state (trusted, or not enabled on this server). The ones added in the app are
  the org settings document `data/settings/stores.json` (`{ sources: [{ url, publicKey, label?, enabled, hideUnreviewed? }] }`),
  written with `If-Match` like the other settings, on files and Postgres. The two merge; on the same
  URL the deployment's entry wins. Turning off "owners and editors may add stores" (Settings > Integrations, or
  `WIREHUB_STORE_ALLOW_USER_SOURCES=false` on the server) ignores the document
  and refuses edits (default true).
- **Adding one.** A URL (https only) and the store's minisign public key. "Fetch key from the
  store's `wirehub-store.pub`" fills it in from beside the index; that is trust on first use (the
  key only proves the store matches itself), so the page says so and the person confirms the
  fingerprint (the key id and a sha256 fingerprint of the key) with the store's owner another way.
  Before saving, the server fetches the index and its signature, verifies them and shows the
  store's name, publishers, pack count and the fingerprint; saving re-verifies a new or re-keyed
  store. Fetches are the pack URL install's: https only, 4 MiB per index, 16 KiB per signature, 15 s, redirects re-checked, private
  addresses refused.
- **Review policy.** Each added store has a "Hide unreviewed versions" switch (default off).
  Owners and editors can change it in Store sources. When on, browsing and install offers
  include reviewed or flagged versions only; review claims remain the index publisher's statements.
  The deployment-wide `WIREHUB_STORE_HIDE_UNREVIEWED` restriction still applies to every store.
  Index limits count streamed bytes even when Content-Length is missing or misleading,
  and tighter download limits still apply.
- **Managing.** Enable or disable (a disabled store is not browsed or installed from), rename the
  label, re-check now, remove. Removing a store does not uninstall anything.
- **Origin and updates.** An install records the index URL it came from (`origin.index`); Browse
  store checks updates and notices for that pack against that store only. Another store listing the
  same id is shown as "installed from another store" and offers no update.
- API: `GET`/`PUT /api/settings/stores`, and `GET /api/settings/stores/(preview?url=&key=|key?url=|check?url=)`.

### As built (phase 5): publisher signatures, review, yanking, revocation

**The index** gains optional fields (format 1 still; a hub from before phase 5 ignores them):

```jsonc
{
  "format": 1, "store": { … },
  "publishers": [                                 // whose keys sign packs
    { "id": "acme", "name": "Acme packs", "key": "RW…",   // the current key
      "keys": ["RW…"],                            // older keys still valid (a rotation)
      "url": "https://…" }
  ],
  "revokedKeys": [{ "key": "RW…", "reason": "key lost", "on": "2026-10-05" }],
  "packs": [
    { "id": "fieldbus", …, "publisher": "acme",   // its manifest's publisher.id; every version must carry acme's signature
      "versions": [
        { "version": "1.4.0", …,
          "review": { "status": "reviewed", "by": "a reviewer", "on": "2026-10-04" },  // absent = unreviewed
          "signedBy": ["RW…"] },                  // the keys the builder verified: information, the hub verifies again
        { "version": "1.3.0", …,
          "review": { "status": "flagged", "reason": "values not sourced" },
          "yanked": { "reason": "wrong pinout on pin 4", "on": "2026-10-05" } }
      ] }
  ]
}
```

**A signed pack** (`packages/catalog/src/pack-signature.ts`). `sign-pack` writes `files` into the
manifest — every other file of the pack (what a studio installs: the `.json` files and the images
under `depictions/**` and `art/**`) pinned by sha256, a JSON file in its canonical form (two-space
`JSON.stringify` plus a newline, so the same pack verifies as a zip or a JSON bundle), an image as
its bytes — and then `wirehub-pack.sig`: one minisign signature (as the index's) per key over the
canonical manifest. In a JSON bundle the signature is the `signature` field. A manifest that pins
its files is checked on every install, signed or not: a file missing, changed or not pinned
refuses the install.

**What a hub does.** `POST /api/packs/store/install`, after the index signature and the bundle's
sha256 and size: when the index names the pack's `publisher`, the manifest must name the same
publisher, `wirehub-pack.sig` must hold a signature by one of that publisher's keys that the index
does not revoke, and every file must match the signed `files`; anything else is refused (422,
nothing written). The install records where the pack came from in `packs.json`
(`origin: { index, publisher, signedBy }`), which `GET /api/packs` shows. Then:

- **Review status** is listed per version (`releases[].review`, and on the offered `latest`) and
  shown in Browse store and the install preview, as the index publisher states it.
  "Reviewed versions only" (Settings > Integrations, or `WIREHUB_STORE_HIDE_UNREVIEWED=true`; default off) lists and installs only versions marked
  `reviewed` or `flagged`; a pack with none is left out (`hidden` counts them).
- **Yanked versions** are listed with their reason and never offered: the offered version is the
  newest that is not yanked (an `unavailable` action when every version is). Installing a yanked
  version needs `{ "version", "force": true }` from an **owner** (an editor gets 403; a host
  without roles counts as an owner); Browse store shows "Install … anyway…" to owners.
- **Revoked keys**: a pack whose only valid signatures are by revoked keys is refused for install,
  forced or not (a revoked key that the publisher no longer lists is still recognised). Browse
  store marks such versions.
- **Installed packs** are checked on every `GET /api/packs/store`: `notices` lists each installed
  pack whose version a trusted index has yanked, flagged, or whose signers (the recorded `origin`,
  else the index's `signedBy`) are all revoked, with `suggest`, the version the index offers now.
  The Packs panel shows a warning badge with that suggestion.

**Publishing** (`scripts/store-index.mjs`; keys are made outside every repository):

```
node scripts/store-index.mjs publisher-keygen --out ~/acme-publisher-keys --id acme --name "Acme packs"
node scripts/store-index.mjs sign-pack path/to/my-pack --key ~/acme-publisher-keys/wirehub-publisher.key
node scripts/store-index.mjs verify-pack-signature path/to/my-pack --pubkey ~/acme-publisher-keys/wirehub-publisher.pub
node scripts/store-index.mjs bundle path/to/my-pack --out my-store/        # refuses a pack changed after signing
node scripts/store-index.mjs publisher my-store/ --id acme --name "Acme packs" --pubkey RW… [--url …]
node scripts/store-index.mjs review my-store/ my-pack@1.2.0 --status reviewed --by "A. Reviewer" --on 2026-10-05
node scripts/store-index.mjs review my-store/ my-pack@1.1.0 --status flagged --reason "values not sourced"
node scripts/store-index.mjs yank my-store/ my-pack@1.1.0 --reason "wrong pinout" [--on 2026-10-05]
node scripts/store-index.mjs unyank my-store/ my-pack@1.1.0
node scripts/store-index.mjs revoke my-store/ --pubkey RW… --reason "key lost"
node scripts/store-index.mjs build my-store/ --store-id acme --store-name "Acme packs"
node scripts/store-index.mjs sign my-store/index.json --key ~/acme-store-keys/wirehub-store.key
```

`publisher`, `review`, `yank`, `unyank` and `revoke` edit `my-store/store-meta.json` (or
`--meta <file>`), which `build` folds into the index; build and sign again after each. `build`
refuses a bundle whose manifest names a listed publisher but is not signed by one of its keys or
whose pinned files differ, and warns about one signed only by a revoked key. `sign-pack` takes
`--key` more than once (a rotation), or the PEM text in `WIREHUB_PACK_SIGNING_KEY`. Giving a known
publisher a new key with `publisher` keeps the old one in its `keys`; revoke it when it should no
longer count. The official index lists the publisher `wirehub` (key recorded in
`scripts/official-store-meta.json`) once CI has the `WIREHUB_PACK_SIGNING_KEY` secret; until then the
bundled packs are pinned only by the official index's signature.

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
  verification; a pack that carries a code module installs at runtime (§2, "A pack with code").
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
5. Signed pack manifests, publisher keys, review status, yanking and revocation (**done**, both
   backends; review status is information set by the index publisher, with an optional
   deployment setting to hide unreviewed versions).

Packs cannot supply host control documents: `packs.json` (the installation ledger),
`setup.json` (first-run completion), `proposals.json` (review decisions), or
`settings/code-modules.json`, `settings/stores.json`, `settings/sign-in.json`,
`settings/notifications.json`, `settings/integrations.json`, `settings/jobs.json`
and `settings/webhooks.json` (runtime trust, authentication and operational controls).
Archive validation and directory planners/installers reject these paths before writes.
This is an explicit path list: ordinary auxiliary documents, including
`settings/branding.json`, `settings/engineering.json` and custom settings, remain supported.
