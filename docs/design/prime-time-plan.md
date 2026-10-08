# WireHub: prime-time design plan

Status: accepted with the owner's decisions of 2026-10-08 (§5, Decisions). Work is tracked in beads.
Reviewed: v0.6.0 (main at `05f1067`), 2026-10-08, by running the real compose stack and
working through it hands-on.
Evidence: screenshot file names are cited as `name` below (`-light-1440`, `-dark-1920`,
`-light-390` give the theme and width). The screenshot set is kept out of the repository;
P1-F2 re-shoots it after the changes land.
Prototypes: [`prototypes/`](prototypes/) (open them from disk; renders are the `P-proto-*` screenshots).

**How the review was done.** I ran the published 0.6.0 image with the repository's own
`compose.yaml` and the `pdf` profile on 127.0.0.1, with no `.env` beyond port and URL. I went
through first-run setup (Example Shop, starter catalog, PC & serial + Networking + Pro audio).
From the official store I installed Automotive, AV / video and the FX-rates and Suppliers code
modules, then restarted from the UI. I made a cable with the wizard, wired it on the canvas,
saved it, and opened every document and PDF. I walked every route in `apps/studio/src/routes/`
in light and dark at 1440, a subset at 1920 and 390, and built and served the public site from
`site/`. Playwright was used throughout. All data is public example data.

---

## 1. Executive summary

**State today.** The engine underneath is strong. The model, the derivations and the documents
are better than most tools in this space, and the deterministic, cited, self-hosted approach is
a real differentiator. Install is excellent: one file, `docker compose up`, a 23-second boot and
a one-second setup. The command palette and the cable list are close to Linear-grade. The
dense, warm, copper-on-graphite look is distinctive and is a good base.

Above that engine, the product still reads as an internal tool that grew feature by feature:

- every screen has its own anatomy;
- optional modules drop full forms into core screens;
- the canvas is hard to wire by hand;
- copy explains internals (env vars, file paths, `docs/*.md`, migration numbers) where it
  should state outcomes;
- the public face (README, site, docs) does not yet show the product at all.

None of this is deep. It needs a token-and-component pass, a slot policy for modules, a
canvas-interaction pass and a front door. Those are about three phases of parallel agent work.

### Top 10 issues, ranked by impact on a newcomer

| # | Issue | Evidence | Sev | Effort |
| --- | --- | --- | --- | --- |
| 1 | **Optional modules take over core screens.** With FX-rates installed, a large, unconfigured "Reference-rate costing" form sits above every document, including the drawing, BOM and formboard. With Suppliers installed, a quote form with seven fields sits above the definition on every Library detail, pushing the actual part data below the fold. Neither can be collapsed or dismissed. | `8x-doc-bom-light-1440`, `8x-doc-drawing-sheet-light-1440`, `13-cable-documents-dark-1920`, `94-library-wire-detail-dark-1440` | Critical | M |
| 2 | **Wiring a new cable by hand is close to impossible on connectors drawn as art.** A DE-9 node renders as its face, and its pin targets are **2.6 × 2.6 px** (measured). Drags onto it silently fail. The wizard creates the cable with **0 joints** while telling you "Nothing is wrong with this design", and the Issues panel says "clean". The warnings only appear once you have connected something. | `67-new-cable-canvas-light-1440`, `70-canvas-connected-light-1440`, `66-wizard-review-light-1440`, `74-canvas-saved-light-1440` | Critical | M |
| 3 | **Domain vocabulary leaks into unrelated cables.** After the AV pack is installed, the wizard's review of a DE-9 to RJ45 Cat 5e cable says the blue and green pairs "carry Video B / Video G": conductor colour words are matched to signal names. For a newcomer this destroys trust in the tool's "smartness". | `66-wizard-review-light-1440` | Critical (bug) | S–M |
| 4 | **First impression is an error.** The setup page shows the full navigation rail, which is useless before setup, plus an amber **Offline** chip and a "Workbench unreachable: showing the last copy this browser fetched" toast. The setup code, the one thing the user must find, is the last field on a long form. | `00-setup-light-1440`, `01-setup-full-light-1440`, `01-setup-full-light-390` | High | S |
| 5 | **Installing from the store gives almost no feedback.** The install preview opens **below the whole list**, off-screen at 1440 × 900, as a raw list of record ids. Success is a plain text line at the page's bottom: no toast, no "view what was added". Cards are walls of text, and "signed by WireHub · unreviewed" reads as a contradiction. Restart from the UI fires with no confirmation and no progress. | `30-store-light-1440`, `36-store-install-preview-light-1440`, `37-install-automotive-after-light-1440`, `39-after-code-FX-light-1440`, `A9-restart-1-light-1440` | High | M |
| 6 | **There is no design system in practice.** Tokens exist for colour only. The code has **17 distinct font sizes (5 to 18 px)**, **10 border radii**, **64 native `<select>`s**, no shared Button, about 58 copies of the same inline button class string, and 5 `confirm()` calls. `--faint` text (hints, placeholders, PN columns) is **2.8:1** in light mode and borders are **1.2:1**, both failing WCAG AA. Every page has a different header pattern. | `32-products-dark-1440`, `33-history-light-1440`, `50-modules-light-1440`, `51-people-light-1440`, `40-settings-light-1440` | High | L |
| 7 | **Copy explains internals instead of outcomes.** The UI cites `docs/self-hosting.md` 23 times, and shows env var names (`env:WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_SECRET` …), "migration 0017", file paths in History (`doc data/designs/…json`), raw ids (`w1:pair-1.a@a`), "Worker 8e6f… (pg-boss)" and Markdown backticks in printed PDFs. Many pages open with a paragraph, which contradicts the owner's own "no narrative subtitles" preference. | `45-settings-runtime-dark-1440`, `49b-code-modules-installed-light-1440`, `33-history-light-1440`, `34-jobs-light-1440`, `pdf-test-spec-p1` | High | M |
| 8 | **Navigation is a flat list of 12–14 icons** that mixes daily work (Cables, Library) with admin (People, API tokens, Settings, Modules) and module routes (Board import). The rail grows when a code module is installed. One concept lives in four places: Store, Modules, Settings › Code modules and Settings › Catalog stores. The resolver has three names: "Find cable", "Which cable do I need?" and "Which cable?". | `03-after-setup-light-1440`, `49b-code-modules-installed-light-1440`, `10-cables-light-1440` | High | M |
| 9 | **The documents are good in content but not yet one product.** The build sheet, continuity spec and drawing sheet use three different visual languages. The drawing is always Letter/ANSI-A even when A4 is asked for. The starter catalog prints red "UNMAPPED" and "no part number" on every sheet. The preview stretches a portrait A4 page to 1820 px wide. The formboard overview labels overlap, and the label sheet is bare. | `pdf-drawing-p1`, `pdf-build-sheet-p1`, `pdf-test-spec-p1`, `pdf-labels-p1`, `8x-doc-formboard-light-1440`, `13-cable-documents-dark-1920` | High | M–L |
| 10 | **The public front door does not show the product.** The README has no screenshot or GIF, and still says "v0.1.0 … until then the image is not published" although 0.6.0 is out. The Pages site has no product imagery, its font and colours are not the app's, Docs is "a placeholder until 1.0", and there is no demo hub. The README "Run it" opens `localhost:5183` with no hint of what you will see. | `A0-site-home-light-1440`, `A2-site-docs-light-1440`, `A3-site-store-light-1440`, README | High | M |

