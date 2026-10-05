# Parity review: the prior studio and WireHub

WireHub was split out of a private studio that one shop used to capture its own
production cables (`docs/boundaries.md`). This review asks two questions:

1. Did any feature of the prior studio get lost or degraded in the move, beyond what
   `docs/boundaries.md` deliberately left behind?
2. What does a complete cable and harness design tool still need that neither has?

Every follow-up is a bead under the epic **cs-5k1 "Parity and completeness"**. The
beads are ordered by value. This file describes features generically. Where a
feature belongs to the shop, it says "a private module".

## Method

- **Prior design.** The frozen private repository: its spec and per-epic specs; every
  route, panel and command of its app; every API route of its server; its packages and
  scripts. Its live instance was read with GET requests only. Its API index matches
  its source.
- **WireHub.** `main` at the time of writing. Each feature was checked in the code: a
  file-by-file diff of every source file the two share, plus a diff of the route,
  command and validation-code lists. The app was also run on the file backend, and
  every generic API route answered 200.
- Each feature got one class:

| Class | Meaning |
| --- | --- |
| **present** | same or better |
| **degraded** | present, but weaker (the row says how) |
| **missing, generic** | belongs in the base or a public module |
| **missing, private** | belongs to a future private module (already covered by `docs/boundaries.md`) |
| **dropped** | not carried forward on purpose |

## Summary

| Class | Count |
| --- | --- |
| present | 93 |
| degraded | 7 |
| missing, generic | 4 |
| missing, private | 27 |
| dropped | 7 |
| **total** | **138** |

The base came through almost intact. The model, the validation rules (every issue
code except the product, route, resolver and private-numbering ones), the editor, the
Library, versions, locks, documents, assets and the API surface are all present.
Several of them are better than before: pack records, module slots, jobs, the
Postgres backend, accounts and API tokens.

What was lost is mostly glue around the private parts:

- documents no longer carry the organisation's identity;
- a generic variant transform has no button;
- part numbers are checked for format but never for duplicates;
- the 3D board-model path has no way in;
- the headless document scripts were not carried over;
- six design specs are still waiting to be rewritten generically.

## Feature inventory

### App shell and navigation

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Cable list route | present | |
| Cable workspace: build, schematic and documents views, selection in the URL | present | |
| Library route per kind and record | present | |
| A saved revision opened read-only (`?rev=N`) | present | |
| Product lineup page | missing, private | resolver and lineup module |
| Board import page | missing, private | board importer over one file share (see cs-5k1.13 for open formats) |
| Part compare view (2D art and 3D model diff, revisions) | missing, private | boundaries §2.5; the Library still draws Compare but nothing can supply it: cs-5k1.21 |
| Declined board-proposal tab | missing, private | resolver module |
| Not-found view | present | |
| Top bar: breadcrumb, unsaved dot, view switch, undo/redo, save, overflow menu | present | |
| Make-variant menu | degraded | its two shop-specific entries were dropped. The generic "move onto another stock" transform survives in code with no UI: cs-5k1.10 |
| Left rail | present | better: module routes, jobs, people, tokens |
| Status bar: issues, counts, unsaved, zoom | present | |
| Narrow / phone layout | present | |
| Light and dark themes, following the system | present | |
| Shop wordmark and icons | dropped | neutral WireHub brand |
| Production-route badge | missing, private | |

### Commands and shortcuts

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Command palette and quick open (Ctrl/Cmd K): cables, library, actions | present | |
| Save (Ctrl S); undo and redo (Ctrl Z, Ctrl Shift Z, Ctrl Y) | present | |
| Auto-arrange, fit view, find pin, add part (Tab / `+`), select and pan tools | present | |
| Rename, duplicate, delete, new cable, theme, go-to commands | present | |
| Two shop-specific "copy as variant" commands | dropped | |
| Connect known pins: propose missing joints | missing, generic | its generic half needs only signal tags: cs-5k1.8 |
| Recipe and overrides command | missing, private | |

