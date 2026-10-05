# Drawing language

How WireHub draws a cable today, and where a catalog pack or a module may supply its own
art. This is the generic spec: every example is from the starter catalog or a bundled
domain pack. It describes the code (`packages/layout`, `packages/render-svg`,
`packages/docs/src/drawing`, `packages/editor-react`); when SPEC.md disagrees, SPEC wins.

Three outputs share one vocabulary:

| Output | Package | What it is |
| --- | --- | --- |
| Schematic | `layout` (geometry) + `render-svg` (paint) | the whole cable as blocks, bands and wires, on screen and as SVG |
| Canvas | `editor-react` | the same geometry, interactive |
| Drawing sheet | `docs/src/drawing` | the ANSI A engineering sheet: title block, BOM, cutaway, faces, cable |

Everything is **presentation, not truth** (`model` owns truth): no drawing changes what a
cable is, and a part with no art draws as an abstract block. Nothing here reads a clock,
the network or a random number: identical input gives identical bytes.

## 1. Units and coordinates

- The schematic is in millimetres of page, +y down, one `Diagram` of positioned
  `blocks`, `bands`, `edges` (wires), `jointDots`, `cutEnds`, `notes` (`layout/src/model.ts`) which `render-svg` paints.
  Layout names colours, never paints; the renderer owns paint.
- Connector art is in its own pixel frame (the canvas's CSS px) and is placed at a block's
  art rect with one scale. Depictions are in artwork units; `mmPerUnit` converts.
- The drawing sheet is PostScript points (1/72 in) on 792 x 612 (ANSI A landscape).

## 2. Connector faces

A connector is drawn as itself in one of two views:

- **Mating face**: the face a builder sees when plugging the part in, long axis vertical on
  the canvas, with a handle on every pin (D-sub, mini-DIN, DIN, and any family a pack
  draws).
- **Side profile**: strain relief, grip and the business end, with solder lugs at the
  cable end carrying the handles (RCA, 3.5 mm TRS, BNC). A profile mirrors with the side
  the wire leaves from.

The drawing belongs to the **body** (the physical part, `ConnectorBody`), not the pinout:
every interface on one body draws the same, and the connector only relabels the pins. Art
is chosen in this order, first hit wins:

1. a **depiction** (section 7) filed under the connector id, its body id or the body's
   `drawing` name, with an anchor for every used pin;
2. **drawn art**: a registered connector drawing (section 7) matching the body, its
   `drawing` name or its family, then the base's built-in drawings (D-sub, HD15, mini-DIN,
   DIN, RCA, TRS, BNC);
3. the abstract block: a pin table.

A drawing that has no place for a pin the connector has returns nothing, so the block
keeps its table rather than showing a face that lies. Pin shapes (`pin`, `socket`,
`blade`, `finger`, `lug`, `shell`) and paint **tones** (`shell`, `insert`, `hole`, `metal`,
`boot`, `grip`, `knurl`, `band`, `copper`, `dark`, `key`, `flange`) are the shared
vocabulary; the canvas maps tones to theme tokens, the schematic to print paint. On the
schematic a pin a wire lands on prints solid, an unused pin hollow. Drawings that follow a
family's general shape rather than a mechanical drawing say `approximate` and the caption
says so.

Numbering follows the standards' convention (D-sub: long row 1..n left to right, short row
after it; a socket face is its plug mirrored). A solder-side view is the mating face
mirrored left to right; it is never hand-anchored (the tool reflects the one anchor set).

## 3. Cutaways and cross-sections

- **Cross-section** (`layout/src/cross-section.ts`): the cable end-on from the stock's
  element tree. Each element contributes one ring whose outer radius is its own diameter;
  ring cores sit on a pitch circle in the stock's catalogued `layOrder` (first at 12
  o'clock, direction as declared); a drain sits in the widest gap against the shield; a
  figure-8 draws two legs and a web. No wall thickness is invented.
- **End faces** (`end-face.ts`): the cut end as the builder reads it, ring read the other
  way round at the far end.
- **Cutaway** (drawing sheet, `docs/src/drawing/cutaway.ts`): one core pulled out of the
  bundle and stepped down layer by layer (conductor, insulation, shield, sheath), the cut
  face with cores in lay order, the overall foil, the jacket with its marking, each layer
  called out with a leader. It is a picture, not a dimensioned view: heights step evenly.
  A stock may have supplied art instead (section 6).
- Bonded screens (spiral shields, foil and drain on one copper mass) are called out once,
  as that mass; an overall foil is drawn but not called out when it is trimmed at every end.

## 4. Breakouts

A breakout (a mould or overmould where a trunk splits into legs; SPEC "Breakouts") draws
as a **mould** outline on the trunk's end with its legs running out to their plugs. A
connector the mould houses is drawn inside it as itself, its opening facing the way the legs
run. Legs reuse the connector art rules of section 2; the mould widens to fit the housed
connector's drawing.

## 5. Labels and sheet layout