What already works and should be kept: the compose and setup flow, the config generator
(`A1-site-generator-dark-1440`), the command palette (`91-palette-xlr-dark-1440`), the cable
list density, the warm neutral palette, IBM Plex, Tabler icons, the new-cable wizard's
structure (`60-wizard-1-light-1440`), and the schematic and build-sheet content
(`12-cable-schematic-dark-1440`, `pdf-build-sheet-p2`). Narrow (390 px) is better than
expected, with a hamburger and card lists (`10-cables-light-390`). Perceived performance is fine:
a cold `/cables` loads in 1.4 s at 10 Mbit/s (1.2 MB), and the editor chunk is lazy.

### Owner preferences: honoured, with three flags

| Preference | Verdict |
| --- | --- |
| Compact, dense, no hand-holding | Keep density; it is a differentiator against WireViz-class tools. **Flag:** "no hand-holding" is right *in steady state* but hurts adoption at **empty states, the canvas and first run**. Newcomers bounce there. I propose a single dismissible one-line "New hub" strip and real empty states (P0-A). No tours, no modals, no paragraphs. |
| No narrative subtitles; tooltips fine | Agree, and the app currently breaks this rule itself (Products, History, Settings, Store, Runtime). Move every explanation into a `(?)` tooltip or a "Learn more" link to the docs site. |
| Light and dark | Both work today. Fix the contrast and a few dark-only bugs (white React Flow attribution box, document chrome). |
| Clean, modern, not stock shadcn | Agree. Direction: **"bench instrument"**, meaning hairlines, mono for identifiers, copper as the only accent and a calm blue for focus/info, built on Radix primitives with our own tokens. **Flag:** "different" must not mean native controls. Today's 64 native selects and file inputs (`Choose File No file chosen`, `50-modules-light-1440`) are the least modern thing in the app. |
| n8n inspiration | Adopt three n8n patterns directly: the **node creator** (search-first "add part" popover on Tab or on `+` at a pin), the **right-side detail panel** for selection everywhere (cables list, library, store), and **one canvas toolbar**. |

---

## 2. Findings by area

Severity: Critical (blocks or misleads a newcomer), High, Medium, Low. Effort: S (≤ ½ day
agent), M (1–2 days), L (3+ days or cross-package).

### 2.1 Visual design system

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| VD-1 | Colour tokens exist (`tokens.css`, mirrored by hand in `tokens.ts`). There are no type, space, radius, height, elevation or motion tokens. Sizes are inlined as `text-[12.5px]`, `text-[11.5px]` and similar, 17 sizes in all; CSS has `font-size: 5px` to `15px`. | code audit | High | L |
| VD-2 | Contrast: light `--faint` is 2.8:1 on bg and 3.0:1 on panel; dark `--faint` is 3.6:1. Both are used for 11–12 px hints, placeholders and PN columns. Borders `--line` are 1.2–1.3:1, so inputs have no visible boundary (WCAG 1.4.11). The light accent button (white on `#b9622a`) is 4.3:1 at 13 px. | `00-setup-light-1440`, `40-settings-light-1440` | High | S |
| VD-3 | No shared primitives. Buttons are inline strings in about 58 places, with three visual weights that are not used consistently. Tabs are drawn three ways: filled copper (Library, Documents), outlined copper (Resolver, Products) and underline (inspector). Segmented controls are drawn two ways. | `20-library-connectors-light-1440`, `31-resolver-light-1440`, `11-cable-build-light-1440` | High | L |
| VD-4 | Native controls: 64 `<select>`s, `type=date`, `type=file` and radio/checkbox, all unthemed in dark (`33-history-dark-1440`, `50-modules-dark-1440`). | as cited | Medium | M |
| VD-5 | Page anatomy differs per route. The title is 16 px semibold in some places, 14 px in others and missing in others. Store has a back link, Products a top-right primary, People and Account a centred narrow column, Modules a bare stack and Settings a two-column form capped at 470 px. | `30-store-light-1440`, `32-products-dark-1440`, `51-people-light-1440`, `53-account-light-1440`, `50-modules-light-1440`, `40-settings-light-1440` | High | M |
| VD-6 | Icons: Tabler is used, but the mapping is muddled. Settings uses a *building*, Modules uses the *settings gear*, Numbers a *list*; Jobs and History are close in weight. Stroke widths are mixed. | `49b-code-modules-installed-light-1440` | Low | S |
| VD-7 | Editor (`cs:` prefixed, `editor.css` 6.5 k lines) and app (unprefixed) share tokens but not components. Library, editor and wire builder each carry their own table and toolbar CSS. | code audit | Medium | L |
| VD-8 | Dark mode: the React Flow attribution renders as a white box under the minimap, document previews sit on white paper with no frame, and the selected row in the Library list is low-contrast brown. | `14-cable-complex-dark-1440`, `13-cable-documents-dark-1920`, `94-library-wire-detail-dark-1440` | Medium | S |

### 2.2 Information architecture and navigation

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| IA-1 | The flat rail has 12 links plus module routes, and it grows when a code module installs (Modules appeared after FX-rates). People and API tokens are first-class rail items next to Cables. | `03-after-setup-light-1440`, `49b-code-modules-installed-light-1440` | High | M |
| IA-2 | One concept, four places: **Store** (`/library/store`), **Modules** (`/modules`: installed packs + "Install pack…" + bundled modules), **Settings › Code modules**, **Settings › Catalog stores**, with cross-links between them ("Configure stores", "Manage installed modules", "Installed packs & uploads"). | `30-store-light-1440`, `50-modules-light-1440`, `47-settings-stores-light-1440`, `49b-code-modules-installed-light-1440` | High | M |
| IA-3 | Library toolbar crams 7 buttons and 4 filters into one row: `+ New connector`, `Import…`, `Bulk CSV…`, `Browse store`, `Connections CSV…`, `Compare`. Imports should be one menu. | `20-library-connectors-light-1440` | Medium | S |
| IA-4 | Part numbers has a rail item ("Numbers"), a Settings section and setup fields. The Part numbers page is an audit report that belongs under Library or Settings. | `35-part-numbers-light-1440`, `42-settings-numbering-light-1440` | Medium | S |
| IA-5 | Pages have no `document.title` per route (always "WireHub") and no `<h1>`. Tabs and history are indistinguishable. | a11y probe | Medium | S |
| IA-6 | Board import (a bundled module) appears in the rail of every install, even with no boards. | `03-after-setup-light-1440`, `54-board-import-light-1440` | Medium | S |

