# Mass

A library record may say what it weighs; a design's mass is derived from that, per BOM line and for
one unit. Nothing is required: a part without a mass is unknown, and every unknown is listed, never
counted as zero.

## On records

Stored in grams only (the unit typed is not kept):

```jsonc
// connectors, connector bodies, components, PCBAs, mechanicals: one piece
"mass": { "g": 8.2, "src": "vendor datasheet weight" }
// wire stocks: per metre
"massPerLength": { "gPerM": 32.74, "src": "datasheet 22 lb/kft" }
```

- `g` / `gPerM` is a finite number, 0 to 1e9; an explicit `0` is a value. `src` is optional; no other
  keys. `mass` on a wire stock, `massPerLength` on anything else, or either on a kit or an interface is
  an error (`record-mass`, from `validateDb`; a `PUT /api/definitions/:kind/:id` refuses it).
- A connector's own `mass` wins over its body's. A board's integrated connectors are inside the
  board's mass (as in the BOM). Kits are not BOM lines and tools are never consumed, so neither counts.
- The Library editors (connector, component, board, mechanical, wire stock) have a **Mass** section: a
  number in g, kg, oz or lb (a stock: per m, km, ft or kft), converted to grams as it is typed.
  `@wirehub/model` `mass.ts` has the factors (`MASS_UNIT_GRAMS`, the same as inventory's;
  `PER_LENGTH_METRES`) and `toGrams`, `toGramsPerMetre`, `fromGrams` (six decimals).
- A saved revision freezes the records it uses, masses included: its derived mass never changes when a
  record is edited later. Record masses are in `GET /api/db`, `GET /api/export` and the frozen
  definitions of `GET /api/designs/:id/versions/:rev`.

## Derived

`deriveMass(design, db, { explode? })` (`@wirehub/docs`, pure) follows `deriveBom`'s lines exactly:
supplied-terminated ends, integrated board connectors, pass-through runs (weighed with their trunk's cut)
and one contact, seal or plug per cavity.

- A line is **exact** when every input is known, a **floor** (`≥`, g = the known part) when something
  is missing but something is known (a wire: the runs with a length, the others named), **unknown**
  (g `null`) otherwise.
- The total is exact when every line is, a floor when any line has a figure, unknown when none does. An
  empty BOM weighs exactly 0.
- A sub-assembly line weighs the placed design's own total at its pinned revision × quantity. With
  `explode` that line goes and the placed design's parts count instead, never both: the total is the same.
- Missing inputs, each `{ reason, record, instances, line?, detail? }`: `no-mass`, `no-length` (the
  runs), `no-definition`, `subassembly` (the placed design lacks something, or could not be opened).

### `mass.json`

`GET /api/designs/:id/exports/mass.json?rev=&explode=1` (also the Documents **Export…** menu and the
render CLI):

```json
{ "format": "wirehub.mass", "version": 1, "unit": "g",
  "design": { "id": "lead-a", "label": "…", "productRef": "…", "rev": 3 },
  "explode": false,
  "total": { "g": 182.4, "bound": "floor" },
  "lines": [
    { "key": "wire|stock-a|trunk|1830", "category": "wire", "ref": "stock-a", "label": "…", "partNumber": "…",
      "qty": 1, "instances": ["w1"], "lengthMm": 1830, "rate": { "gPerM": 21.5, "from": "wires/stock-a" },
      "g": 39.345, "bound": "exact" },
    { "key": "connector|plug-a|source", "category": "connector", "ref": "plug-a", "qty": 2, "instances": ["j1","j2"],
      "rate": { "gEach": 8.2, "from": "bodies/body-a" }, "g": 16.4, "bound": "exact" },
    { "key": "pcba|board-a", "category": "pcba", "ref": "board-a", "qty": 1, "instances": ["u1"],
      "rate": null, "g": null, "bound": "unknown",
      "missing": [{ "reason": "no-mass", "record": "pcbas/board-a", "instances": ["u1"] }] },
    { "key": "subassembly|lead-b|2|lead", "category": "subassembly", "ref": "lead-b", "qty": 2, "instances": ["s1","s2"],
      "rate": { "gEach": 40.1, "bound": "floor", "from": "designs/lead-b@2" }, "g": 80.2, "bound": "floor",
      "missing": [{ "reason": "subassembly", "record": "designs/lead-b@2", "instances": ["s1","s2"], "detail": "1 line without a mass inside it" }] }
  ],
  "missing": [ "…every line's missing entries, each with line: <key>…" ] }
```

Synthetic example. `key` is the BOM line's key; `record` is `<kind>/<id>`, `designs/<id>@<rev>` (or
`designs/<id>` for a working copy). `design.rev` is absent for the working copy, `design.productRef` when the
design has no product part number. Deterministic: fixed key order, two-space indent, trailing newline, grams to six decimals.

### BOM sheet and CSV

When at least one line has a known rate (a sub-assembly: a non-null mass), the BOM sheet (HTML, SVG,
PDF, markdown) gains a **Mass** column and a closing line, `Mass, one unit: ≥ 182.4 g — without a mass: …`;
`bom.csv` and the XLSX gain `mass_each_g, mass_per_m_g, mass_g, mass_bound` after the cost columns and a
closing `Mass` row (`docs/exports.md`). A length family's trunk rows are weighed at their variation's
length; the Mass row is the design's own total. Without any mass, every output is byte-identical to before.

## Measured beside derived

Inventory batches record `measured.unitMassG` (`docs/inventory.md`). The build view
(`GET /api/inventory/builds/:design?rev=`) adds `massEstimate: { g, bound, missing }` for one unit, and
`GET /api/inventory/batches` adds `massEstimate: { g, bound }` beside every batch that has a measured
unit mass (a design build at the batch's revision, else the working copy; a printed part by its record's
`mass`). The batch list shows both: `405.1 g measured · ≥ 398 g derived`. The measured figure is never
changed and never goes into an export.