### Cable list

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Columns: part number, source, destination, wire, notes, boards; sortable | present | |
| Filter chips (source, destination, wire, board, status), kept in the URL | present | |
| Domain "sync" column and filter | missing, private | came from the private resolver |
| Retired designs hidden unless filtered; status chips | present | |
| Revision chip and unreleased marker | present | |
| Derived feature chips | present | |
| Product grouping: aliases, builds, merge, split | missing, private | boundaries §2.1 |
| Search rows for numbers known only to a private register | missing, private | |
| Faint suggested number for an unnumbered design | degraded | the suggestion now appears only in the part-number field. The report in cs-5k1.3 brings the overview back |
| Length-family part-number notation | present | |
| New cable button | present | |

### Editor canvas and inspector

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Board nodes with top and bottom artwork, handles on the real pads | present | art from uploads or packs. Generating it from fabrication files is private today (cs-5k1.13) |
| Wire nodes with end-face cutaways, chirality, jacket run | present | |
| Port columns, stubs under the jacket, bundled grounds (`×n`) | present | |
| Automatic end rotation | present | |
| Connector face drawings | present | domain drawings now live in domain modules; the shop's own drawings are private |
| Connectors docked to the board they mount on | present | |
| Connection inspector with joint editing | present | |
| Node picker that lists only legal parts | present | |
| Level of detail; ELK auto-arrange | present | |
| Net hover, trace highlight | present | |
| Pigtail and re-pin gestures | present | |
| Breakout editing: split a segment, set fates, attach legs | present | |
| Moulds and other mechanicals on the canvas | present | |
| Inspector tabs: connection, part, nets, issues, notes | present | |
| Recipe tab and recipe bar | missing, private | |
| Advanced JSON pane | present | |
| Unsaved-changes guard, local draft persistence, offline cache | present | |
| Edit locks: request, decline, takeover, lock banner | present | |

### New cable wizard

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Wizard fast path: ends, stock, landing by role | present | now reads the vocabulary, not hard-coded signal names |
| A shop-specific bare-head preset | dropped | boundaries §10 |
| Resolver journey (device and requirement ranking) | missing, private | |
| Connector body templates | present | domain templates in modules |

### Library

| Feature | Class | Notes / bead |
| --- | --- | --- |
| A table for every kind: part number, name, kind columns, used, status, flags, id | present | |
| Sorting, facet chips, search, remembered columns, cards on narrow screens | present | |
| Record page: head, 2D/3D/photo views, properties, where used, editor, source | present | |
| Revisions section of an in-house part | missing, private | board designer's files |
| Compare action and pick-two mode | missing, private | hook gap: cs-5k1.21 |
| New variant (connector construction), duplicate | present | |
| Unused pinouts | present | |
| Connector editor (body plus interface) | present | |
| Component editor | present | |
| Wire stock editor and wire builder (parts, lay order, live cutaway) | present | |
| PCBA editor: terminals, pads, internal links, integrated connectors | present | |
| Board builds editor (population, jumpers) | present | |
| Mechanical and kit editors | present | |
| Board journey | present | its import step is private |
| Artwork upload, click-to-place anchors, entry guides | present | |
| 3D models: STEP/STL/GLB upload, conversion in the background | present | now a job |
| KiCad library models and a board's 3D assembly from its KiCad file | degraded | the code is there, but its feeding scripts were left behind, so nothing can create such a source: cs-5k1.12 |
| Model matcher and import over one file share | missing, private | |
| Parametric 3D wire stocks | present | |
| Vendor documents on parts | present | |
| Signal-tag editing | present | |
| Inline vocabulary editing | present | |
| Declined-proposal list | missing, private | |
| Read-only imported records | present | better: pack records are read-only, with fork |
| Part-number field with suggestion and format checks | present | over the pluggable scheme |
| Duplicate part-number protection | degraded | the prior studio avoided reuse through a private register. The base checks format only: cs-5k1.3 |
| Part-number register, reconciliation, ERP identity table | missing, private | |

