# Catalog store

Status: **design**, with the file-backend pieces of phases 1–2 implemented:
the pack manifest (`wirehub-pack.json`, `PackManifest`), a read-only layer over a catalog
(`layeredCatalogSource`), and install from a directory (`installPack`, used by first-run
setup for the bundled domain modules — `docs/modules.md`). Signing, the store index,
updates with diffs and per-record provenance fields are still design. Tracked in beads.

A fresh WireHub has the starter catalog: a few dozen generic records (CC0-1.0). Real work needs
the connectors, stocks and parts of a domain — XLR and speakON for live audio, M12 and
PROFIBUS for a factory floor, the OBD-II connector for a vehicle harness. Every shop
re-entering the same public facts is wasted effort, and every shop re-entering them by hand
is a source of errors. The **catalog store** is a public index of **catalog packs**: signed,
versioned bundles of catalog records, each record carrying its provenance and licence, that
a deployment installs and updates from the Library.

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
  depictions/<def>/…                             (artwork, optional)
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
(`pack: { id, version }` on the record in the database backend; `data/packs/<id>/` in the
file backend, merged by the catalog loader under the local records). A shop that needs a
change to a pack record **forks** it: the editor makes a local copy with a new id and
`derivedFrom: { pack, id, version }`, and designs move to the copy only when someone
chooses to.

**Implemented today (file backend).** First-run setup installs a pack as a **layer**:
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

**Install** (Library → Packs → Browse):

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
is kept as `status: "retired"` in the deployment, never deleted under a design. Updates
across a major version are never automatic. Rollback re-installs the previous version
through the same path.

**Offline / air-gapped**: a pack archive can be installed from a file (Library → Packs →
Install from file) with the same verification; a deployment may run its own mirror of the
index.

Packs a **module** ships (`CatalogPackContribution`) use the same format and the same
install path; a domain module's packs are installed at first-run setup when a person
picks the module (`docs/modules.md`).

**Licences are per pack and per record.** Packs are data, not code: the AGPL of WireHub
does not reach them (`MODULE-EXCEPTION.md` §3). A pack names its licence in its manifest
(SPDX), a record may name its own, and the install plan shows every licence a deployment
is accepting. The starter catalog (`packages/catalog/data`) and the bundled packs are
CC0-1.0, each directory with a `LICENSE` file saying so; the catalog's code stays
AGPL-3.0-only.

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

## 5. Public data sources and their licence caveats

Not legal advice — the owner should have these reviewed before the store publishes
anything. The general rule the store follows: **pin assignments and dimensions are facts
and are cited, not copied**; standards' text, tables and figures are never reproduced;
every record names its source.

