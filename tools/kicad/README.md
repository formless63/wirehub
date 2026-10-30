# Tool pack `kicad`

KiCad 10.0.6 (`kicad/kicad:10.0.6`, pinned by digest) with a small Python entry
script. Image: `wirehub-tool-kicad:10.0.6-7`.

    docker build -t wirehub-tool-kicad:10.0.6-7 tools/kicad

| op | outputs (role) |
|---|---|
| `board-render` | `board-top.svg` / `board-bottom.svg` (`board-top-svg`, `board-bottom-svg`; `pcb export svg`, the bottom mirrored), `render-top.png` / `render-bottom.png` (`render-top`, `render-bottom`; `pcb render`). Params: `png` (default true), `width`, `height`. |
| `board-3d` | `board.step` (`model-step`), `board.glb` (`model-glb`). Params: `formats` (default `["step","glb"]`). |
| `netlist` | `nets.json` (`nets`): every footprint's pads and the net each is on, from the board (pcbnew), and — when `.kicad_sch` inputs are given — every schematic part's pins and nets (`sch export netlist`), plus the raw `schematic.xml` (`schematic-netlist`, kicadxml). The root sheet is the one no other sheet names. It compares nothing; the studio sets it beside the board record (`modules/board-import/src/disagree.ts`). |
| `fab` | `fab-gerbers.zip` (Gerbers + Excellon drill + drill map, fixed zip timestamps), `fab-positions.csv` (both sides, mm), `fab-bom.csv` (grouped by value + footprint, read from the board, not a schematic). Params: `bom` (default true). |

The image ships KiCad's symbol and footprint libraries plus a **pinned subset of
kicad-packages3D** (the libraries listed in `models-subset.txt`: SMD passives, LEDs, diodes,
common SOIC/SOT/QFP/QFN packages, 2.54 mm pin headers), fetched at image build time from the
commit `apps/studio/server/models/kicad-library.ts` pins and exposed as `KICAD10_3DMODEL_DIR`.
The running pack has no network: models outside the subset are still reported as a `warn`
finding and the board body is exported without them. To widen the subset add library names to
`models-subset.txt` and rebuild. Cost: about +180 MB compressed (+1.3 GB unpacked) over 10.0.6-2.
The models are CC-BY-SA 4.0 with the KiCad libraries exception and are not committed here.

Try it by hand (any folder holding `board.kicad_pcb` and a `request.json`):

    docker run --rm --network none --read-only --tmpfs /tmp \
      -v "$PWD/in:/work/in:ro" -v "$PWD/out:/work/out" \
      wirehub-tool-kicad:10.0.6-7 board-render /work/in/request.json

`board-render` PNGs are post-cropped to the opaque area (Pillow, small even
border) so covers are not mostly transparent margin (10.0.6-3). Pack version 10.0.6-4 adds the
`Connector_USB`, `Connector_BarrelJack` and `Capacitor_THT` models, so edge connectors and radial
capacitors have heights in `board.glb` (the enclosure reads part heights from it); 10.0.6-6 adds the
through-hole libraries (`Package_TO_SOT_THT`, `Package_DIP`, `Resistor_THT`, `Diode_THT`, `LED_THT`,
`Inductor_THT`, `Button_Switch_THT`, `Crystal`, `Connector_JST`) so tall THT parts read real heights.

Pack version 10.0.6-7 makes every output byte-reproducible (`repro.py`, shared with the enclosure
pack): Gerber, drill, job-file, SVG and netlist creation dates and the GLB `generated_at` carry one
fixed stamp (`params.sourceDateEpoch`, else `SOURCE_DATE_EPOCH`, else 2000-01-01), and `board.step`
is renumbered canonically (Open CASCADE writes its colour section in hash order), one record per line.

Pack version 10.0.6-5 adds the `netlist` op (inputs: the `.kicad_pcb` and any `.kicad_sch` files
of the project, sub-sheets under the names the root sheet gives them).