- **Schematic**: sources in the left column, destinations in the right, the trunk as a
  band in the middle carrying its cross-section; branches as further bands. Wires run in
  lanes (`lanes.ts`, `tracks.ts`) with an order chosen to minimise crossings
  (`track-order.ts`); detours keep a wire clear of other blocks. Each block has a header
  (definition label, family and gender), ports (pin id, label), footnotes ("pins not
  used: ...") and numbered notes; edges name conductors by colour and role. Shield pigtails and
  bonds fold into one representative (`bond-fold.ts`).
- **Drawing sheet**: frame, then (top to bottom) the BOM table and cutaway, the cable with
  a **solder-side face** at each end (the same face seen from behind) and length callouts,
  the wire table, numbered remarks, and the title block (title, part number, revision,
  material, designer, date, size, scale, sheet). A secondary plug is a side view on its
  lead pointing away from the cable. Where a face's geometry is approximate the sheet prints
  "Approx. outline" under it and lists a caveat. A connector nobody has drawn gets a
  numbered pin grid, never nothing.
- Pin colours on a face come from what lands on each pin; unused pins draw empty.

## 6. Sheet art and the title block

The sheet reads faces and cutaways in this order:

1. art registered with `registerDrawingArt` (`docs/src/drawing/assets.ts`): traced faces and
   side-view plugs by connector id (`<id>-ra` for a 90 degree version), cutaway art by stock
   id, and the title block's **logo** and **fixed text** (the general note, the tolerance
   table, the size cell);
2. a **depiction** from the registered source: a connector's `solder-side` SVG becomes its
   face (`depiction-art.ts`), a stock's `illustration` becomes its cutaway;
3. geometry drawn from the definitions (`drawn-faces.ts`, `cutaway.ts`);
4. the generic pin grid.

With nothing registered the sheet is exactly what the base draws. A depiction face is
scaled so the two closest pins are about 13 pt apart. Pin elements are SVG shapes with a
`data-pin` attribute; anything in the SVG outside absolute `M L H V Z` paths, rects,
circles and text is ignored.

## 7. Extension points: where a pack or module supplies art

A pack is **data**; art is files in its directory, in three kinds. Nothing in the base
knows a domain's connectors: the SCART and JP21 faces live in `modules/av-video`.

| Kind | Where | Read by |
| --- | --- | --- |
| **Depiction** (SVG + anchors) | `depictions/<id>/meta.json` and `<view>.svg`, `<id>` a connector id, a body id or a wire stock id | layout (schematic), the drawing sheet, the Library |
| **Connector drawing** (shapes + pins as data) | `art/connectors/<id>.json` | the canvas, the schematic, the moulds, the builder |
| **Body layout** | `art/body-layouts.json` | the connector builder's "new body" picker |
| Sheet art (logo, text, traced faces) | a module's `art.drawing` | the drawing sheet |
| Work instructions | `registerBenchSteps` (section 8) | the build sheet |

**Depictions** are the existing artwork mechanism (`packages/catalog/src/depictions`):
`views` (`mating-face`, its mirror `solder-side`, `illustration`, ...), one `pinAnchors`
set in the `anchorFrame`, mm-true with `mmPerUnit`, validated against the catalog
(`validateDepiction`: an anchor must name a pin or body position; a position with no anchor
is a warning because an instance that uses it falls back to the abstract block). A body's
art serves every connector built on it; anchors are the body's position ids. The base's own
tree is `packages/catalog/depictions/`; a pack's is `<pack>/depictions/`; sources layer
with `layeredDepictions(...)`, a catalog's own first.

**Connector drawings** (`ConnectorArtRecord`, `packages/catalog/src/art.ts`): `id`, which
`bodies`, `drawings` (a body's `drawing` name) and `families` it draws, `short` (caption),
frame `width`/`height`, `shapes` (`path`, `circle`, `rect`, each with a `tone`), `pins`
(`terminal`, `form`, centre, size, `ifDefined` for a contact a pinout may omit), `labels`,
`approximate` and `src`. Host registers them with `registerConnectorArt`
(`layout/src/connector-art.ts`); a pack match wins over a built-in drawing, and nothing
registered means the base alone.

**Body layouts** (`BodyLayoutRecord`): family, picker label, id stem, the `drawing` name
the new body carries and its positions; the builder offers them after its built-ins
(`registerBodyLayouts`).

**Module contract.** A module sets `art: { connectors, bodyLayouts, drawing }` (all data,
typed opaque in `@wirehub/modules`); the host (`apps/studio/module-art.ts`) validates every
record, registers it at start in the browser and on the server, and refuses a bad record
with one sentence per problem. Art is keyed by body, drawing name or family, so it is inert
in a catalog that has none of them.

**Rules for shipped art.** Every file is CC0-1.0 and carries a `src` stating where its
numbers came from (a public standard, a datasheet, a measurement, or "inferred"). Nothing
is traced from a vendor drawing or from a private repository. Monochrome (`currentColor`),
mm-true, no scripts, no external references (`href` other than `#`/`data:` is dropped on
inlining), deterministic. The starter faces are generated by
`packages/catalog/scripts/face-art.ts`, which `test/face-art.test.ts` holds the committed
files to, including that every pin element sits on its anchor and every anchor is a position
of its body.

**Not yet.** An installed (runtime) pack's SVG files: `installPackLayer` copies `.json`
files only, and the browser bundle reads the bundled modules' `pack/depictions/` at build
time. Profile (side-view) drawings as data need a facing-aware record. Both are tracked in
beads.

## 8. Bench work instructions

`registerBenchSteps(provider)` (`docs/src/bench/standard-work.ts`) lets a deployment supply
its own written instructions per phase: `prep(wire, bonded)`, `end(end, db, other)`,
`assembly(design, db, end, shells, trunk)`, the `solder` step and the `qa` list. A hook
returns steps, or `undefined` to leave the generic ones (common cable-prep and soldering
practice, each step citing its source). The first provider with an answer wins; a provider
sees the stock, the end's terminations and the shells, so instructions can differ per
family or termination.