### 2.3 First run and onboarding

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| FR-1 | Setup shows the app shell and nav, an Offline chip and a "Workbench unreachable" toast caused by 503s from APIs that do not exist before setup. | `00-setup-light-1440` | High | S |
| FR-2 | The setup form is long and flat: Organisation, Admin, Catalog, Part numbers (10 prefix fields), Domain modules, Other domains, then the Setup code last. Part-number prefixes are an expert choice that should have a default and be collapsed. | `01-setup-full-light-1440` | Medium | S |
| FR-3 | After setup you land on a list of 13 cables with every PN "–", one odd `CBL-00010-XX`, and an empty Product column. Nothing says "open one" or "make one". | `03-after-setup-light-1440` | High | S |
| FR-4 | The starter catalog prints "UNMAPPED" in red and "no part number" on every document, so the example output looks broken. | `13-cable-documents-light-1440`, `8x-doc-bom-light-1440` | High | S |
| FR-5 | No starter part has a 3D model, so the Library's 3D tab is disabled everywhere ("No 3D model yet"). The showcase feature is invisible on a fresh hub. | `92-library-connector-detail-light-1440` | Medium | M |
| FR-6 | Empty states are one grey line ("No products yet.") with no call to action next to it. | `32-products-dark-1440` | Medium | S |

### 2.4 Core workflow: first cable to build sheet

Measured: **15 interactions** through the wizard, and about 10 s automated (a human at the
bench will take 2–3 min). The cable then opens **unwired**. Wiring three conductors needs
6 drags. Three of them failed on the DE-9 art node with no feedback.

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| WF-1 | Pin targets on art-rendered connectors are 2.6 px. Pins are positioned on the face drawing, overlapping, unlabelled and unreachable by keyboard. | `67-new-cable-canvas-light-1440`, `70-canvas-connected-light-1440` | Critical | M |
| WF-2 | The wizard leaves the cable with 0 joints ("the wizard never guesses a joint"), while the review says "Nothing is wrong with this design". It should either propose the obvious by-signal / by-colour mapping as a choice or stop claiming the design is clean. | `66-wizard-review-light-1440` | Critical | M |
| WF-3 | Signal-name leak (top issue 3): colour names are matched against installed signal vocabularies. | `66-wizard-review-light-1440` | Critical | S–M |
| WF-4 | The wizard requires a "Source" citation (the provenance field) on step 1, and the error reads "Say where this information comes from". The same word "Source" names the source *end* on the next step. | `60-wizard-1-light-1440` | High | S |
| WF-5 | End steps default to "A board" (2 synthetic boards) rather than "A plug". Pin counts include the shell ("DE-9 … 10 pins", "RJ45 … 9 pins"). The default cut length is 1830 mm (6 ft) with imperial presets, in an otherwise metric catalog. | `63-wizard-source-picked-light-1440`, `64-wizard-wire-light-1440` | Medium | S |
| WF-6 | Auto-layout of a fresh cable puts J2's handles on the side away from the wire, and the wire node below both connectors. | `67-new-cable-canvas-light-1440` | Medium | M |
| WF-7 | The save-with-warnings dialog is the right idea, but its text uses ids (`conductor 'pair-1.a' of segment 'w1' … (w1:pair-1.a@a)`). | `74-canvas-saved-light-1440` | Medium | S |
| WF-8 | Nodes truncate the part name at about 25 characters ("XLR 3-pin female (cabl…"). At default zoom the 3-node XLR cable fills 60 % of the canvas width with tiny text. | `11-cable-build-light-1440` | Medium | S |
| WF-9 | The documents toolbar has three rows (tabs, a full-width "Export…" select, download buttons) plus a fourth for sheet fields, before any content. | `13-cable-documents-light-1440` | Medium | S |