### Documents

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Build sheet: bench pages, numbered landings, cut list | present | |
| Bench work instructions | present | a generic step set; the shop's instructions are private; the module hook is cs-1dt |
| BOM sheet | present | |
| Continuity spec with isolation checks | present | isolation rules now come from the vocabulary |
| Drawing sheet: faces, cutaway, wire table, title block, length families | present | |
| Organisation identity on the drawing sheet (logo, rights line, fixed text) | degraded | only a code module can set it; the base prints an empty rights line: cs-5k1.2 |
| The shop's traced faces, cutaway art and brand font | missing, private | |
| Wire spec sheet | degraded | organisation and standard name are fixed to "WireHub" unless a code module changes them: cs-5k1.2 |
| Print / save as PDF, copy as Markdown | present | |
| UNRELEASED watermark; print a chosen revision | present | |
| ERP export pane | missing, private | |
| Documents of a saved revision against its frozen definitions | present | |
| Headless rendering (scripts that wrote sheets for named designs to a folder) | missing, generic | cs-5k1.7 (CLI and API) |

### Design versions

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Save version with a note; numbering follows the drawing's revision | present | |
| Open an old version read-only | present | |
| Diff two versions, or a version against the working copy | present | |
| New version from this; restore displaced drafts | present | |
| Unlock with a reason, save and relock, append-only history | present | |
| Artwork copied into versions | present | |
| Deleting a design that has versions is refused; renaming moves its versions | present | |

### Drawings and assets

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Drawing form: title-block fields, length variations, photo | present | |
| Shared content-addressed assets, picker, recently used | present | |
| Photo migration script | dropped | one-shot |

### Model and validation

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Structural validation: references, paths, ends, pigtails, breakouts, scope, screens | present | every code carried over |
| Product and production-route validation | missing, private | |
| Recipe drift and override checks | missing, private | |
| Nets, trace, bonds, breakout derivations | present | |
| Schema migration v1 to v4 | present | |
| Wire recipes | present | |
| Kits | present | the SKU grammar is now a generic token rule |
| Devices, rules, resolver, recipe inference | missing, private | |
| Board proposals | missing, private | |

### Server and API

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Designs: list, read, write, create, duplicate, rename, delete | present | |
| Definitions: CRUD and usage | present | |
| Vocab, tags, wire library, builds, drawings, assets, depictions, models, versions, locks, me, backup routes | present | |
| Rules, devices, ERP identity, register and reconciliation routes | missing, private | |
| Board import, part revisions, lineup, products, proposals and ERP routes | missing, private | |
| Validate before write, If-Match / ETag, unit of work, write lock, write journal | present | |
| API index and 404 hints | present | |

### Background work, backup, auth and deployment

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Every save a git commit by its author, pushed with retry; backup indicator | present | better since cs-5k1.4: every save is a change set on the database backend, with a History panel per record, a hub-wide History page, field-level diffs and restore on both backends, and an opt-in git mirror of every change set (`docs/self-hosting.md`) |
| Model conversion in the background | present | now a job, with a worker on Postgres |
| Board import jobs | missing, private | |
| Login: local allow-list, OIDC, magic link | present | better: accounts, invitations, people page, API tokens |
| Local user name when the login is off | present | |
| Live-clone deploy and proxy specifics | dropped | |
| Single-container compose | present | replaced by the full stack |

### Scripts and specs

| Feature | Class | Notes / bead |
| --- | --- | --- |
| Catalog import scripts (boards, depictions generator, board components, fab files, legacy boards, store products, devices) | missing, private | |
| One-shot data migrations | dropped | schema migration itself lives in the model |
| Fixture catalog refresh | present | a documented copy |
| Document and drawing preview scripts | missing, generic | covered by cs-5k1.7 |
| Rendering measurement and raster-check scripts | dropped | development aids for private designs |
| ERP, lineup and part-number report scripts | missing, private | |
| Artwork import script | present | replaced by the upload in the UI |
| Six design specs left out as "re-specify generically later" | missing, generic | only the drawing language was rewritten: cs-5k1.14 |

