# Tool pack: enclosure

Parametric board enclosures with [build123d](https://github.com/gumyr/build123d) 0.13.0 on
Open CASCADE (OCP 8.0.1). Image `wirehub-tool-enclosure:0.3.5`; pins in `Dockerfile` and
`requirements.lock` (hash-checked, `uv pip compile requirements.in --generate-hashes`).

```sh
docker build -t wirehub-tool-enclosure:0.3.5 tools/enclosure
docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$IN":/work/in:ro -v "$OUT":/work/out \
  wirehub-tool-enclosure:0.3.5 enclosure-generate /work/in/request.json
```

Same request, same bytes (0.3.3+): every STEP gets a fixed `FILE_NAME` stamp and a canonical
entity numbering (`repro.py`, the same file as `tools/kicad/repro.py`), and `result.json` /
`device-result.json` carry no timings (the run time is in `log.txt`).

## Op `enclosure-generate`

`request.json` → `params`:

- `boards[]`: `{ id, label, basis, thickness, outline: [[x, y], …], holes: [{ x, y, d }],
  components: [{ ref, x0, y0, x1, y1, height | null, basis?, side }], ports: [{ id, label, edge:
  front|back|left|right, at, z, width, height, shape: rect|round, protrude }], heightAbove,
  heightBelow }`. Board-local millimetres, **y toward the back**, origin at the outline's
  bounding-box minimum, underside at z = 0. `height: null` is an unknown height: it is modelled at
  `defaultComponentHeight` and reported, never treated as zero. A component whose `basis` is
  `estimated` (the studio read it from the footprint's name, not a 3D model) is reported as such
  and its collisions say so.
- `occurrences[]`: `{ id, board, x?, y?, rotation? }`. The same board may appear more than once;
  occurrences without `x`/`y` are laid out left to right.
- `enclosure`: design parameters (wall, floor, lid thickness, clearance, standoff height and
  diameter, pilot, lid `flat` with screw posts or `split` at a height, lip and fit, vents). All have
  defaults (`DEFAULTS` in `enclosure.py`).
- `openings[]`: extra cut-outs in the enclosure frame (`face`, `u`, `v`, `width`, `height`, `shape`).

Outputs (manifest roles): `base-step`, `lid-step`, `base-stl`, `lid-stl` (flipped plate-down for
printing), `assembly-step` (base, lid and board dummies), `preview-model` (`assembly.glb`, millimetres like the Library's own GLBs,
lid lifted), `preview-image` (`preview.png`, a z-buffered isometric render made without GL) and
`result` (`result.json`: outer/interior size, each occurrence's placement matrix, resolved
openings, supports, lid posts, volumes, the effective parameters). Each `supports[]` entry is
`{ occurrence, kind: board-hole | corner-pad, x, y, z }` (z = the support's top, the board's
underside; a `board-hole` also gives `holeDiameter`, `standoffDiameter`, `pilotDiameter`, a
`corner-pad` its `size`); each `lidPosts[]` entry is a flat lid's screw axis `{ x, y, size, z0, z1,
pilotDiameter, pilotDepth, screwZ }` (screwZ = the lid's outside), empty without lid screws.
Consumers read these instead of re-deriving them from the parameters.

Findings are advisory: unknown heights, ports set back from a wall, collisions between the
shell/lid and declared board geometry (boolean intersection, as in the reference generator),
missing mounting holes. Invalid parameters give `status: "failed"` with an `error` finding; the
process still exits 0. Running without `--user`, the pack hands its outputs to the owner of
`/work/out`.

Examples (synthetic and public-safe, made up for this pack): `examples/synthetic-two-boards.json`
is a request with one board placed twice; `examples/synthetic-demo-board.kicad_pcb` is a 60 × 40 mm
KiCad board built from KiCad's standard footprints by `examples/make-synthetic-board.py` (run with
KiCad's Python). Uploaded as a board's model in the Library, it gives an enclosure a native outline,
four mounting holes and two edge connectors.

In the app: a board's record → Enclosures → New enclosure creates a shell carrying the parameters;
its Enclosure panel saves them and runs Generate (`POST /api/enclosures/:id/generate`), an
`enclosure-generate` job run by the shared tool-pack runner where `WIREHUB_TOOL_RUNNER=docker` is set
(progress and Cancel in the panel; `docs/jobs-and-tool-packs.md`).

## Op `device-assemble` (pack 0.3.0)

A whole device in one run: `assemble.py` (the image's `entry.py` sends this op there). The studio
composes the device (`deviceScene` in `@wirehub/model`) and passes every placed thing as a part:
`{ path, kind, label, group?, matrix (4×4, device frame, mm, z up), provisional?, geometry }`, where
`geometry` is a STEP input (`frame: board` moves a KiCad board STEP so its PCB body's outline minimum
is the origin and its underside z = 0), a board outline with footprint boxes, a box, parametric
hardware (`screw`, `standoff`, `foot`) or a cable route tube. `params.drawing` fills the title block
and parts list (a long title wraps to two lines, then ends in an ellipsis; an unsaved-version export reads `unreleased`); `false` skips the sheet.

Outputs: `device-step` (device.step, one named, coloured node per part, grouped by sub-assembly),
`device-glb` (millimetres, y up), `preview-image`, `device-drawing` (an A3 SVG: front, top and right
views in third-angle projection with hidden lines, an isometric view, overall dimensions, parts list
and title block; lid screws and feet in a table with their pitch dimensioned), `device-drawing-pdf`
(that sheet plus one per nested sub-device, in its own frame with its own parts list: a multi-page
PDF; pack 0.3.3) and `result` (bounding box, each part's geometry and status, the sheet's scale).
Cable routes are in the STEP and GLB but not on the drawing: they are schematic. In the app: a
design's Device view → Exports (`POST /api/devices/:id/exports`, a `device-export` job), from the
working copy or the saved version being viewed.