### 2.5 Feedback, errors, loading, recovery

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| FB-1 | Toasts (sonner) are used 97 times but not for installs, restarts or document saves. Those report as inline text at the end of the page. | `37-install-automotive-after-light-1440` | High | S |
| FB-2 | Restart WireHub has no confirm, no "restarting… reconnected" state, and a native `confirm()` is used elsewhere (5 places). | `A9-restart-1-light-1440` | Medium | S |
| FB-3 | The "Saved 7 min ago" status chip is in the top bar on non-editor pages, where nothing is being edited. | `30-store-light-1440` | Low | S |
| FB-4 | Errors are good where they exist (the wizard's "Not quite yet." blockers, the pre-save warning dialog). Loading is "Loading…" text, with no skeletons. | `60-wizard-1-light-1440` | Low | S |
| FB-5 | Locks and conflicts were not exercised beyond opening the same cable in two sessions: no lock was shown without an edit. Re-test in P1-F. | `A6-lock-tab-b-dark-1440` | — | — |

### 2.6 Accessibility

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| A11Y-1 | Contrast failures (VD-2). | | High | S |
| A11Y-2 | There is no skip link. **20 Tab stops** pass before the first control on Cables, and the table rows are not focusable (0 tabbable rows). | `96-focus-tab14-light-1440` | High | S |
| A11Y-3 | No `prefers-reduced-motion` anywhere (0 hits). Canvas zoom and pan animations ignore it. | code audit | Medium | S |
| A11Y-4 | Canvas pins are not keyboard reachable; there is no alternative wiring path (a connection table *exists* in the inspector and should become the keyboard path). | `70-canvas-connected-light-1440` | High | M |
| A11Y-5 | Focus rings exist (2 px solid) but mix `auto` and solid. Wizard inputs get a double-thick orange ring. | `60-wizard-1-light-1440` | Low | S |

### 2.7 Copy and terminology

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| CP-1 | Product name drift: "WireHub", "the studio" (226 occurrences: "Open studio", "Back to the studio", "the studio did not do that"), "Workbench" (toast) and "hub". | `53-account-light-1440`, `00-setup-light-1440` | Medium | S |
| CP-2 | Cable vs design: the list says Cables, the resolver says "Create design", the History says designs, Products groups "designs". Pick one user-facing noun (cable) and keep "design" for the API. | `A7-resolver-result-light-1440` | Medium | S |
| CP-3 | Docs paths, env vars and internal ids in UI copy (top issue 7). | | High | M |
| CP-4 | Typos and doubling: "Desktop PC with a serial port port", a Markdown backtick in the continuity PDF, "auth ON ()" in the server log. | `A7-resolver-result-light-1440`, `pdf-test-spec-p1` | Low | S |
| CP-5 | Ellipsis on buttons that do not open a dialog (`Import…` is fine, `Install…` opens an inline preview, `Disable…`). | `50-modules-light-1440` | Low | S |

### 2.8 Responsive

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| RS-1 | 390 px works as a viewer: hamburger, cards, Settings as a select. The editor title truncates to "X…" and the canvas is unusable, which is acceptable. State "best on a desktop" on the canvas only. | `11-cable-build-light-390`, `10-cables-light-390` | Low | S |
| RS-2 | At 1920 the documents preview scales the sheet to full width instead of paper size. Settings forms stay at 470 px, leaving 1200 px of empty space. | `13-cable-documents-light-1920`, `40-settings-light-1920` | Medium | S |

### 2.9 Documents and drawing language

Next to commercial harness tools (Zuken E3.cable / Capital formboards, RapidHarness,
WireViz output), WireHub's **content** is at or above par. The continuity spec with
isolation rules and "deliberate opens" is better than most. The **presentation** is three
products:

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| DOC-1 | Three drawing languages: the build sheet has a vertical black band, Plex and numbered steps; the continuity spec has a boxed header and Arial-like tables; the drawing sheet is an ANSI title block in a different sans, with the BOM table in a larger, lighter type and a squashed all-caps cell ("0+2C MICROPHONE CABLE…") that overflows. | `pdf-build-sheet-p1`, `pdf-test-spec-p1`, `pdf-drawing-p1` | High | M |
| DOC-2 | The drawing sheet ignores `paper=A4` (always 792 × 612 pt). | `pdf-drawing-p1` | Medium | S |
| DOC-3 | The UNRELEASED watermark is huge and diagonal across all content. A corner stamp plus a title-block state is the industry norm and still unambiguous. | `pdf-build-sheet-p1` | Low | S |
| DOC-4 | Empty sections print (the continuity "through something" table has headers and no rows), and Markdown backticks leak. | `pdf-test-spec-p1` | Medium | S |
| DOC-5 | Build sheet page 2 is 70 % blank, and the strip diagram floats. | `pdf-build-sheet-p2` | Low | M |
| DOC-6 | The label sheet is two bordered boxes with no cable PN, no barcode or QR, and no colour. | `pdf-labels-p1` | Medium | M |
| DOC-7 | The formboard overview at fit scale overlaps its tile labels ("p1 p2 p3 …" collide). | `8x-doc-formboard-light-1440`, `pdf-formboard-p1` | Medium | S |
| DOC-8 | The schematic is the strongest artefact: clean, with a legend and cross-section. Keep it as the reference language for the others. | `12-cable-schematic-dark-1440`, `pdf-schematic-p1` | — | — |
| DOC-9 | The schematic and label PDFs are **raster** (`X-WireHub-PDF-Renderer: raster`) even with the browser engine configured, so the text cannot be selected or searched and goes soft when printed. The schematic PDF also has no frame or title block, and labels repeat themselves ("hot · Hot", "shield · Braid"). | `pdf-schematic-p1`, `pdf-labels-p1` | Medium | M |

### 2.10 Brand and public site

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| BR-1 | The logo is good (monoline "Wire", badge "Hub", copper node). In the app the wordmark sits next to a second square mark, so there are two logos in 150 px. | `10-cables-light-1440` | Low | S |
| BR-2 | The site uses system fonts and navy primary buttons; the app uses Plex and copper. They should share tokens. | `A0-site-home-light-1440` | Medium | S |
| BR-3 | The site has no hero image, screenshot or GIF, and no "what it looks like" or "what you get" (documents). | `A0-site-home-light-1440` | High | M |
| BR-4 | Docs page is a placeholder that links to raw GitHub Markdown. The docs a newcomer reads first (`docs/self-hosting.md`, 1017 lines) are reference, not a guide. | `A2-site-docs-light-1440` | High | M |
| BR-5 | The store page (`/store/`) needs the published `index.json`; built locally it shows only an error box. Not reviewable here; verify on Pages. | `A3-site-store-light-1440` | Low | — |
| BR-6 | README: stale v0.1.0 note, no screenshots, a long licence section ahead of "what it looks like". CHANGELOG is release-please raw, with no human release notes. | README, CHANGELOG | High | S |

### 2.11 Performance perception

| ID | Finding | Evidence | Sev | Eff |
| --- | --- | --- | --- | --- |
| PF-1 | Fine. Cold `/cables` loads in 1.4 s at 10 Mbit/s with 40 ms latency (1.2 MB transferred). The editor's 1.9 MB chunk loads on demand (cable 0.6 s, library 0.4 s warm). Setup takes 1 s, install of a pack about 5 s with no progress indicator, restart about 15 s. | probe | Low | S |
| PF-2 | No skeletons. The first canvas paint fits-to-view with a visible jump. | | Low | S |

### 2.12 Benchmarks (from general knowledge)

- **n8n:** a calm canvas, a node creator (search, categories, keyboard), a right-side NDV panel,
  one primary per screen, toasts for everything, and dense but generous hit targets (pins about
  12–16 px). Its credentials live in one place with "Set up" deep links, which is the model for
  module settings.
- **WireViz:** text-first, ugly-but-honest output. WireHub's documents already beat it; its
  wins are clarity of the *connector table* on the diagram and zero setup.
- **Commercial harness CAD** (E3.cable, Capital, RapidHarness, Harness Expert): consistent title
  blocks and drawing frames across every sheet, a revision table, a BOM balloon on the drawing,
  and labels with barcodes. Trust comes from sameness.
- **KiCad:** an explicit library and editor split, and pin numbers always visible on symbols:
  the art is a *symbol*, never the hit target alone.
- **Linear-class SaaS:** one page anatomy, one tab style, keyboard-first, a command palette for
  everything, toasts with undo, skeletons, and per-page titles.

---

## 3. Design direction

**Concept: "bench instrument".** WireHub should feel like a good oscilloscope UI or a
datasheet: precise, quiet, dense, legible at arm's length on a big monitor. It keeps today's
warm graphite and paper neutrals and copper accent, which already set it apart from stock
shadcn grey and blue. Prototype tokens: [`prototypes/tokens.css`](prototypes/tokens.css).

### 3.1 Tokens

Port into `packages/editor-react/src/tokens.css` (and generate `tokens.ts` from it; see P1-A).

**Colour.** Keep the families; fix contrast; add field, focus and status-soft tokens:

| Token | Light | Dark | Note |
| --- | --- | --- | --- |
| `--faint` | `#6f6b62` (4.9:1) | `#8b887f` (5.2:1) | was 2.8 / 3.6 |
| `--line-field` *(new)* | `#8a867c` (3.4:1) | `#6a6b72` (3.3:1) | input, select, checkbox boundaries |
| `--line` / `--line2` | unchanged | unchanged | dividers / card edges only |
| `--accent` | `#a4531c` (white text 5.5:1) | `#e39256` | copper; primary action, current nav, selection edge |
| `--focus` *(new)* | `#2f64b0` | `#7ea6db` | focus ring and info, never copper |
| `--selected` *(new)* | accent 9 % | accent 12 % | selected row and card |
| `--ok/-warn/-err/-info` + `-soft` | AA-checked | AA-checked | chips, callouts, issue rows |
| `--board-kind` *(new)* | `#2f8f5b` | `#5fbf8a` | completes conn, wire, comp |

Rules: copper only for *the* primary action, current location and selection; status colours
only for status; the domain colours (`--cond-*`) only for conductors.

**Type** (IBM Plex Sans / Mono; six UI steps):

| Token | px | Use |
| --- | --- | --- |
| `--text-2xs` | 11 | table headers (caps, +0.04em), chips, kbd |
| `--text-xs` | 12 | hints, secondary cells, inspector |
| `--text-sm` | **13** | base: controls, body, table cells |
| `--text-md` | 14 | panel and dialog titles |
| `--text-lg` | 16 | page title (`h1`) |
| `--text-xl` | 20 | setup and empty-state headline only |

Mono is used for identifiers only: PNs, ids, pin numbers, dimensions. Nothing below 11 px in
the UI; documents keep their own print scale (DOC-1).

**Space.** A 4 px grid: 2, 4, 6, 8, 12, 16, 24, 32. **Radius**: 2 (chips), 4 (controls),
6 (cards, menus), 8 (dialogs, drawers). **Control height**: 22 (canvas toolbar, table inline),
26 (default), 30 (dialog and page primary). **Elevation**: three shadows. **Motion**: 120 / 180 ms
with one easing, and 0 under `prefers-reduced-motion`.

### 3.2 Density

There is a single density, the current one, formalised: 32 px table rows, 26 px controls and
13 px base. No "comfortable mode" in P0–P1 (owner preference); revisit if users ask. Hit
targets are larger than they look. Canvas pins are drawn at 8 px with a **16 px hit area**, and
rail items are 40 × 36.

### 3.3 Icons

Keep **Tabler** at stroke 1.75, size 16 in controls and 20 in the rail. Use one icon per
concept, written down in `packages/editor-react/src/icons.ts`:

| Concept | Icon |
| --- | --- |
| Cables | `list-details` |
| Library | `box` |
| Find a cable | `route` |
| Products | `packages` |
| History | `history` |
| Jobs | `checklist` |
| Extensions | `puzzle` |
| Settings | `settings` |
| Account | avatar |
| Connector | `plug` |
| Wire stock | `line` |
| Component | `resistor` (custom) |
| Board | `cpu` |
| Kit | `stack-2` |

### 3.4 Page anatomy (one pattern everywhere)

```
┌rail┬ top bar: org / page ▸ item · search (Ctrl K) ·········· status · theme ┐
│ ▣  ├─────────────────────────────────────────────────────────────────────────┤
│ ▤  │ H1 Title  count            (secondary)  (secondary)  [Primary  N]        │ ← page header 44px
│ ⌁  ├─────────────────────────────────────────────────────────────────────────┤
│ ▦  │ filter input · chip filters ······························ view toggles │ ← toolbar 36px
│ ── ├──────────────────────────────────────────────┬──────────────────────────┤
│ ↺  │ content (table / grid / canvas)               │ detail panel (360px)     │
│ ☑  │                                               │ title · id · chips       │
│    │                                               │ preview                  │
│ ⧉  │                                               │ key / value              │
│ ⚙  │                                               │ actions                  │
│ ◯  ├──────────────────────────────────────────────┴──────────────────────────┤
└────┴ status bar: connection · backend ························ version / save ┘
```

There is no paragraph under the H1; an optional `(?)` next to it carries the explanation.
Settings pages use the same header plus a section nav. Forms max out at 640 px, with a
right-hand "what this affects" column at ≥ 1600 px. Prototype:
[`prototypes/shell.html`](prototypes/shell.html) (`P-proto-shell-light`, `P-proto-shell-dark`).

### 3.5 Navigation (proposed)

```
Work      Cables · Library · Find a cable · Products
Activity  History · Jobs
──────────────────── (bottom)
Extensions   (Browse · Installed · Sources)  ← Store + Modules + Code modules + Catalog stores
Settings     (Documents · Engineering · Part numbers · Rules · Sign-in · People · Integrations
              [webhooks, notifications, PDF engine] · Modules [their settings] · System [runtime, restart, key])
Avatar menu  My account · API tokens · Theme · Sign out
```

Module routes (Board import, …) register into a *place*: a Library "Import" menu entry, a
Settings section or an Extensions tab. They do not get a rail item unless they declare
`placement: 'rail'` and the owner allows it. Part numbers (the audit page) becomes Library ›
Numbering.

### 3.6 Module slot policy (fixes top issue 1)

- Module-contributed panels render in a **titled, collapsible frame** (`<ModuleSlot>`) with the
  module's name and a "module" chip. They sit **after** core content, collapsed by default.
  The owner can pin a slot open, and the choice is remembered per user.
- A module whose settings are incomplete renders **one line**: "Suppliers is not set up ·
  Set up →" (a deep link to Settings › Modules › Suppliers), never its form.
- Slot order is declared by the host, not by install order.
- The documents view gets a **Tools** popover on the toolbar for module actions (FX report,
  procurement CSV). Module UI never sits above the sheet.

Prototype: the collapsed "Suppliers / FX" frames in [`prototypes/editor.html`](prototypes/editor.html)
(`P-proto-editor-light`).

### 3.7 Canvas and editor

- **Every connector node shows a pin list** (number, name, direction) with 16 px handles. The
  art becomes a 54 px thumbnail in the node header, or a "face" toggle that *overlays* labelled
  pins at a minimum 16 px. Art is never the only target.
- **Node creator** (n8n): `Tab` or a `+` on any free pin opens a search popover grouped by
  Connectors, Wire stocks, Components and Boards, with a "From the store" row offering
  installable matches.
- **Wizard to canvas**: the wizard offers "Connect by signal / by colour / leave open" with a
  preview. "Nothing is wrong" is only said when there are joints and no floating conductors.
- Long nodes collapse after 5 rows ("4 more ▾").
- Issues are sentences with a fix button: "Pair 2 · white/orange is not connected at either
  end. [Mark spare]".
- A keyboard path: the inspector Connection table (pad, side, conductor) supports add, edit
  and delete fully by keyboard.

### 3.8 Documents: one drawing language

Use the schematic's language as the reference: Plex Sans/Mono, 0.5 pt hairlines, mono
identifiers, the conductor colours. Every sheet gets the **same frame and title block**: org,
title, PN, rev, state, sheet n of m, paper, drawn and checked, and a revision table on
drawings. Replace the diagonal watermark with a corner state stamp plus a title-block state.
`paper` is honoured everywhere. Empty sections are omitted. The starter catalog gets part
numbers so the examples print clean. Labels get the PN, both ends and an optional QR code.

### 3.9 Component inventory (what to build and standardise)

| Group | Components |
| --- | --- |
| Actions | `Button` (primary · secondary · ghost · danger; xs/sm/md), `IconButton` (+ tooltip, required label), `SplitButton`, `Kbd` |
| Inputs | `Field` (label · hint · error · `(?)`), `Input`, `NumberInput` (unit suffix), `Textarea`, `Select` (Radix), `Combobox` (search + create), `Checkbox`, `Radio`, `Switch`, `SegmentedControl`, `FileDrop` (replaces `<input type=file>`), `DateInput` |
| Navigation | `Rail`, `TopBar`, `Breadcrumb`, `Tabs` (one style: underline), `SectionNav` |
| Layout | `PageHeader`, `Toolbar`, `SidePanel` (detail), `Drawer`, `Split` (resizable), `EmptyState`, `Section` |
| Data | `DataTable` (TanStack wrapper: sticky header, focusable rows, ↑↓ Enter, selection to detail panel, column menu), `KeyValue`, `Chip`, `StatusDot`, `Badge`, `Diff` |
| Feedback | `Toast` (sonner preset: success · info · warn · error · with action and undo), `Callout` (one line + "details"), `ConfirmDialog` (replaces `confirm()`), `Progress` (install, restart), `Skeleton`, `InlineError` |
| Overlays | `Dialog`, `Popover`, `Menu`, `Tooltip`, `CommandPalette` (keep cmdk) |
| Domain | `ModuleSlot`, `PartRow` (kind glyph · name · PN · chips), `ConnectorNode`, `WireNode`, `PinHandle`, `NodeCreator`, `IssueRow`, `SheetFrame` |

Location: `packages/editor-react/src/ui/` (exported, so modules can use it through the module
API's React surface). The app's `src/shell` uses the same pieces. Utilities: Tailwind 4
`@theme` maps tokens to classes in both prefixes; **lint rule**: no `text-[Npx]`, no hex in
TSX or CSS outside `tokens.css`, no native `select` (ESLint `no-restricted-syntax`, or a
vitest grep test in the style of the repo's existing privacy and skills tests).

---

## 4. Phased roadmap

Lanes: at most **3 agents in parallel**, each in its own worktree. Size tags: **[S]onnet** for
well-specified, local tasks; **[O]pus** for cross-package, judgement-heavy or interaction
design. **[OWNER]** marks a decision needed before the task starts (see §5). Every task's
acceptance includes `pnpm build`, the workspace's tests with `--maxWorkers=2`, the privacy
check, and before and after screenshots in the PR at 1440 light and dark.

### P0: Embarrassment removal (about 1 week, 3 lanes)

Goal: a newcomer's first 15 minutes contain no errors, no hijacked screens, no lies and no
dead ends.

| Epic | Task | Size | Depends | Acceptance |
| --- | --- | --- | --- | --- |
| **P0-A First run** | A1. Setup route renders without the rail and top-bar status, and suppresses the offline probe and toast until setup completes. | S | — | No `Offline` chip and no toast on `/setup` (Playwright). |
| | A2. Reorder setup: Organisation → Admin → Setup code (moved up, with a "copy the command" button) → Domains → Advanced (catalog choice, part-number prefixes) collapsed. | S | A1 | The setup code field is visible at 1440 × 900 without scrolling. |
| | A3. "New hub" strip on Cables (one line, 4–5 linked steps, dismissible, per hub) plus real empty states for Products, History, Jobs and Library kinds. | S | — | Fresh hub shows the strip; dismiss persists; each empty state has one primary action. **[OWNER] O-2** |
| | A4. Starter catalog: assign part numbers to every starter record and example cable; drop the stray `CBL-00010-XX`. | S | — | The starter build sheet and BOM print no "UNMAPPED" or "no part number". Catalog validators green. |
| **P0-B Modules behave** | B1. `ModuleSlot` frame: titled, collapsible, after core content, collapsed by default, with a "not set up" one-liner for incomplete settings. Wire up Library detail and Documents. | O | — | With FX-rates and Suppliers installed, Documents shows the sheet first and the Library detail shows the definition first (screenshot diff). Module API stays backward-compatible (`packages/modules` tests). |
| | B2. Documents "Tools" popover for module exporters and actions; remove the module panel from above the sheet. | S | B1 | Documents toolbar is 2 rows maximum. |
| | B3. Module routes do not add rail items by default; Board import moves into the Library Import menu. | S | — | Rail shows ≤ 9 items after installing every official extension. **[OWNER] O-3** |
| **P0-C Canvas truth** | C1. Fix the signal-vocabulary leak: colour words never match signal names, and signal matching uses the vocabulary's declared ids only. Add a regression test with the AV pack installed. | O | — | The wizard review for DE-9 to RJ45 with AV installed mentions no video signals. |
| | C2. Connector nodes always render a pin list with 16 px handles; art becomes a header thumbnail. | O | — | A Playwright drag from W1 to J1 pin 2 creates a joint on DE-9, XLR, RJ45 and HD15. |
| | C3. Validation: a design with floating conductors at both ends is a warning in the wizard review, the Issues panel and the status bar; the wizard no longer says "Nothing is wrong" then. | S | — | Model test plus wizard DOM test. |
| | C4. Issue and warning sentences use human names (`J1 pin 2 · RXD`, `W1 pair 1 · blue`), never `w1:pair-1.a@a`. | S | C3 | Snapshot tests for the save dialog and Issues. |
| **P0-D Feedback** | D1. Installs, uninstalls, restarts and document saves use toasts (success with "View", error with detail). | S | — | No end-of-page status text remains (grep plus DOM tests). |
| | D2. The store install preview opens in a right drawer next to the card (summary counts first, "Show all records" second). | S | — | The preview is visible without scrolling at 1440 × 900. |
| | D3. Restart: a `ConfirmDialog`, then a progress state ("Restarting… reconnected in 14 s"). Replace the 5 `confirm()` calls. | S | — | Playwright restart flow shows both states. |
| **P0-E Front door** | E1. README: a hero screenshot and a 20-second GIF (wizard to canvas to build sheet), "What you get" (4 document thumbnails), the stale v0.1.0 note removed, the licence moved down. | S | P0-C (for clean shots) | Renders on GitHub; images ≤ 1.5 MB total. |
| | E2. Site home: the same hero and document strip, app fonts and copper tokens (a shared `brand/tokens.css`). | S | E1 | Lighthouse a11y ≥ 95. |
| | E3. Copy sweep 1: remove `docs/*.md` paths, env var lists, migration numbers and pg-boss ids from UI text, replacing them with `(?)` tooltips and "Learn more" links. "Studio" and "Workbench" become WireHub. "Port port" fixed. | S | — | `grep` test: no `docs/` path or `WIREHUB_` string in rendered UI copy (allow-list for Settings › System). |
| | E4. Contrast hotfix: the new `--faint`, `--line-field` and light `--accent` values (§3.1). | S | — | An automated contrast test over the token pairs. |

Suggested lanes: **Lane 1** P0-C (opus), **Lane 2** P0-B then P0-D (opus, then sonnet),
**Lane 3** P0-A then E3, E4 (sonnet). E1 and E2 go last, after C lands.

### P1: Coherent system (about 2–3 weeks, 3 lanes)

Goal: one look, one anatomy and one navigation; keyboard and contrast at AA.

| Epic | Task | Size | Depends | Acceptance |
| --- | --- | --- | --- | --- |
| **P1-A Tokens** | A1. Full token set (§3.1) in `tokens.css`; generate `tokens.ts` from it with a build script plus test (no hand sync). Tailwind `@theme` for both prefixes. | O | P0-E4 | One source; test fails on drift. |
| | A2. Lint and test guard: no `text-[Npx]`, no raw hex outside tokens, no native `select` and no `confirm()` in TSX (allow-list shrinks per PR). | S | A1 | CI test green with an explicit allow-list. |
| **P1-B Components** | B1. `ui/` primitives: Button, IconButton, Field, Input, Select, Combobox, Checkbox, Switch, Segmented, Tabs, Chip, Tooltip, Dialog, ConfirmDialog, Drawer, Callout, Toast preset, Skeleton, FileDrop. A Storybook-free gallery route `/dev/ui` in dev builds only. | O | A1 | Every primitive in light and dark on `/dev/ui`; DOM tests for keyboard and ARIA. **[OWNER] O-5** |
| | B2. `DataTable` (TanStack) with focusable rows, ↑↓/Enter, selection to `SidePanel`. Replaces the Cables, Library, Jobs, History and Part numbers tables. | O | B1 | 0 non-DataTable tables in routes; keyboard test. |
| | B3. `PageHeader`, `Toolbar`, `SidePanel`, `EmptyState` adopted by every route. | S | B1 | Visual check: every route matches §3.4 (screenshot set). |
| **P1-C Navigation** | C1. Rail groups (§3.5), avatar menu (Account, API tokens, theme, sign out), People under Settings. | S | B1 | Rail ≤ 8 items plus avatar; all old URLs redirect. **[OWNER] O-3** |
| | C2. **Extensions** page (Browse cards with facets and drawer · Installed · Sources) replacing Store, Modules, Code modules and Catalog stores. | O | B1, P0-D2 | One place; old routes redirect; install, uninstall and consent flows covered by tests. Prototype: `extensions.html`. |
| | C3. Per-route `document.title`, one `h1` per page, skip link, landmark audit. | S | B3 | axe-core run on every route: 0 serious or critical. |
| **P1-D Editor** | D1. Node creator (Tab or pin `+`), with search over library plus store matches. | O | P0-C2 | Add a connector at a pin in ≤ 3 keystrokes (test). |
| | D2. Wizard "connect by signal / colour / leave open", with a preview in the review step. | O | P0-C1 | XLR, RJ45 and DE-9 examples connect fully by signal. |
| | D3. Keyboard wiring via the Connection table; canvas reduced motion. | S | B1 | Wire a 3-conductor cable without a mouse (test). |
| | D4. Fresh-layout heuristics: connectors on the outside, wire in the middle, handles facing the wire. | O | — | New cables open with no crossing back-edges for 2-ended designs. |
| **P1-E Documents** | E1. `SheetFrame`: one frame and title block for all sheets; corner state stamp; `paper` honoured on the drawing. | O | — | All PDFs share frame metrics (golden SVG tests updated deliberately). **[OWNER] O-6** |
| | E2. Drawing-sheet typography moves to Plex; fix table overflow; revision table. | S | E1 | No text overflow at A4 or Letter (layout test). |
| | E3. Omit empty sections; strip Markdown from printed text; fix formboard overview label collisions. | S | — | Continuity PDF has no empty tables or backticks. |
| | E5. Vector schematic and label PDFs through the browser engine (or the SVG-to-PDF path), inside `SheetFrame`. | S | E1 | `X-WireHub-PDF-Renderer` is not `raster` when an engine is set; text is selectable. |
| | E4. Documents preview at paper size with zoom (fit width / 100 %); toolbar ≤ 2 rows. | S | P0-B2 | At 1920 the sheet keeps its proportion. |
| **P1-F Copy and QA** | F1. A terminology file (`docs/design/terminology.md`): cable vs design, source *end* vs provenance ("Reference"), Extensions, pack, module. Rename the UI strings to match. | S | — | Wizard field is "Reference (where the data comes from)". **[OWNER] O-4** |
| | F2. Re-shoot the full screenshot set (this plan's script) plus lock and conflict scenarios; file follow-ups. | S | all P1 | A refreshed screenshot set, kept outside the repository. |

Lanes: **1** A then B (opus), **2** D (opus), **3** E then F (opus then sonnet), with C
picked up by whichever lane frees first after B1.

### P2: Delight and growth (ongoing)

| Epic | Task | Size | Depends | Acceptance |
| --- | --- | --- | --- | --- |
| **P2-A Demo** | A1. A read-only public demo hub, as a static export or a reset-nightly container, with the official packs. | O | P1 | A link in the README and site; resets daily. **[OWNER] O-1** |
| | A2. "Open an example" sample hub content: 6 polished cables across domains, each with PN, revision, notes and a 3D model. | S | P0-A4 | Every example prints clean and shows 3D. |
| **P2-B Library 3D** | B1. Ship CC0 or parametric 3D for starter connectors (DE-9, XLR, RJ45, JST XH, terminal block) so the 3D tab is live on a fresh hub. | O | — | 3D enabled for every starter connector. **[OWNER] O-7** |
| **P2-C Docs site** | C1. Docs on Pages (Starlight or similar, static): Quick start, First cable (with GIFs), Concepts, Self-hosting, Modules, API. Generated from `docs/` with a curated nav. | O | P0-E | A newcomer path of ≤ 4 pages from install to first build sheet. |
| | C2. Human release notes per minor (a highlights section above release-please output), with screenshots. | S | — | 0.7 notes lead with what changed for users. |
| **P2-D Polish** | D1. Skeletons and optimistic updates on lists; first canvas paint without a fit jump. | S | P1-B | No layout jump on open (CLS ≈ 0). |
| | D2. Labels: PN, ends, QR code; label-printer presets (Brady/Dymo sizes as data). | O | P1-E | Label PDF matches the presets. |
| | D3. Undoable toasts for destructive actions (delete part, disable pack). | S | P1-B | Undo restores within 10 s. |
| | D4. Optional "comfortable" density, only if requested by users. | S | P1-A | Token-only switch. |
| **P2-E Brand** | E1. One mark in the app top bar (drop the duplicate square), favicon states (dev and prod), a social card image for GitHub and Pages. | S | — | OpenGraph card renders. |

### Dependency sketch

```
P0-C1 ─┬─> P1-D2
P0-C2 ─┴─> P1-D1
P0-B1 ─> P0-B2 ─> P1-E4
P0-D2 ─────────────> P1-C2
P0-E4 ─> P1-A1 ─> P1-A2
                └─> P1-B1 ─┬─> P1-B2, P1-B3 ─> P1-C3
                           ├─> P1-C1, P1-C2
                           └─> P1-D3
P0-C* ─> P0-E1 ─> P0-E2 ─────────────────────> P2-A, P2-C
P1-E1 ─> P1-E2, P2-D2
```

---

## 5. Open questions for the owner (each with my recommendation)

| # | Question | Recommendation |
| --- | --- | --- |
| O-1 | **A public demo hub?** It is the single biggest trust signal for a self-hosted tool. | Yes: a read-only static export first (no server cost, no abuse surface), then a nightly-reset container if cheap. |
| O-2 | **How much onboarding is "hand-holding"?** | Allow exactly one dismissible "New hub" strip and real empty states. No tours, modals or paragraphs. It disappears forever once dismissed. |
| O-3 | **Rail contents and module placement.** May modules add rail items? | No by default. Modules declare a *place* (Library import, Settings section, Extensions tab, document tools). Allow a rail item only for a module the owner pins. People and API tokens leave the rail. |
| O-4 | **Terminology**: user-facing "cable" or "design"? And rename the provenance field from "Source"? | "Cable" in the UI everywhere ("design" stays in the API and docs), and the provenance field becomes "Reference". Keep the wizard's requirement but pre-fill "own design" for hand-made cables, so hobbyists are not blocked. |
| O-5 | **Component foundation**: keep Radix primitives plus our own styles, or adopt a kit? | Radix (already a dependency) plus our own `ui/` and tokens. No shadcn copy-paste, no new kit. That matches "not stock shadcn" and keeps bundle growth near zero. |
| O-6 | **Document language**: is the ANSI drawing-sheet style a requirement (the source shop's house style) or can every sheet move to one WireHub frame? | One WireHub frame for all sheets, with the ANSI/ISO title-block layout selectable as data (paper and standard), so a shop can still match its house style without code. |
| O-7 | **3D models in the base catalog**: may we add CC0 or parametric connector models (size cost in the image), or should 3D live in packs only? | Parametric bodies for the 5 starter connectors in the base (small, deterministic), and real STEP models in packs. |
| O-8 | **Mobile**: stay a desktop tool with a read-only phone view? | Yes. Keep 390 px as a viewer (lists, documents, resolver) and show "Open on a desktop to edit" on the canvas. No mobile editor investment. |
| O-9 | **Site and docs tooling**: keep the hand-built static site, or adopt a static docs generator for P2-C? | Keep the hand-built shell for home, generator and store; add a docs generator for `/docs/` only, styled with the shared brand tokens. |

---

## Appendix: method notes

- Stack: the published `ghcr.io/formless63/wirehub:0.6.0` image (built from `05f1067`) with the
  repository's `compose.yaml`, run under its own project name on `127.0.0.1:5800`, with the
  `pdf` profile. The site was built with `node site/build.mjs` and served on `127.0.0.1:5801`.
- Screenshots: playwright-core with Chromium, viewports 1440 × 900, 1920 × 1080 and 390 × 844,
  `colorScheme` and the app's stored theme set per run. PDFs come from the documents API and
  were rasterised at 90 dpi.
- Measurements: font sizes, radii, selects, `confirm()` and `docs/` mentions by `grep` over
  `apps/`, `packages/` and `modules/`; contrast by the WCAG relative-luminance formula; the pin
  hit area from the handle's bounding box; load times with CDP network emulation
  (10 Mbit/s, 40 ms).
- Not covered: OIDC, magic-link and SMTP flows; backups (Backrest); multi-user lock conflicts
  under real concurrent edits; the published Pages store index.

---

## Decisions (owner, 2026-10-08)

These override the recommendations above wherever they differ.

| # | Decision |
| --- | --- |
| O-1 | **Demo hub: not yet.** P2-A is deferred. |
| O-2 | **Accepted** (one dismissible strip plus empty states). In addition: the Pages site needs good documentation on using the app, and the app gives easy access to the relevant docs from wherever the user is (contextual help links). The docs site moves from P2-C up to P1-G. |
| O-3 | **Accepted** (modules declare a place; no rail items by default). |
| O-4 | **"Design" is the user-facing noun**, not "cable": people model harnesses and assemblies that are not cables. The provenance field still becomes "Reference". |
| O-5 | **Use good FOSS components where they help**: shadcn/ui (on Radix), evilcharts, Aceternity UI and Magic UI, themed with WireHub tokens so the result still reads as WireHub. |
| O-6 | **Accepted** (one WireHub sheet frame; ANSI or ISO title block as data). |
| O-7 | **Both** for the starter connectors: parametric bodies in the base and STEP models (in packs). |
| O-8 | **Accepted, read-only on phones**, but nearly everything should be viewable there for quick reference (libraries, designs, documents, resolver), not only lists. |
| O-9 | **Accepted** (hand-built site for home, generator and store; a docs generator for `/docs/`). |
