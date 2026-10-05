# Depictions and anchors

How WireHub keeps artwork for a part, ties it to the part's pins, and decides whether to
draw it. The generic spec of `packages/catalog/src/depictions/` (the model, validation,
anchors, import), `packages/layout/src/depictions.ts` (resolution) and
`apps/studio/server/depictions.ts` (the upload API). What the art may look like, and how
packs and modules supply connector drawings, is `specs/drawing-language.md` section 7. Examples are the starter
catalog's.

A depiction is **presentation, not truth**. Nothing in `model` or in a catalog's electrical
records refers to one. Artwork is keyed by definition id and picked up opportunistically; a
definition with none draws as the abstract block, which is always correct.

## 1. What a depiction is

One directory per definition id, in the catalog's `depictions/` tree (the starter has
`de9-female`, `de9-male`, `jst-xh-2`, `terminal-block-4`, `multicore-3coax-4core`):

```
depictions/<def-id>/<view>.svg      the artwork, one file per view
depictions/<def-id>/meta.json       the manifest
```

`<def-id>` is a connector id, a connector **body** id, a board id or a wire stock id. A body's
art serves every connector built on it (one face, many pinouts): its anchors are the body's
position ids. Resolution looks at the connector's own id first, then its body and the body
its `drawing` name selects.

### Views

| View | Used for |
| --- | --- |
| `mating-face` | a connector as the builder plugs it in |
| `solder-side` | the same face seen from behind: always a mirror of `mating-face` |
| `board-top`, `board-bottom` | a board seen from either side; bottom mirrors top |
| `schematic-symbol` | a symbol for a block |
| `illustration` | a wire stock's picture, used as its cutaway on the drawing sheet |

### The manifest

```json
{
  "defId": "de9-female",
  "views": {
    "mating-face": { "file": "mating-face.svg", "kind": "vector", "mmPerUnit": 1,
                     "sourceKind": "hand", "widthUnits": 32, "heightUnits": 13.5, "src": "..." },
    "solder-side": { "file": "solder-side.svg", "kind": "vector", "mmPerUnit": 1,
                     "sourceKind": "hand", "widthUnits": 32, "heightUnits": 13.5,
                     "mirrorOf": "mating-face", "mirrorAxis": "x", "src": "..." }
  },
  "anchorFrame": "mating-face",
  "pinAnchors": { "1": { "x": 21.54, "y": 5.33 }, "2": { "x": 18.77, "y": 5.33 } },
  "src": "..."
}
```

- `kind`: `vector` (inlined by the renderer) or `raster` (embedded as a data URI).
- `mmPerUnit` converts artwork units to millimetres; board art is drawn mm-true (1).
- `widthUnits`, `heightUnits` are the frame, needed for any view that is mirrored.
- `sourceKind` is the rung of the input ladder: `kicad`, `gerber`, `dxf`, `step`, `svg`,
  `pdf`, `photo` or `hand`. `src` states where the numbers came from.
- Optional: `sources` (the exact input files with their sha256, so a rerun can tell when the
  inputs moved), `components` (parts mounted for a build, board art), `color` (the board's
  mask and silk colour, baked into the SVG), `entryGuides` (section 5), `license`,
  `provenance`.

## 2. Anchors

An **anchor** is where one logical pin, pad or terminal sits in the artwork: `{ x, y }` in
`anchorFrame`'s coordinates (artwork units, origin top-left, +y down, SVG's own sense). A
depiction carries **one** anchor set. The renderer lands a block's port on the anchor, so a
wire arrives at the true pad.

Anchors may also carry:

- `side`: `top`, `bottom` or `both` (a plated through hole), for board art, authored in the
  `board-top` frame;
- `pads`: every physical pad that lands the terminal, primary first, for a collapsed terminal
  such as a ground on several pads;