## Missing (generic) and degraded, with beads

| Bead | Item | Class | Size |
| --- | --- | --- | --- |
| cs-5k1.2 | Organisation identity on every document, set from the UI | degraded | M |
| cs-5k1.3 | Part-number health: duplicates, unnumbered parts, disagreements | degraded | M |
| cs-5k1.4 | Change history on the database backend; optional git mirror (done) | degraded → present | L |
| cs-5k1.7 | Headless document rendering: CLI and API | missing, generic | M |
| cs-5k1.8 | Connect known pins by signal tags | missing, generic | M |
| cs-5k1.10 | Make-variant: copy a cable onto another trunk stock | degraded | S |
| cs-5k1.12 | KiCad 3D-model pipeline: give it a way in, or remove it | degraded | M |
| cs-5k1.14 | Re-specify the remaining design specs generically | missing, generic | M |
| cs-5k1.21 | A compare-view slot in the Library for modules | missing, private (hook gap) | S |

## Gaps beyond parity, ranked by value

Neither system has these. They were judged against the mission in `SPEC.md` ("wiring
schematics, build sheets, BOMs, continuity/test specifications and drawings"), the
phase plan, and what a harness shop expects from a design tool.

| Rank | Bead | Gap | Size |
| --- | --- | --- | --- |
| 1 | cs-5k1.1 | Production exports: BOM, wire list and cut list as CSV (XLSX optional) | M |
| 2 | cs-5k1.5 | Crimp terminations as parts: contacts, seals and tooling per cavity, in the BOM and on the build sheet | L |
| 3 | cs-5k1.6 | Continuity tester export (neutral format) and test parameters (threshold, hipot) | M |
| 4 | cs-5k1.9 | Sub-assemblies: a design that places other designs, with BOM roll-up and frozen revisions | L |
| 5 | cs-5k1.11 | Release approvals on saved versions | M |
| 6 | cs-5k1.13 | Decision: a public board-import module for open file formats (KiCad, Gerber, fab BOM/CPL) | XL |
| 7 | cs-5k1.15 | Electrical rules: conductor gauge, contact rating, voltage drop | M |
| 8 | cs-5k1.16 | Harness formboard drawing for branched assemblies | XL |
| 9 | cs-5k1.17 | Costing: price breaks and BOM cost roll-up | M |
| 10 | cs-5k1.18 | Interop: WireViz YAML and connection-list CSV import and export | M |
| 11 | cs-5k1.19 | Bulk library import from CSV, with provenance | M |
| 12 | cs-5k1.20 | Wire and cable-end identification labels | M |

The standards-profiles epic (cs-ml3: ISO/ASME sheets, revision blocks, acceptance
classes) already covers drawing conventions. It is not repeated here; cs-5k1.2,
cs-5k1.11 and cs-5k1.20 cross-reference it.

## Decisions for the owner

1. **Open-format board importers (cs-5k1.13).** The boundaries kept the board
   importers private because they read one file share. The formats they parse are
   public. Recommendation: build a public module over the importer contract (files
   are uploaded, then reviewed and published as a job), and keep only the file-share
   discovery private.
2. **Generic part compare (cs-5k1.21).** The compare view went private together with
   board revisions. Comparing two library parts (2D artwork, 3D models) is generic.
   Recommendation: add the module slot now. Decide later whether the base itself
   compares two parts.
3. **History on the database backend (cs-5k1.4).** Recommendation: a History panel and
   restore in the base. The git mirror would be an opt-in job, for hubs that want an
   off-site, diffable trail. **Decided and built** as recommended.