| Source | What it gives | Licence / caveats |
| --- | --- | --- |
| **KiCad libraries** (symbols, footprints, 3D models; gitlab.com/kicad/libraries) | footprint pad geometry, connector body names, 3D models | CC BY-SA 4.0 **with the KiCad libraries exception** (designs using the libraries are not adapted material). A pack that *contains* KiCad-derived data (converted models, extracted geometry) is itself CC BY-SA 4.0 and must carry attribution. Prefer packs that **link** to the upstream file at a pinned commit with its sha256 and let the deployment fetch it (as the base's model import already does). |
| **TIA / EIA standards** (TIA-232, TIA-485, TIA-568, TIA-574) | serial and structured-cabling pin assignments, colour codes | Standards documents are copyrighted and sold. The assignments themselves (pin 2 = RxD on a DE-9 DTE) are widely published facts; cite the standard by number and clause, do not reproduce its tables or figures. |
| **IEC / ISO standards** (IEC 60603-7, 61076-2-xxx, 60320, 61158; ISO 15031-3) | connector families, codings, fieldbus pinouts | Same as TIA: paywalled and copyrighted; facts cited by number. Some IEC derived national standards (EN, BS, DIN) have identical content and identical restrictions. |
| **IEEE 802.3** | Ethernet MDI pinouts, PoE pair use | Copyrighted; IEEE makes 802 standards available free through the IEEE GET program after a delay — still not redistributable. Facts cited. |
| **USB-IF** (usb.org) | USB 2.0 / 3.x / Type-C connector and cable specifications | Specifications downloadable free under the USB-IF's licence terms (no redistribution). The USB logos and certification marks are trademarks usable only under the USB-IF logo licence — packs use plain names ("USB Type-C plug"), never logos. |
| **HDMI** (HDMI Licensing Administrator) | HDMI connector pinouts | The specification is licensed to adopters only; the pinout is widely published but no official public source can be cited. "HDMI" is a trademark: product names in records must be descriptive ("HDMI Type A plug" as a nominative reference), no logos. A pack may cite a secondary public source and must flag the record as such. |
| **VESA** (DDC, DisplayPort, VGA) | VGA/DDC pinout, DisplayPort pinout | DDC/EDID standards are free to download after registration but not redistributable; DisplayPort is member-only. Facts cited. |
| **SAE J1962 / ISO 15031-3** (OBD-II) | the 16-pin diagnostic connector and its mandated pins | SAE documents are sold and copyrighted; the mandated pin assignments (4/5 ground, 16 battery, 6/14 CAN) are public regulatory facts (also in US EPA / EU type-approval rules) and can be cited. Manufacturer-discretionary pins are not standard and must not be presented as such. |
| **AES** (AES14, AES3) | XLR audio polarity convention, AES/EBU digital audio | AES standards are sold, free for AES members; facts cited. |
| **ESTA / ANSI E1.11** (DMX512-A) | DMX connector pinouts | Available free from the ESTA TSP (registration); facts cited. |
| **Manufacturer catalogues and datasheets** (TE, Molex, Amphenol, Neutrik, JST, Phoenix Contact, Belden, Alpha Wire, Lapp …) | part numbers, dimensions, materials, ratings, stock constructions | Datasheets are copyrighted; the specifications in them are facts. Many manufacturers' websites' terms forbid scraping and bulk reuse — transcribe by hand or obtain permission; never bulk-import a catalogue. 3D models and CAD from manufacturers (and from aggregators like SnapEDA / Ultra Librarian / TraceParts) usually come under licences that **forbid redistribution** — packs link to them, never include them. Trademarked product names are used nominatively. |
| **Distributor data** (Digi-Key, Mouser, Octopart APIs) | parametric data, availability | API terms generally forbid redistributing the data; usable by a deployment for its own lookups (a module), not as a source of store packs. |
| **Wikipedia / Wikimedia Commons** | pinout tables, connector drawings | CC BY-SA (text) and per-file licences (images). Good for cross-checking, but a record citing only Wikipedia is marked `community`, and any copied drawing carries its own licence and attribution. |
| **Pinout aggregator sites** | many pinouts in one place | Usually all rights reserved and of mixed accuracy — use only to find the primary source, never as the cited source. |
| **Own measurements** | stock ODs, conductor counts, colour orders | The publisher's own data under the pack's licence; `method: "measured"`, with what was measured and how. |

Store policy, in short: records under licences that forbid redistribution never enter a
store pack; ShareAlike records are allowed but the pack's licence must be compatible and
the obligation is shown before install; every pack declares its licence in SPDX form, and
the install plan shows the set of licences a deployment is accepting.

Database rights: in the EU a substantial extraction from a protected database can infringe
even when each fact is free. The store therefore does not bulk-copy any one third-party
collection; packs are assembled from primary sources.

## 6. Where it plugs into the base

- **Model**: records gain optional `license`, `provenance` and `derivedFrom` fields (added
  to the model types and validated by `validateDb`); `src` stays mandatory.
- **Catalog (file backend)**: `data/packs/<id>/` with its manifest; the loader merges pack
  records read-only under the local ones and refuses a local record that shadows a pack id
  without forking it.
- **Postgres backend** (`specs/postgres-backend.md`): pack records live in the same tables
  with `pack_id`, `pack_version` columns; installs and updates are units of work through the
  normal write path, so they are audited and versioned like any other change.
- **Modules**: `CatalogPackContribution` packs install at build time through the same
  verification.
- **UI**: Library → Packs (browse, install, update with diff, fork a record), and a pack
  badge on every record that came from one.

## 7. Phases

1. Model fields (`license`, `provenance`, `derivedFrom`) and the pack manifest type; a
   `pack verify` command (hashes, schema, `validateDb`).
2. File-backend loading of installed packs; install from file; fork a record.
3. The signed static index, store browsing and install/update with diff in the Library.
4. First packs: `core-bodies`, `pro-audio`, `fieldbus`, `networking`, each reviewed against
   cited sources; the KiCad model-link pack built reproducibly.
5. Publisher keys, review status workflow, yanking and revocation.
