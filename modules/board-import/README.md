# Board import

Bring a PCBA into WireHub from its open fabrication files, whatever shop made it.
Three importers over the module importer contract (`docs/modules.md`), and a page
that is their review step:

| Importer | Reads | Proposes |
| --- | --- | --- |
| `kicad-board` | a KiCad `.kicad_pcb` (or its `.net` netlist) | the PCBA: terminals with their pads, internal links, integrated connectors; `kicad`-tier art (outline and pads) with anchors; with `parts: yes`, also one component per distinct footprint part and the board's placed parts |
| `gerbers` | a Gerber set `.zip` (RS-274X/X2 and Excellon) | `gerber`-tier art: top and bottom, sanitised SVG, anchored on the board's pads |
| `fab-bom` | a fab BOM and/or placement (CPL) `.csv`, or both in a `.board-bom.json` | one component record per distinct part, and the board's placed parts (`data/board-parts.json`) |

Every import is a proposal. The studio runs it as a job, shows the plan (the art is
previewed) and publishes it as one change set; a record the Library already has is
kept, never overwritten. The page is `/m/board-import/boards` (Library › **Import** › Board import);
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
`build`, `connectors` (JSON, footprint reference → connector id), `art` (`no`) and `parts`
(`yes`: also propose components and placed parts from the footprints);
`gerbers` and `fab-bom` take `board`; `fab-bom` takes `mapping` (JSON,
`{ "bom": { "refs": "Designator" }, "cpl": { "x": "Mid X" } }`).

**Parts from the footprints.** For a board with no fab BOM, `parts: yes` reads each
footprint as a BOM line: its value, its library id as the footprint, its `MPN`,
`Manufacturer` and supplier-number properties (named as a BOM column is), `dnp` and
`exclude_from_bom`; a board-only footprint (a fiducial, a mounting hole) is left out. The
identity rules are the fab BOM's (MPN, else supplier number, else category + value +
package; a part the Library has is reused), and the parts are placed with their side.
Importing the fab BOM later replaces that list with the board house's own.

**3D model.** After a board is published, the page attaches its `.kicad_pcb` as the
board's 3D model source (`POST /api/models/pcbas/:id/upload`). The studio keeps the file
in the catalog and its `model-cache` job builds the model, fetching the KiCad library
models the footprints name from kicad-packages3D at a pinned commit. Those models are
CC-BY-SA 4.0 (with the KiCad libraries exception): they are fetched into the model cache,
never committed or shipped.

A board with Gerber-tier art also shows it on the model: the art's `board-top.svg` and
`board-bottom.svg` are among the model link's source files (the link is re-keyed when
the Gerbers are imported after the model, or picked up when the model is attached after
them), and the `model-cache` job paints them as textures on the board body, inside the
same memory-capped conversion child (one raster at a time).

**Gerber and Excellon coverage.** Apertures C/R/O/P and macros (primitives 1, 2, 4, 5, 7,
20, 21, 22; inch files too), regions, arcs, polarity, step-and-repeat (`%SR`), aperture
mirror/rotate/scale (`%LM`, `%LR`, `%LS`: flashes only, as the spec says), and Excellon
drills with routed slots (G85, or G00/M15/G01/M16 routs; routed arcs are drawn straight).

Zero dependencies: the S-expression, Gerber, Excellon, ZIP and CSV readers are in
`src/`. Tests use a synthetic board written in `test/synthetic.ts`.

Code: MIT. Everything in the tests is synthetic (CC0).
