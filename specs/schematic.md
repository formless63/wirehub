# Schematic

The visual language of WireHub's wiring schematic: what each mark means and the rules the
layout follows. The generic spec of `packages/layout` (geometry, `layoutSchematic`) and
`packages/render-svg` (paint, `renderSchematic`); the Schematic view in
`packages/editor-react/src/panels/Schematic.tsx` shows the same SVG. Connector faces and the
drawing sheet are in `specs/drawing-language.md`; artwork in `specs/depictions.md`. Examples
are the starter catalog's.

The schematic is **presentation, not truth**. It draws what `deriveNets`, the stocks and the
joints say, and a part with no art draws as an abstract block. Nothing in it is a source of
electrical fact. It is deterministic: identical input gives identical bytes, no clock, no
randomness, no external resource (no `<image>` link, no `<foreignObject>`, no web font).

## 1. Principles

1. **Left to right is source to destination.** End `a` (the source side) on the left, end `b`
   on the right, the wire bundle as the hero between them. A header banner says so: `end a ·
   source - <label>` on the left, `<label> - destination · end b` on the right.
2. **Colour is additive.** Every track, port and symbol also carries a text label, so a
   monochrome laser print loses only the convenience of picking the red core at a glance. A
   pale conductor (white, yellow) gets a neutral halo so it survives white paper.
3. **Millimetres of paper.** One unit is one millimetre of the printed sheet, origin top-left,
   +y down. Type sizes and spacings (`METRICS`) are the real sizes; layout and renderer read
   the same numbers, so reserved space matches drawn text.
4. **Layout names colours, never paints.** A track carries the catalog's colour *name*; the
   renderer maps it to print-safe paint (`conductorPaint`, `INK`). Layout knows no hex value.
5. **Never lie.** A depicted block whose artwork cannot carry every used pin falls back to
   the abstract block (section 4); a wire is never drawn to a pin that is not there.

## 2. What is drawn

| Element | Drawn as |
| --- | --- |
| Connector, board | a **block**: header (definition label, family and gender), ports (pin id, label), `pins not used:` footnotes. A connector with a drawing draws as itself (mating face or side profile), ports on its pins |
| Wire stock, one segment | a **band**: a jacket outline holding one **track** per electrical element, the stock label and length above it |
| Conductor | a solid track in the conductor's colour, labelled once |
| Core shield | a thin dashed track |
| Overall shield | a heavier, longer-dashed track (keyed only when the sheet has one) |
| Drain | a dash-dot track in bare-copper brown |
| Coax, shielded core | its centre and shield tracks bracketed and labelled as one group |
| Pigtail | a bracket gathering the member tracks at the band end and one lead to its landing |
| Joint | a thin orthogonal **edge** between two ports, with a **filled dot** on each terminal at least one joint lands on (heavier when three or more share it) |
| Deliberate cut end | a small cut glyph (an NC fate or a floating end a design note explains), with a footnote number |
| Discrete component | an IEC-style symbol (resistor, capacitor, polarised capacitor, generic box) sitting on its path, labelled `r1 · 150 Ω` |
| PCBA internal link | a thin dashed line inside the block, with an annotation |
| Breakout | a mould outline over the trunk's end, legs running out to their plugs (section 6) |
| Cross-section | the trunk stock's cutaway as an inset under the trunk column |
| Design notes | numbered footnotes; a note that names a terminal prints its number at that terminal |

The legend under the banner keys the line styles: conductor (colour = core), core shield,
overall shield (only when drawn), drain (bare), joint, PCBA internal link, deliberate cut end.

## 3. Layout

`layoutSchematic(design, db)` returns one `Diagram`: `blocks`, `bands`, `components`, `edges`,
`jointDots`, `cutEnds`, `notes`, an optional `crossSection`, `breakouts`, the `anchors` by
terminal key, a `depictions` diagnostic per block and the validator's `issues`. It is a pure
function of the design and its definitions.

- **Columns.** The trunk and the connectors on its `a` side (zone `source`) on the left, the
  `b` side (zone `dest`) on the right; branch legs as further bands below the trunk (zone
  `branch`).
- **One anchor per terminal.** A joint is routed between two anchors (`Anchor`: key, point,
  direction a wire leaves in, owner). Every dot sits on an anchor.
- **Track order.** Tracks inside a band are ordered to minimise crossings
  (`optimiseTrackOrder`, `track-order.ts`), from the landings of each track.
- **Routes.** Orthogonal. Each run crosses the corridors between columns on vertical *lanes*
  chosen per corridor for all the runs in it at once (`lanes.ts`, `tracks.ts`), so their order
  is the crossing-free one. Detours (`detours.ts`) keep a wire clear of blocks and components
  it does not belong to, with `MAX_DETOUR_PASSES` bounded and routes separated so parallel
  runs do not overlap.
- **Footnotes.** A block's unused pins and pads, and deliberate cut ends, are footnotes under
  the block; design notes are numbered from 1 in the order they are written, and the notes
  column goes beside the cross-section when there is room (`notesBesideMin`).
- **Bonded screens fold.** One representative track per bonded mass, no foil
  (`specs/shield-bonding.md` section 5).
- **Page size** follows the content; nothing is scaled to fit.

## 4. Blocks and artwork

A block is one of three, tried in order:

1. **Depicted**: a depiction (`specs/depictions.md`) resolved with an anchor for every used
   pin; ports sit on the true pad positions and their text parks in a gutter tied back by a
   leader. A two-faced board draws both faces stacked.
2. **Drawn connector**: the shared connector art, ports on its pins, each pin's row on the
   block's cable edge with the wire running on to the pin.
3. **Abstract block**: a pin table. Always correct.

`Diagram.depictions` records, for every block when depictions are on, why it is what it is:
`drawn`, `no-depiction`, `no-usable-view`, `unreadable-asset`, `unanchored-pin` or
`crowded-anchors`. Only the cases that are genuinely wrong (artwork exists but cannot be used)
also raise an issue. `renderSchematic(design, db, { depictions: false })` draws every block
abstract, byte for byte as it drew before art existed; the headless route retries that way
when a render with art throws.

## 5. Reading a drawing

- Trace: clicking a track, port or joint in the Schematic view highlights its galvanic net
  (`DiagramPort.net`, `DiagramTrack.net`); the view pans (drag, arrows), zooms (wheel, + / -),
  fits (0) and copies the sheet's text.
- Every pin label, pad name and note is in the SVG as text.
- Nothing on the sheet is editable; it is derived. Edits happen on the canvas.

## 6. Breakouts

A breakout on the trunk draws as a **mould** outline reaching back over the trunk band's end
(`breakoutInset`) and past its pigtail slots (`breakoutPad`). Each trunk element shows its
fate at the mould: `through` runs straight across and out on its leg; `terminated` ends on a
solder dot inside the mould; `nc` is cut back with its reason as a footnote. A connector the
mould houses (a jack inset in it) draws inside the outline as itself, its opening facing the
way the legs run (`DiagramMouldJack`). Starter example: `dc-y-splitter`.

## 7. Tests

`packages/render-svg/test/golden.test.ts` holds a golden SVG per starter design;
`determinism.test.ts` renders twice and compares bytes; `audit.ts` checks that no text
overlaps a block, label or another run and that the output carries no external reference.
A change to layout or paint that alters a golden is a visible diff to review, not a silent
regression.
