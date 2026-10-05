# Formboard drawing

The cable laid flat, at true length, the way a harness shop builds it on a board: runs,
branch angles, pegs, connector positions and wire-label positions, printed at 1:1 or a stated
scale and tiled across sheets of paper with registration marks. The generic spec of
`packages/docs/src/formboard.ts`, rendered by `/api/designs/:id/documents/formboard` and the
Documents view. Conventions (units, determinism, presentation-not-truth) are those of
`specs/drawing-language.md`.

The formboard is **derived**: it reads the design (segments, their lengths, breakouts, joints,
mechanical parts) and the definitions, adds nothing to the model, and changes nothing in it.
Where the model has no fact (a mould's size, a sleeve's length, a branch angle) the sheet uses
a documented fixed value and says so.

## 1. Geometry

`deriveFormboard(design, db, { variation?, drawing? })` returns a `Formboard` in board
millimetres, +y down, with the board's top-left corner at (0, 0) and a 40 mm margin round
everything drawn.

- **Runs.** Every wire segment is a straight line of its `lengthMm`. The trunk
  (`trunkSegment`) starts at the board's left and runs along +x; its end not in a breakout is
  the start.
- **Branches.** At a breakout, the other members (legs, or the trunk when the walk arrived on a
  leg) leave the breakout point fanned about the direction of travel, `BRANCH_STEP_DEG` (30
  degrees) apart: two legs at plus and minus 15 degrees, three at minus 30, 0 and plus 30. A
  leg that is the trunk of another breakout fans again from its far end, so a design with
  nested breakouts lays out as a tree. The angle each run makes with the run it branches
  from is on the sheet.
- **True length.** Each run's two ends are exactly `lengthMm` apart. The breakout point is the
  end of every member's run: the model does not say how much of a run lies inside the mould, so
  the length is measured end to end as the cut list does.
- **Missing length.** A segment with no `lengthMm` is drawn `NOMINAL_LENGTH_MM` (200 mm),
  dashed, its dimension marked `~`, and a note says so. It is never silently exact.
- **Variations.** With a length family, `variation` cuts the trunk to that variation's length
  (the drawing sidecar's `lengths`); legs keep their own.
- **Separate runs.** A segment not reachable from the trunk is drawn as its own tree below the
  main board, with a note.
- **Supplied runs.** A run the contract manufacturer delivers terminated is drawn (the board
  shows where it sits) with a note that it arrives made.

## 2. What is marked

| Mark | Source | Where |
| --- | --- | --- |
| Run, with its dimension line and `Wn · stock` | segments, `deriveLabels` designations | the line; the dimension line sits 7 mm of paper to its left |
| **Peg** `P1`, `P2` ... | one per free end and one per breakout, numbered in drawing order | at the end point or breakout point; coordinates are listed on the overview, in mm from the board corner |
| **Connector** glyph and name | the instances joined to a free end by a joint (connectors, boards, components) | beyond the end, outward along the run; label is the connector's `label` or its id in capitals, and the definition's name |
| **Mould** glyph | a breakout's mechanical part | at the breakout point, named after the part (or the breakout's role) and any housed connectors |
| **Label marker** `W1-A` | `deriveLabels`: one per end of every run | a tick across the run at the label's `offsetMm` from that end |
| **Sleeve** or **tape** | a mechanical instance with `attachedTo` a connector whose definition names heat-shrink, a sleeve or tape | a band along the run from that connector's end, the length the part's name gives ("40 mm long") else 25 mm and a note |

