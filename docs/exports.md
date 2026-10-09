# Exports and headless rendering

Everything the Documents tab shows can be had as a file, and without a browser: as downloads
from the toolbar, over the API with a token, and from a command line. All three call the same
functions in `@wirehub/docs` (`packages/docs/src/exports/`), so a file is the same file
wherever it was made. Nothing here is shop-specific: a module adds formats of its own
(below).

## From the Documents tab

**Export…** (beside Print) offers, for the design and revision shown:

| Export | File | What |
| --- | --- | --- |
| BOM (CSV) | `bom.csv` | the bill of materials, one row per printed line |
| Wire list (CSV) | `wire-list.csv` | every conductor, screen and drain, and where each end lands |
| Cut list (CSV) | `cut-list.csv` | pieces to cut per stock and length |
| Crimp list (CSV) | `crimp-list.csv` | every cavity of each crimp housing: wires, contact, seal or plug, strip, crimp height, tool |
| BOM, wire, cut and crimp lists (XLSX) | `production.xlsx` | the four above, one sheet each |
| Continuity (CSV) | `continuity.csv` | net-to-pin pairs, expected connections, isolation pairs, with the test parameters |
| Continuity (JSON) | `continuity.json` | the same, structured |
| Wire labels (CSV) | `labels.csv` | text and position of the marker at each wire end |
| Label sheet (SVG) | `labels.svg` | the labels laid out on a sheet of label stock |

Files are named `<design>-<what>.<ext>`, with `-rev<N>` after the design when a saved
revision was chosen. The XLSX is written by hand into an uncompressed zip, so there is no
spreadsheet dependency and the same rows are always the same bytes.

### Columns

All CSVs are RFC 4180 (CRLF line ends, quotes where needed), header row first, in a fixed
column order.

- **BOM:** `section, part_number, description, quantity, unit, location, instances,
  variation_pn, notes`. Quantity is a number; `unit` is `ea` or `ft` (wire). A length
  family's trunk has one row per orderable length, with its `variation_pn`. A sub-assembly
  (another design placed in this one, SPEC.md "Sub-assemblies") is one row in section
  `Sub-assemblies`, by the placed design's product part number, its notes naming the design and the
  pinned revision (or `working copy (not frozen)`); with prices its cost is that design's own
  roll-up. `?explode=1` (the API, on `bom.csv`, `production.xlsx` and the `bom` document) lists the
  placed designs' parts instead, folded with this design's own (`lead-1/j1 lead-2/j1`).
- **Sub-assemblies elsewhere:** the build sheet references each one's own build sheet and lists what
  lands on its ports; the wire, cut, crimp and label exports cover this design's own wire only; the
  continuity exports and the schematic cover the flattened assembly, the placed parts named
  `<sub>/<id>` (`lead-1/j1.1`).
- **BOM cost columns:** when some part has a price (`cost`, `docs/interop.md` "Costing"), `unit_cost,
  extended_cost, currency` follow the BOM columns, and `Labour`, `Total` and (for a build quantity above 1)
  `Total x N` rows close the file, with the amount in `extended_cost`. A BOM with no prices has none of this.
  The API takes `?quantity=N` for the build quantity quantity breaks are read at.
- **Wire list:** `segment, stock_part_number, stock, element, kind, colour, a_landing,
  a_pad, b_landing, b_pad, length_mm, notes`. `element` is the element path in the stock
  (`pair-1.a`) or `pigtail:<id>`; `kind` is `core`, `screen`, `drain` or `pigtail`; a
  landing is `<instance>.<terminal>` and is blank where the end is cut back. A wire
  segment a breakout carries only part of lists only the elements it carries.
- **Cut list:** `stock_part_number, stock, piece, length_mm, length_in, quantity,
  variation_pn, segments`. Equal pieces fold into a quantity; a segment the contract
  manufacturer supplies terminated is not cut here.
- **Crimp list:** `connector, connector_part_number, cavity, wires, wire_mm2,
  contact_part_number, contact, seal_part_number, seal, plug_part_number, plug, strip_mm,
  crimp_height_mm, tool_part_number, tool, notes`. One row per cavity of every connector
  with a crimp housing or a cavity assignment (`ConnectorInstance.cavities`); `wires` lists
  `<segment>.<element>@<end>` and `wire_mm2` their total cross-section. A design with no
  crimp housing on record has the header row only. Contacts, seals and plugs are also BOM
  lines (section "Contacts, seals & plugs", counted per cavity); tools are not.
- **Labels:** `label_id, segment, end, designation, line_1, line_2, line_3, offset_mm,
  position, stock_part_number, length_mm`.
- **Continuity:** below.

## Wire labels