- `approach`: the direction, in degrees, a wire physically comes in to the pad, and `size`:
  the pad's `[along, across]` extent, so a lead can be drawn at the real angle and clear of
  its neighbours (board art from production files, when the pad's orientation says something);
- `note`: anchoring provenance the electrical model has no room for.

### Mirrored views are derived, never anchored by hand

A view that declares `mirrorOf` (`solder-side`, `board-bottom`) has no anchors of its own.
`anchorsFor(meta, view)` reflects the one set across `mirrorAxis` (default `x`, the board
flipped about its vertical centre line, which is what looking at the other side does).
`anchorFrame` may never be a mirrored view. A human mirroring a pinout by eye is the classic
wiring error, so the tool owns the flip: an API write that anchors a mirrored view is
refused. `approach` angles and `pads` reflect with the points; `size` does not change.

## 3. Validation

`parseDepictionMeta` (structural: turns unknown JSON into a manifest or issues, never trusts
a field) and `validateDepiction` (referential) run on load. **Nothing throws on bad data**:
every problem is a typed issue and the renderer degrades to the abstract block.

- the manifest is an object with the required fields and known vocabularies;
- every asset file exists; `mirrorOf` and `anchorFrame` name real views, and a view does not
  mirror itself;
- every anchor names a real pin, pad or terminal of the definition it claims. This is an
  error, so a rename in the Library that orphans an anchor is visible;
- a pin or position with no anchor is a *warning*: an instance that uses it falls back to the
  abstract block;
- `src` is present; `license` and `provenance`, when given, are well-formed
  (`recordMetaIssues`).

## 4. Resolution: drawn or abstract

`resolveDepiction(source, kind, definitionId, requiredIds, alsoTry)` decides for one block,
where `requiredIds` are the terminals the drawing must land a wire on (the used ones). The
answer is one status:

| Status | Meaning |
| --- | --- |
| `drawn` | artwork found, readable, anchored for every used pin; the block draws as it |
| `no-depiction` | the definition (and its body) has none |
| `no-usable-view` | no view of the right class (connector: mating face; board: board top) with a frame and resolvable anchors |
| `unreadable-asset` | the manifest names a file that cannot be read |
| `unanchored-pin` | a used pin has no anchor (`missing` lists them) |
| `crowded-anchors` | two used pins sit closer than 1 mm down the (turned) face, so their wires would share a line |

Only `drawn` changes the block. Every other status is a fallback with a diagnostic, never an
exception. An unused pin without an anchor does not matter; a pin shown only because an
internal link mentions it may go unanchored (its row is dropped, not the whole picture).

A connector face whose used pins spread more across the face than down it is **turned** a
quarter clockwise so its long axis runs down the page (as the built-in faces are), and its
anchors are turned with it. A board that has a gerber-tier `board-top`, a `board-bottom`
mirroring it and readable vector art for both draws **both faces**, stacked.

The depictions come from a `DepictionSource` (`meta(defId)`, `artwork(defId, view)`): the
catalog's own tree by default, the bundled modules' trees layered after it
(`layeredDepictions`, a catalog's own first), or a version's frozen copy. Layout carries the
identity of the asset and the renderer asks the same source for the bytes, so both must be
given the same one.

## 5. Board art, entry guides and mounted parts

A board's art may be rendered from fabrication outputs rather than drawn: its real outline,
copper, mask, silk and drills, with anchors from the layout file. Two extras exist for it:

- **Mounted parts** (`components`): the parts fitted in a given build, in the anchor frame
  (`ref`, `kind`, `side`, `state`, outline, pin 1, package family, numbered pads). A solder
  jumper's `state` is `bridged`, `open` or `unset`. A part whose package is not recognised
  carries none and draws as the plain outlined box.
- **Entry guides** (`entryGuides`): for a board whose pad rows sit at an angle to the edge, a
  human-set line just outside the outline, parallel to the row, on which each wire reaches
  its slot off the board, then runs straight to the pad. They are authored by a person (the
  Library's guide editor) and survive a regeneration of the art.

The starter catalog ships connector faces and one wire illustration and no board art;
board art is whatever a deployment imports (`modules/board-import` derives it from fabrication
files).

## 6. Importing artwork

`prepareDepictionImport` is the one function both the CLI importer and the studio's upload
call, so a file dropped on the GUI and the same file passed to the CLI produce byte-identical
art and the same manifest merge.

- **Formats.** `.svg` is normalised in full; `.png` and `.jpg` are copied with a declared
  scale (width in millimetres). DXF, STEP/STL/IGES, PDF, WebP, GIF, BMP and TIFF are refused
  with a sentence saying what to convert them to. A refusal names the rung of the input ladder
  the file is on (vector CAD, solid model, datasheet page) and the one conversion that gets it
  onto a supported rung.
- **Normalisation.** `stripUnsafeSvg` removes scripts, event handlers and external references
  and reports what it removed; strokes are brought to a house width; units become artwork
  units with `mmPerUnit`.
- **A stored asset is named after its view.** The request never chooses a file name, and an id is a
  slug, never a path.

### The API

```
GET    /api/depictions                    every definition with art, and what each has
GET    /api/depictions/:defId             one manifest
GET    /api/depictions/:defId/:view       the artwork bytes
POST   /api/depictions/:defId/:view       upload (multipart), normalised by the importer
PUT    /api/depictions/:defId/anchors     { view, anchors }
PUT    /api/depictions/:defId/entry-guides
```

A candidate manifest is parsed and validated against the live library **before** anything is
written; a refusal returns the validator's own issue list and nothing touches disk. Writes
to a record someone else holds are refused by the edit lock (`specs/design-versions.md`
section 8).

## 7. In versions and in the Library

- A saved version copies each referenced definition's artwork, content-addressed
  (`specs/design-versions.md` section 3), so an old revision draws the art it was released
  with.
- The Library's **Artwork** tab (a connector, a board, a wire stock) shows the views, lets a
  person drop a file in, then click its pins onto it (a checklist of the definition's real
  terminals arms the next unanchored pin; a slightly-off anchor is dragged, not retyped), and
  shows the importer's changes or refusal verbatim. The solder side sits beside the face,
  updating live from the anchors as they are placed and labelled as generated; it is never
  anchored. After a successful write the preview redraws from the fresh manifest. The record's flags show `Art` for a definition with a
  depiction (`specs/library.md`).
- A connector body's art is edited once and serves every pinout on the body.
