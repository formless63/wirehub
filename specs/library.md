# The Library

How the parts Library presents and edits definitions: the tables, the record page, the
editors, and the rules a change to a definition must satisfy. The generic spec of
`packages/editor-react/src/library*.ts`, `panels/Library*.tsx`, `panels/RecordOverview.tsx`,
the definition editors, `apps/studio/src/routes/LibraryRoute.tsx` and
`apps/studio/server/definitions.ts`. The data a definition holds is in SPEC.md; artwork is in
`specs/depictions.md`; the UX rules the Library follows are in `specs/workbench-ux.md`.

The Library is where definitions live: connectors (with their bodies and interfaces), wire
stocks, components, boards, mechanical parts (shells and hardware) and kits. A design only
*references* them by id.

## 1. Kinds and routes

`LIBRARY_KINDS`: `connectors`, `components`, `wires`, `pcbas`, `mechanicals`, `kits`. The URL
says `/library/<kind>` and `/library/<kind>/<id>`, with `boards` for `pcbas` and `hardware`
for `mechanicals`; the one place that translates is `LibraryRoute.tsx`. `/library` redirects to
the first kind and `/library/store` is the pack store. Selection lives in the URL, so a record
is linkable and the back button works.

## 2. The table

Every kind has the same frame: **PN, Name, the kind's own columns, Used, (Status), Flags, Id**.
Columns are defined in `library-table.ts`; the functions are pure, so every rule is tested
without a DOM.

| Kind | Own columns |
| --- | --- |
| connectors | Family, Gender, Construction (how it is terminated), Pins, Body, Pinout |
| components | Kind, Value, Package, Terminals; any scalar field a record carries becomes an optional column |
| wire stocks | Construction tag (`6+2C`, `8C`), Cores, OD, Lay |
| boards | Rev, Build, Released, Builds, Pads; plus **Status** (`active`, `development`, `legacy`, `retired`, `imported`) |
| mechanicals | Kind, Rev, Fits |
| kits | Parts |

- **PN** is the number the record answers to (`resolvePartPartNumber`): its own, a
  connector's body's, or a plain dash, never a guess; the tooltip says which.
- **Name** is `displayLabel`: the stored label without a part number repeated in it and, for a
  wire stock, without the maker's name. Display only. The record, and everything printed from
  it, keeps the stored label, and a search for it still matches.
- **Used** is `definitionUsage`: the designs and other definitions that use the record.
- **Flags**: `3D` (a model is linked), `Art` (a depiction exists), `Photo`, `Inferred` (the
  `src` says a value is inferred), `Importer` (made by an importer), `Pack` (supplied by an
  installed catalog pack).
- **Search** matches PN, name, aliases and id, case and spacing ignored; every word must be
  found somewhere. **Facets** are chips on the columns marked as facets, each a checklist of
  the values present; filters combine with AND across columns, OR within one. Legacy and
  retired boards are hidden unless asked for.
- **Sort** by any column, text or the cell's own sort key.
- **Column choice** (which columns are on) is remembered per kind in this browser's local
  storage (`cs.library.columns.v1.<kind>`). The list's width and fold state are remembered
  the same way (`cs.library.list-pane`; Ctrl+B folds it). Both are per-viewer conveniences:
  every read and write is guarded, and the Library works at its defaults when storage is
  missing.

## 3. The record page

One frame for every kind (`RecordOverview`), so nothing has to be looked for twice:

1. **Head**: PN, name, kind chip, id, flag chips, and the kind's actions (edit, duplicate,
   delete, history, fork for a pack record), plus the kits a part is in with a control to add
   it to another.
2. **Views**: kind-specific, mounted by the Library: a connector's face, a board's art, a
   wire stock's builder and cutaway, a 3D model viewer when a model is linked.
3. **Properties**: a grid in the table's own column order.
4. **Where used**: the designs and definitions that reference it, as links, and for a
   connector its mounting summary.
5. **Source**: the `src` citation, collapsed by default (`SourceBlock`).

A wire stock's page has its own tabs (builder, cutaway, 3D). A kind that can have art grows an
**Artwork** tab beside Definition, and a board also has tabs for importing its board data, its
pads and its builds, with a **journey** strip that guides a board's art, pads and builds to a
usable state.

## 4. Editing

- **Forms, not JSON.** Each kind has a structured editor (`ConnectorEditor`,
  `ComponentEditor`, `WireStockEditor`/`WireBuilder`, `PcbaEditor`, `MechanicalEditor`,
  `KitEditor`). The mapping is a round trip held by tests: turning a record into a form and
  back gives the record, field for field, for every record in the catalog. The form is not a
  lossy view of the record; it *is* the record.
- **A draft is all strings.** A diameter half-typed is `"1."`, which is not a number; turning
  it into one mid-keystroke eats what people type. Numbers happen at the boundary, once.
- **The wire form has a deliberate limit.** The structure of a stock is an arbitrary tree; the
  form edits the shape the catalog uses and the cutaway draws (cores: coax, shielded or plain;
  an overall shield, a drain, a jacket). A stock outside that shape is left alone: the form
  says so and points at the JSON view. Its read-only cross-section still renders
  from the original stock, including nested twisted-pair groups; rendering does
  not require flattening the stock into an editable form. The editor is
  constrained, never the model.
- **`src` is required.** The editors have a Source field; provenance is an input.
- **Part numbers** are chosen through the `PartNumberScheme` (`PartNumberField`), which
  proposes the next free number; validation warns of a duplicate (`pn-duplicate`) and a design
  save that would newly create one is refused.
- **Packs are read-only.** A record from an installed pack carries `Pack`, shows its pack and
  version, and cannot be edited or deleted; **Fork** (`POST /api/definitions/:kind/:id/fork`)
  makes an editable copy under a new id.
- **Edit locks.** The first change in a form takes the record's edit lock; another person's
  lock shows who holds it and offers Request edit (`specs/design-versions.md` section 8).

## 5. The rules of a definition change

`handleDefinitionRequest` (`PUT`, `POST`, `DELETE`):

1. **Validate the whole library, not the record.** Taking pin 15 off a connector breaks every
   board that integrates it and every design that solders to it. The candidate library goes
   through `validateDb`, and every design through `validateDesign` against it, before anything
   is written.
2. **Report only what the edit broke.** The checks are a diff against the library as it
   stands, so a catalog that already has a problem elsewhere does not make every record
   uneditable.
3. **A delete names its referrers.** Deleting a record that is used answers `409` and lists
   the designs and definitions that use it (`GET .../usage` gives the same list).
4. **`src` is required**, and `license`/`provenance` when given are well-formed.
5. Ids are slugs, kebab-case, never paths; an id in use is refused.
6. A definition frozen in a saved version is untouched by any of this (`specs/design-versions.md`).

Every refusal is a sentence plus a hint, with the validator's issue list for the GUI to render
(`specs/workbench-ux.md`).

## 6. Related surfaces

- **Models.** A record may link a 3D model (an uploaded file, or a library's); the page shows
  it in a viewer. Wire stocks render parametrically in 3D from their definition.
- **Compare.** Boards and mechanical parts compare revisions side by side (`RecordCompare`),
  where a deployment keeps more than one revision of a record.
- **History.** The History button opens the record's change history (who, when, a diff).
- **Store.** `/library/store` browses the packs a trusted store indexes and installs or
  updates them through the pack lifecycle (`docs/modules.md`, `docs/catalog-store.md`).
- **Quick open.** Ctrl+K opens any record by PN, name or id.