A label is generated for each end of each wire run, never authored. The run's designation is
`W<n>`, counting the design's wire segments in order, the trunk first. An end is `W<n>-A`
(source) or `W<n>-B` (destination); the label also says what that end connects to (`at J1`,
`to U1`). Its position is 40 mm back from the end of the jacket (a quarter of the length on
a short run, never under 10 mm). The labels are listed on the build sheet's Assembly page,
exported as CSV, and printable as a sheet: `labels.svg` is one page in millimetres on a
3 × 7 grid of 63.5 × 38.1 mm labels (A4) or 3 × 10 of 66.7 × 25.4 mm (US letter); print it
at 100%. `page=` and `copies=` (API and CLI) pick a page and repeat each label.
Each label names the ends (`Source end: J1`, `Destination end: J2`, this end first) and
carries the design's part number and revision. `preset=` picks the label stock (the A4 and
Letter grids, or one label per page for Brady and Dymo sizes; the set is in Settings ›
Documents, which also sets the default), and `qr=1` adds a QR code of the part number and
revision, or of the address pattern set there (`{pn}` `{rev}` `{design}` `{label}`).

The generated text can be overridden in the inspector, per segment and connector: a segment's
**run label** replaces `W<n>`, its **end A / end B text** replaces the generated lines of that
end (lines separated by `|`, at most 3 of 40 characters), a connector's **label** replaces its
id in capitals in the `at` / `to` lines, and a **core label** (one per conductor of the stock)
prints an extra marker at both ends of the run (`core` column of the CSV). Cores nobody
named get no marker; with nothing entered the labels are exactly the generated ones.

Per-run label text typed in the inspector is not built yet (cs-5k1.20 stays open for it).

## Continuity tester export and test parameters

The continuity spec derives every connection that must read continuous and every pair that
must read open. `continuity.json` is that spec as data, with no tester's dialect in it:

```jsonc
{
  "format": "wirehub.continuity", "version": 1,
  "design": { "id": "de9-crossover", "label": "…", "productRef": "…" },
  "parameters": { "continuityOhmsMax": 5, "isolationVolts": 100, "isolationMinMohm": 10, "isolationSeconds": 1 },
  "points":      [{ "id": "j1.3", "instance": "j1", "terminal": "3", "label": "3", "end": "a", "signal": "…", "net": "net-3" }],
  "nets":        [{ "net": "net-3", "signal": "…", "points": ["j1.3", "j2.2"] }],   // the net-to-pin pairs
  "connections": [{ "id": "…", "kind": "path", "from": "j1.1", "to": "j2.1", "expect": "resistance", "ohms": 150, "through": "r1 (150 Ω)" }],
  "isolation":   [{ "id": "…", "a": "j1.1", "b": "j1.3", "end": "a", "rule": "signal vs ground", "netA": "…", "netB": "…" }],
  "opens":       [{ "id": "…", "kind": "unused-pin", "point": "j1.7 (7)", "why": "…" }]
}
```

Point ids are `<instance>.<terminal>`; only connector pins (and the pins of a connector a board
carries) are test points. `expect` on a connection is one of `continuity` (reads at or below
`continuityOhmsMax`), `resistance` (reads about `ohms`), `open-dc` (connected through a
capacitor or active silicon: a DC meter reads open), `conditional` (depends on a fitted build
option) or `unverified` (no reading is claimed). `kind: "commoned"` is a pair that is one net
on purpose.

`continuity.csv` is one flat table, `type, id, net, signal, from, to, expect, limit, unit,
test_volts, duration_s, note`, where `type` is:

- `net-pin`: `from` is on net `net`;
- `continuity`: `from` and `to` are connected; `expect` as above; `limit` is the threshold
  (`continuity`) or the resistance (`resistance`), in ohms;
- `isolation`: `from` and `to` must read at or above `limit` megohms at `test_volts`, held
  `duration_s` seconds;
- `hipot`, only when a hipot voltage is set: the withstand test applied between every pair
  of isolated nets (`from` is `*`); leakage above `limit` microamps fails;
- `open`: a deliberate open at `from`.

### Test parameters

| Parameter | Default | |
| --- | --- | --- |
| `continuityOhmsMax` | 5 Ω | a continuity reading at or below this passes |
| `isolationVolts` | 100 V DC | applied between nets that must be isolated |
| `isolationMinMohm` | 10 MΩ | an isolation reading at or above this passes |
| `isolationSeconds` | 1 s | how long the isolation voltage is held |
| `hipotVolts`, `hipotSeconds`, `hipotMaxMicroamps` | none | an optional withstand step |

