# Board import

Bring a PCBA into WireHub from its open fabrication files, whatever shop made it.
Three importers over the module importer contract (`docs/modules.md`), and a page
that is their review step:

| Importer | Reads | Proposes |
| --- | --- | --- |
| `kicad-board` | a KiCad `.kicad_pcb` (or its `.net` netlist) | the PCBA: terminals with their pads, internal links, integrated connectors; `kicad`-tier art (outline and pads) with anchors |
| `gerbers` | a Gerber set `.zip` (RS-274X/X2 and Excellon) | `gerber`-tier art: top and bottom, sanitised SVG, anchored on the board's pads |
| `fab-bom` | a fab BOM and/or placement (CPL) `.csv`, or both in a `.board-bom.json` | one component record per distinct part, and the board's placed parts (`data/board-parts.json`) |

Every import is a proposal. The studio runs it as a job, shows the plan (the art is
previewed) and publishes it as one change set; a record the Library already has is
kept, never overwritten. The page is `/m/board-import/boards` (rail: **Board import**);
the Library's **Import…** offers the same importers without the review options.

**Order.** Import the `.kicad_pcb` first: it makes the board and records where each
terminal's pads are. The Gerber art is framed on the board outline, so it lines up with
those pads whatever origin the plot used, and its anchors come from them. A BOM or
placement file names the board it belongs to with the `board` option, or by its file
name.

**How terminals and links are found** (`src/derive.ts`): a footprint whose pads are all
on one net is a landing — one terminal, named by its value (`GND`, `A`), else its net,
else its reference; equal names on one net collapse into one terminal with several pads.
A connector footprint's pads are `<ref>.<pad>`, or the pins of a Library connector named
in the review step. Nets are joined by fitted two-net parts (at most two in series, never
through a power or ground net); a capacitor-only path to a plane is decoupling and is
left out; parts with more than two nets are black boxes. Every record says it is inferred
and asks for review.

**Options** (text): `kicad-board` takes `id`, `label`, `partNumber`, `revision`,
`build`, `connectors` (JSON, footprint reference → connector id) and `art` (`no`);
`gerbers` and `fab-bom` take `board`; `fab-bom` takes `mapping` (JSON,
`{ "bom": { "refs": "Designator" }, "cpl": { "x": "Mid X" } }`).

**3D model.** After a board is published, the page attaches its `.kicad_pcb` as the
board's 3D model source (`POST /api/models/pcbas/:id/upload`). The studio keeps the file
in the catalog and its `model-cache` job builds the model, fetching the KiCad library
models the footprints name from kicad-packages3D at a pinned commit. Those models are
CC-BY-SA 4.0 (with the KiCad libraries exception): they are fetched into the model cache,
never committed or shipped.

Zero dependencies: the S-expression, Gerber, Excellon, ZIP and CSV readers are in
`src/`. Tests use a synthetic board written in `test/synthetic.ts`.

Code: MIT. Everything in the tests is synthetic (CC0).