**Captions keep clear.** Every caption (a peg's name, a label tick's name, a connector's name and
definition, a mould's name) has a home place, and keeps it unless something is already there: the
glyphs, pegs, ticks, runs, dimension lines, the run names and angle texts, and the captions placed
before it. Then it takes the first free spot of a fixed list (pegs: the other corners round the peg;
ticks: slid along the run, then across it; connector names: pushed away from the glyph, slid out,
flipped to its other side; moulds: lifted, or put under the glyph), judged on the face's real glyph
widths (`formboard-labels.ts`). A caption with no free spot keeps its home place. A caption that a
tile's edge would cut, whose anchor is on that tile, is pulled inside the tile when it fits whole, so a
long name at a join (the mould's) reads whole on both neighbouring tiles. Placement depends on the
geometry only, so it is deterministic and the same on every tile.

Glyphs (connector, mould, sleeve) are fixed-size symbols, scaled with the board but not to the
part, and the sheet says so. Lengths and angles are the truth of the drawing.

The model does not carry where a tape wrap or a sleeve sits other than by `attachedTo`, so a
sleeve not attached to a connector is not drawn. Adding positions to the model is a separate,
additive change.

## 3. Pages

Paper is A4 or US letter, landscape, in millimetres, a 12 mm margin and a footer line. The sheet
is a set of pages:

- **Overview** (page 0): the whole board fitted to one sheet (its scale is printed), with the
  runs table (designation, stock, length, angle from its parent), the peg table with
  coordinates, the notes, and a **tile map** drawn over the board naming each page.
- **Tiles** (pages 1 to N, row-major): the board at the chosen **scale** (`1` is 1:1, `0.5` is
  1:2; any value from 1:100 to 10:1; the Documents view offers 1:1, 1:2, 1:4, 1:5 and 1:10).
  A tile's printable area is the paper less margin and footer. Neighbours overlap by
  `TILE_OVERLAP_MM` (10 mm) of paper. Every tile carries:
  - four **registration marks** (a circle and cross) at the corners of its cell, each labelled
    with its board coordinates; a neighbour's marks sit on the same coordinates, so butting or
    overlaying two sheets and matching the marks aligns them;
  - the page number, its column and row, and the pages it joins;
  - a **print check**: a bar that must measure exactly 100 mm on paper, so a print that was
    scaled by the printer driver is caught before it is used.
- The board is padded by 10 mm of paper on every side of the tiling so dimension lines and
  labels near its edge stay on the sheet. Below 1:3 the tiles draw compactly (names and
  label ticks dropped), because text does not shrink with the scale.

A board that fits one sheet at the chosen scale has one tile.

## 4. Outputs

`GET /api/designs/:id/documents/formboard?format=svg|pdf|html&scale=&paper=&page=&variation=&rev=`

| `format` | Answer |
| --- | --- |
| `svg` (default) | the overview; with `page=n`, tile n (a page past the last is `400`, naming how many there are) |
| `pdf` | every page, overview first, one rasterised image per page at 150 dpi in the paper's size |
| `html` | every page in one self-contained document, page-broken, `@page` sized (also the Documents view) |

`scale` is a number (`0.5`) or a ratio (`1:2`); anything else is `400`. `rev` and `variation`
work as for the other documents, and the working copy is a document like any other. The CLI is
`pnpm --filter studio render <design> formboard [--scale 1:2] [--page n]`, and `all` includes it.

The functions are pure and exported from `@wirehub/docs`: `deriveFormboard`, `formboardLayout`,
`formboardSvg(board, page, options)`, `formboardSvgPages`, `formboardHtml`, `parseScale`.

## 5. Tests

`packages/docs/test/formboard.test.ts`: true lengths, symmetric fans for two and three legs,
nested breakouts, missing lengths, sleeves, peg numbering, variation, the tiling cover rule,
registration-mark agreement between neighbours, paper sizes, determinism and a smoke test over
every starter design; `formboard-labels.test.ts`: the collision geometry and, on every tile of the Y
splitter at 1:1 and 1:2, that no caption sits on a glyph, peg, tick or another caption; goldens under `packages/docs/test/__golden__/` for the Y splitter
(`dc-y-splitter`): the overview, the tile that holds the breakout at 1:1, and the whole board
on one sheet at 1:10. A change to the drawing is a visible diff in those files.