Three layers, the later one wins: the base's defaults; the organisation's, set on the
Settings page under **Testing** (kept in `data/settings/engineering.json`, so it travels with
the catalog) or in the environment as
`WIREHUB_TEST_DEFAULTS='{"isolationVolts":250,"hipotVolts":1500,"hipotSeconds":2}'` (a bad
value stops the server at start with one line; a parameter the variable sets wins over the
page and shows there as "set by the server"); the design's own, edited on the
Continuity spec tab and saved in the drawing sidecar (`test` in `data/drawings/<id>.json`).
They are printed on the continuity spec (and the threshold is quoted in its expected
readings and on the build sheet's Test page) and carried in the exports. They are settings,
not facts of the cable, which is why they are not in the design.

### Tester-specific formats are module exporters

The base never writes a tester's own dialect. A module adds one through the existing exporter
extension point, asking the host for the neutral data:

```ts
exporters: [{
  id: 'acme-tester',
  label: 'ACME tester',
  source: 'continuity',            // the host derives the continuity data and passes it in
  render: (design, db, options) => {
    const data = options?.['continuity'] as ContinuityData;   // type: @wirehub/modules (MIT)
    return { mimeType: 'text/plain', fileName: `${design.id}.acme`, body: toAcme(data) };
  },
}]
```

The data comes with the design's test parameters already resolved, in the Documents toolbar
(as a download button) and at `GET /api/modules/<module>/_export/<exporter>?design=<id>`.
`ContinuityData` is declared in `@wirehub/modules`, so a module needs nothing but the module
API (`MODULE-EXCEPTION.md`). `modules/example` has a working one (`tester-netlist`).

## Without a browser

### API

A token (or a session) may GET these; they render the working copy, or a saved revision from
the definitions frozen when it was saved (`rev=<n>` or `rev=latest`).

```
GET /api/designs/:id/documents/:kind?format=…&rev=…&paper=<paper>&variation=…&page=…&copies=…&preset=…&qr=1
GET /api/designs/:id/exports/:format?rev=…
GET /api/exports                       the lists below
```

Documents and the formats each comes in (default first):

| `:kind` | formats |
| --- | --- |
| `schematic` | `svg`, `pdf` |
| `build-sheet` | `html`, `svg`, `pdf`, `csv` (the wire list) |
| `bom` | `html`, `svg`, `pdf`, `csv` |
| `test-spec` | `html`, `svg`, `pdf`, `csv` (the continuity export) |
| `drawing` | `svg`, `html`, `pdf` |
| `labels` | `svg` (the label sheet), `pdf`, `csv` |
| `formboard` | `svg` (the overview, or one tile with `page=`), `html`, `pdf` (overview then every tile) |

A wire stock's spec sheet (the Library's Spec tab) has its own route:
`GET /api/definitions/wires/:id/wire-spec?format=html|svg|pdf&paper=A4|letter`, named
`WSS_<document number>`. Its `html` is the browser's sheet byte for byte; its `pdf` is that
sheet printed by the browser PDF engine when one is configured (below). Otherwise `svg` and
`pdf` set the same sheet's text (facts, colour and signal map, notes) as plain pages, without
the cross-section figure.

`:format` of an export is one of the ids in the table at the top. A rendered sheet is sent
with `Content-Disposition` and a sandboxing `Content-Security-Policy`.

- **`html`** is the browser's own render, byte for byte (the same functions); the working
  copy's state is UNRELEASED when the studio keeps saved revisions, exactly as on screen, and
  the hub's branding (Settings) is on the sheets as the browser draws it.
- **One frame for every sheet.** The build sheet, BOM, continuity spec, drawing, formboard,
  label sheet and schematic carry the same border, title block (organisation, title, part
  number, revision, state, paper, drawn and checked, date, sheet n of m) and a small state
  stamp in the corner for a state that is not released (`UNRELEASED`, `UNAPPROVED`, `DRAFT`),
  in IBM Plex Sans and Mono with 0.5 pt hairlines (`packages/docs/src/frame/`). The drawing
  also carries a revision table (the saved revisions, oldest first). `?paper=` is honoured by
  every sheet: `A4`, `A3`, `A2`, `A1`, `A0`, `letter`, `legal`, `tabloid`, `ansi-c`, `ansi-d`,
  `ansi-e`; the drawing and the formboard turn the page landscape, and the label sheet, whose
  stock comes in two grids, takes A4 for the ISO sizes and Letter for the ANSI ones. The
  title-block layout is data: an ISO 7200 block at the bottom right, or an ANSI full-width
  block. **Where it is set:** Settings > Documents, "Paper" and "Title block" (stored with the
  branding; the title block follows the paper by default: ISO for the A sizes, ANSI for the
  North American ones). A design's own sheet options (the Documents view's Paper menu) win
  over the hub's setting, and `?paper=` over both.
