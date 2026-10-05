# Interop and costing

Three ways records and designs move in and out of WireHub, and what a BOM costs.
None of it is shop-specific: the formats are public, and the two importers are bundled
modules (`docs/modules.md`, "Interop modules").

## WireViz YAML (`modules/wireviz`)

**Import.** The Library's **Import…** takes a WireViz harness (`.yml`, `.yaml`). It runs as an
import job, so there is a review step and **Publish** commits one change set; nothing is written
before that. The proposal is a design plus any new connector and wire-stock records it needs.

| WireViz | WireHub |
| --- | --- |
| `connectors` | connector instances. A library connector is chosen only when `pn`, `mpn` or `type` (also `type subtype`) equals a record's part number, id, alias or label and the pin count agrees; otherwise a connector record is proposed from `type`, `subtype` (male/female become the gender), `pincount`, `pins` and `pinlabels`, with an INFERRED `src` |
| `cables` | wire segments. Stock chosen the same way (`pn`, `mpn`, `type`); otherwise a stock is proposed from `wirecount` or `colors`, `color_code`, `gauge` and `shield` |
| `colors`, `color_code` | conductor colours (`WHBU` becomes `white-blue`); IEC, T568A, T568B and BW codes are read, others are reported |
| `gauge` | conductor area in mm2; AWG is converted with the standard diameter formula and noted |
| `length` | segment length (metres by default; `mm cm m in ft yd` units read) |
| `wirelabels` | the segment's core labels |
| `connections` | joints. Pin and wire lists, ranges (`1-4`, `9-7`), pin labels, `s` for the shield, `--` arrows between connectors, connector `loops` |
| `notes` | connector notes; cable and metadata notes become design notes |
| `metadata.title` | the design's name and id |

An existing library stock's wires are numbered in its conductor order (non-bare conductors, then `s`
is the first shield, else the first bare conductor).

**What is lossy** is listed as `Not carried over: …` notes in the review: pin colours, appearance
attributes (`image`, `bgcolor`, `style`, `color` …), connector mating arrows, arrow direction,
`additional_bom_items`, `category: bundle`, a shield's colour, a shield's construction (a proposed shield
is a foil, flagged INFERRED), colour codes this does not read (DIN, TEL, TELALT), `options`, `tweak`,
`templates`. A reference to a pin or wire that does not exist, a wire count that does not match, or a
design problem the library's rules find is reported, and that joint is skipped, never guessed.

**Export.** **WireViz (YAML)** in the Documents toolbar (also
`GET /api/modules/wireviz/_export/wireviz-yaml?design=<id>`) writes the connectors, cables and
connections WireViz can express. Anything it cannot (components, boards, breakouts, shells and
hardware, pigtails, joints that do not run from a connector pin to a cable wire, a second shield) is
listed as `# Not carried over:` comments at the top of the file. Exporting a design and importing the
file back into the same library reproduces its expressible joints on the same connectors and stocks.

## Bulk CSV library import (`modules/csv-library`)

**Library, Bulk CSV…** takes a CSV or an XLSX sheet (the first one) of connectors, wire stocks, components,
mechanicals, boards (PCBAs) or kits.

1. Pick the file; the kind is read from a `type` column or from the headers, and can be changed.
2. **Map columns.** Each field of the kind has a drop-down of the file's columns (pre-filled by header
   name), and a box for one value to use on every row (a kind, a currency). **Batch source** fills the
   `src` of rows that have none.
3. **Dry run.** Per row: new, already in the library (skipped, never overwritten; the fields where the
   file differs are shown), with **Update existing records** on, an update (each changed field, before and
   after) or unchanged, or invalid, with every reason (no source, a bad number, a duplicate id or part
   number, a value the library's validation refuses).
4. **Review.** The canonical file goes to an import job; its plan is reviewed and **Publish** commits
   all the new records (and the updates) as one change set. Invalid rows are not part of it.

**Update mode** (the `library-csv-update` importer) diffs a row against the record the library has under its
id and saves the result as an edit of that record, checked like any save and made against the version the
import read (one that moved since fails the publish, nothing written). A blank cell keeps what the record has;
what the columns cannot say is kept too (a pin's signal, a board's pads and structured link paths, a kit
line's note, a wire stock's pairs and drains: a stock that is not a flat list of conductors keeps its structure
and a note says so). A row that changes nothing is reported as unchanged; a changed `src` alone is not a change.
Each row still needs every required column, as for a new record.

Every record needs a `src`. Templates (one click each in the dialog; `templateCsv(kind)` in the module)
have the canonical columns and one worked example row. Columns, in order:

- connectors: `type, id, label, family, gender, part_number, pins, pin_labels, construction, contact_rating_a, aliases, src` + cost columns. `pins` is a count or ids separated by semicolons.
- wires: `type, id, label, part_number, manufacturer, spec_ref, conductors, colours, area_mm2, material, od_mm, shield, src` + cost. Conductors are `c1..cN` in the colour order; `shield` is none, foil, braid, spiral or tape.
- components: `type, id, label, kind, category, value, part_number, mpn, manufacturer, package, tolerance, terminals, src` + cost.
- mechanicals: `type, id, label, kind, part_number, revision, src` + cost.
- boards: `type, id, label, part_number, revision, build, kicad_project, status, terminals, terminal_labels, links, src` + cost. `terminals` is ids separated by semicolons (or a count); `links` is declared continuity, `from>to` or `from>to:via` separated by semicolons.
- kits: `type, id, label, sku, contents, src` + cost. `contents` is `kind:id` or `kind:id:quantity` separated by semicolons (`connector:de9-male;mechanical:jackscrew-4-40:2`).
- cost columns: `unit_cost, currency, cost_per, cost_breaks, moq` (breaks as `10:0.80;100:0.60`).

A blank `id` is derived from the name. A file uploaded straight through **Import…** must already use the
canonical headers (a `type` column and the field keys); the mapping dialog writes that file. An XLSX is read
without a dependency (stored or deflated zip, shared or inline strings; formulas show their cached value).

## Costing

A library record may carry an optional **price** (additive; records without one are unpriced):

```jsonc
"cost": { "unit": 0.42, "currency": "USD", "per": "each",
          "breaks": [{ "minQty": 100, "unit": 0.35 }], "moq": 25, "src": "quote 2026-10-01" }
```

- `unit` is per piece, or per **metre** for a wire stock (`per` says otherwise); `currency` is an ISO
  code and defaults to the hub's; `breaks` give the unit price from `minQty` up (the base price applies
  below the first); `moq` is information. Edited in the Library under **Cost**; `validateDb` checks it.
- **Engineering settings, Costing**: the hub's `currency` and a `labourRatePerHour`. They are part of
  `data/settings/engineering.json` (`costing`).
- A design records `labourMinutes` (hand labour for one cable; the model has no per-operation times, so it is
  one figure per design; edited at the foot of the notes panel).
- The **BOM** (sheet, markdown, `bom.csv`, the XLSX) gains unit and extended cost per line, a Cost section
  with materials, labour and the total for one cable, and, for a **build quantity** (the field beside the BOM,
  `?quantity=N` on the API), the total for the build with quantity breaks read at line quantity x N.
- Nothing is printed when no part is priced and no labour recorded. A part with no price is listed as
  unpriced and the total says it is a floor. Prices in another currency than the hub's are shown but left out
  of the total (there are no exchange rates). Labour with no rate is shown but not priced.
- A module may supply live pricing by writing `cost` on records; `deriveCost` (`@wirehub/docs`) is pure.