- **`formboard`** is the cable laid flat at true length with pegs, connectors and label
  positions, at 1:1 or `?scale=` (`0.5` or `1:2`) and tiled across `?paper=` pages with
  registration marks (`specs/formboard.md`).
- **`pdf` of the build sheet, BOM, continuity spec, drawing sheet and a wire stock's spec
  sheet, with a browser PDF engine** (`WIREHUB_PDF_ENGINE_URL`; the compose profile `pdf`,
  `docs/self-hosting.md` "Printed PDFs") is the `html` sheet printed by Chromium, exactly as a
  browser's Print → Save as PDF prints it: the sheet's own `@page` size and margins (`paper=`),
  the figures, the frame on every page with its state stamp, the hub's branding, selectable
  text. The sheet is sent with its images and fonts inline, set in the IBM Plex faces the
  sheets embed, so the file is the same whichever machine runs the engine. Code is `apps/studio/server/render/browser-pdf.ts`.
  When the hub set its own typeface (Settings, Branding; `docs/modules.md`) that font travels inline as
  well and is first in the stacks, so the PDF is set in it.
- **Without an engine** (or when it fails), those PDFs are the headless ones below, and the
  response says so: `X-WireHub-PDF-Fallback` gives the reason and the `render` command prints
  it as a note. Every PDF carries `X-WireHub-PDF-Renderer`: `browser`, `text-layout`, `raster`
  or `vector`.
- **`svg` and `pdf` of the schematic, the drawing sheet, the label sheet and the formboard** are the
  drawings themselves, inside the frame. **With an engine** the PDF of the schematic, the drawing
  sheet and the label sheet is that SVG printed by Chromium: vector, text selectable, renderer
  `browser`. **Without one** it is a rasterised page (SVG through `@resvg/resvg-js`, which
  the Library's 3D board textures already use, with the Liberation Sans faces in
  `packages/docs/fonts` and no system fonts, so it does not depend on the machine) and says so
  in `X-WireHub-PDF-Fallback`. The formboard's is always vector, so a 1:1 tile prints crisp. A hub's own typeface (Settings, Branding) is used by the drawing's raster PDF (a TrueType or
  OpenType file) and embedded as a subset in the formboard's vector PDF (TrueType outlines: `.ttf`, or an
  `.otf` that has them); a CFF `.otf` or a WOFF2 keeps the Liberation Sans on those two.
- **`svg` (and, without an engine, `pdf`) of the build sheet, BOM and continuity spec** are a
  plain page layout of the sheet's text (tables and notes, no figures): laying out the HTML
  sheets needs a browser engine, which the WireHub image does not ship. The PDF is written by
  `apps/studio/server/render/pdf.ts` with no dependency, in Helvetica; characters outside
  Latin-1 are transliterated (`Ω` as `ohm`).
- Board artwork on the headless schematic, build sheet and BOM comes from the hub's artwork
  store — on the database backend that includes uploaded artwork — over the catalog's own
  tree, and a saved revision draws the artwork it was saved with (as the browser does). The
  BOM carries the numbering scheme's proposals for unnumbered parts.

### Command line

```bash
pnpm --filter studio render de9-crossover bom --format csv
pnpm --filter studio render de9-crossover build-sheet --format pdf --rev latest --out ./out
pnpm --filter studio render de9-crossover all --out ./out         # every document, default format and PDF
pnpm --filter studio render de9-crossover continuity.json --out -  # to stdout
pnpm --filter studio render dc-2core-24awg wire-spec --format pdf  # a wire stock's spec sheet (<design> is the stock id)
```

`<what>` is a document kind, an export id, or `all`; options are `--format`, `--rev`, `--out`
(a directory, or `-` for stdout), `--paper`, `--variation`, `--page`, `--copies`. By
default it renders from the catalog this checkout (or `WIREHUB_BACKEND`) points at; with
`WIREHUB_API_URL` and `WIREHUB_API_TOKEN` set (as for `studio-api`) it asks the studio over
HTTP, so it works from any machine with a token. Run locally, it prints the HTML sheets
through a browser PDF engine when one is named (`WIREHUB_PDF_ENGINE_URL`, or Settings > Integrations) (for example a Gotenberg
started with `docker run --rm -p 127.0.0.1:3000:3000 gotenberg/gotenberg:8.37.0-chromium`, and
`WIREHUB_PDF_ENGINE_URL=http://127.0.0.1:3000`); over HTTP the studio's own setting applies.
A PDF that fell back to the headless one is reported as a `note:` line. Not built: the wire stock's spec sheet
(`/api/definitions/wires/:id/wire-spec`) is still browser-only.
