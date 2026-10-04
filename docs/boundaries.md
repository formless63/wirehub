# Boundaries — what the base took, and what it left behind

This repository is the **open base** of WireHub. It was copied, on
2026-10-04, out of a private studio repository that one shop used to capture
its own production cables. That private repository is now frozen: it keeps
running as a reference, and as the worked example for building private
modules on this base (`docs/modules.md`).

This file is the record of the split. Every package, app module, script,
spec, data folder and feature of the private repository is classified as one
of:

| Class | Meaning |
| --- | --- |
| **BASE** | copied as is (apart from renames and comment scrubbing) — generic |
| **BASE-gen** | BASE after generalizing — the *how* is in the row |
| **MODULE** | stays private; to be rebuilt later as a module on this base |
| **DROP** | not carried forward at all |

"Scrubbed" means comments, examples and test strings were rewritten to drop
the private shop's names, part numbers, hosts, people and product names.
Nothing in this repository was copied from the private repository's data
folders: the catalog here is a new, synthetic starter catalog.

Names used below for things left behind are deliberately generic (the
"private ERP", the "board designer's share", the "console resolver"): the
privacy check (§9) must stay clean, including this file.

## 1. Repository level

| Item | Class | Notes |
| --- | --- | --- |
| git history | DROP | fresh history; the private `.git` was never copied |
| `SPEC.md` | BASE-gen | rewritten for the base: the model, the starter catalog, the phase plan |
| `AGENTS.md` / `CLAUDE.md` | BASE-gen | rewritten; no private paths, hosts or remote |
| `README.md` | BASE-gen | new |
| `LICENSE` | BASE-gen | AGPL-3.0-only, with the WireHub Module Exception (`LICENSE-EXCEPTION.md`); `packages/modules` MIT |
| `NOTICE` | BASE-gen | now lists the embedded fonts; the 3D-library section went with the model import script |
| `package.json` (root) | BASE-gen | deploy scripts removed; `packageManager` pinned; tests run one workspace at a time |
| `pnpm-lock.yaml` | BASE-gen | regenerated from the base's package set |
| `docker-compose.yml` | BASE-gen | a generic single-container compose (port 5183, catalog mounted); no proxy network, no deploy keys, no private mounts; on the rename to WireHub replaced by `compose.yaml` (app + Garage + PostgreSQL) and `compose.backup.yaml` (`docs/self-hosting.md`) |
| `docker/studio.Dockerfile` | BASE-gen | replaced by `docker/app.Dockerfile`, a self-contained image (install + bundle + serve) |
| `scripts/studio-deploy-live.sh` | DROP | the private live-clone deploy |
| `.claude/settings.json` | DROP | per-machine settings |
| `.beads/` | DROP | a new beads database was initialised here (`bd init`) |
| `data/auth/.gitkeep` | BASE | the login's local state folder |

## 2. Packages

### 2.1 `packages/core` → `packages/model` (`@wirehub/model`)

Renamed: the word "core" names a separate product; the truth model is now
`@wirehub/model`. Every import was updated.

| Module | Class | Notes |
| --- | --- | --- |
| `model.ts` | BASE-gen | product grouping, productize decision, production route, route products and the recipe field removed from `CableDesign`; a generic `extensions?: Record<string, unknown>` added for module-owned data |
| `paths.ts`, `nets.ts`, `bonds.ts`, `breakouts.ts`, `link-elements.ts`, `design-edit.ts`, `migrate-schema.ts`, `usage.ts`, `connector-mounting.ts`, `strip-practice.ts`, `signals.ts`, `vocab.ts`, `versions.ts`, `interfaces.ts`, `compat.ts`, `builds.ts`, `board-parts.ts`, `board-journey.ts`, `wire-recipe.ts` | BASE | scrubbed |
| `validate.ts` | BASE-gen | product/route checks removed; `extensions` shape check added |
| `kits.ts` | BASE-gen | the private SKU grammar replaced by a generic token rule; the stock-family split is `coax` / `bonded` |
| `assembly.ts` | BASE-gen | the device-catalog lookup removed (commoning facts come from tags only) |
| `migrate-bonds.ts`, `ground-faces.ts` | BASE | the per-screen → pigtail grouping the wizard uses |
| `recipe.ts` → `body.ts` | BASE-gen | the design body, its diff and the override patch language kept; the recipe types and `captureHandEdits` went to the module side (an editor commit hook replaces the latter) |
| `wire-display.ts` | BASE-gen | stock names from the wire's own label and lay order; no family table |
| `part-numbers.ts` | BASE-gen | **pluggable**: a `PartNumberScheme` interface, a built-in prefix scheme (`CON-00001`) configured by an optional `part-numbers.json`, `knownPartNumbers()`; the private scheme, register parsing, reconciliation and rule inference left behind |
| `devices.ts`, `rules.ts`, `resolve.ts`, `derive-design.ts`, `derive-joints.ts`, `infer-recipe.ts`, `journey.ts` | MODULE | the console resolver: devices, input requirements, conditioning, hazards, ranking policy, recipe derivation and inference, the cable journey |
| `board-proposal.ts` | MODULE | board proposals from resolver gaps |
| `lineup.ts`, `products.ts` | MODULE | the product lineup and product merge/split |
| `production-route.ts` | MODULE | in-house vs contract-manufactured routes, keyed on private PN series |

### 2.2 `packages/catalog` (`@wirehub/catalog`)

| Item | Class | Notes |
| --- | --- | --- |
| `src/catalog.ts`, `src/source.ts`, `src/index.ts` | BASE-gen | every file but `connectors.json`, `wires.json`, `components.json` is optional; the PN scheme is read from `part-numbers.json`; device/rule/identity/register/reconciliation/pin-table/legacy-board loaders removed |
| `src/depictions/{model,load,validate,svg,anchors,color,outline,import}.ts` | BASE | presentation artwork and the artwork upload normaliser |
| `src/depictions/components.ts` | BASE-gen | only the pure `componentsFor` placement kept |
| `src/depictions/{generate,gerber}.ts` | MODULE | pinmaps-driven generation and the gerber art pipeline over the board designer's share |
| `src/tags/{build,classify}.ts` | BASE | scrubbed; report text generalised |
| `src/importer/*`, `src/kicad/*`, `src/easyeda/*`, `src/components/*`, `src/readme/*` | MODULE | the board importers (pinmaps, KiCad-direct, EasyEDA, fab BOM/CPL, board READMEs) — tied to the share's layout; a generic importer contract now lives in `@wirehub/modules` |
| `src/recipe-check.ts` | MODULE | the recipe report |
| `scripts/*` (40 scripts) | MODULE / DROP | board pipelines, imports and one-shot data migrations of the private catalog; none copied |
| `data/` (every file and folder) | DROP | replaced by a synthetic starter catalog (§4) |
| `data/devices/`, `data/rules/`, `data/builds/`, `data/legacy/`, `data/kicad-maps/`, `data/exports/`, `data/part-numbers/`, `pin-tables.json`, `pcbas.*.json`, `pcba-*.json`, `board-*.json/md`, `models*.json`, `part-revisions.json`, `kicad-models.json`, identity table, gerber/EasyEDA reports | MODULE | the shop's proprietary data: device pinouts, boards, PN tables, sourcing, recipes, imports |
| `data/designs/` | MODULE | the shop's cable designs |
| `depictions/` (213 folders of board art) | MODULE | the shop's board artwork |
| `fixtures/v1/` | BASE-gen | rebuilt as a frozen copy of the starter catalog |
| `test/*` (24 files) and `test/fixtures/*` | DROP | bound to the private data; replaced by `test/catalog.test.ts` |

### 2.3 `packages/layout`, `packages/render-svg`

| Item | Class | Notes |
| --- | --- | --- |
| `layout/src/*` | BASE | scrubbed |
| `layout/src/connector-art.ts` | BASE-gen | the console-specific connector drawings removed; DIN, mini-DIN, D-sub, HD15, SCART, JP21, RCA, TRS, BNC drawings kept |
| `render-svg/src/*` | BASE | scrubbed |
| `render-svg/src/proposal.ts` | MODULE | board proposal schematic |
| `render-svg/scripts/*`, `render-svg/raster-baselines/` | DROP | preview/measurement tools and raster baselines of private designs |
| goldens (`__snapshots__`) | BASE-gen | regenerated over the starter catalog |

### 2.4 `packages/docs` (`@wirehub/docs`)

| Item | Class | Notes |
| --- | --- | --- |
| `bom.ts`, `bom-render.ts`, `test-spec*.ts`, `passages.ts`, `landings.ts`, `standalone.ts`, `styles.ts`, `supplied.ts`, `text.ts`, `units.ts`, `build-sheet.ts` | BASE | scrubbed; ERP export options removed |
| `bom-sheet.ts` | BASE-gen | now derived straight from `deriveBom` (was: the ERP export payload); unmapped parts carry the pluggable scheme's proposal |
| `bench/*` | BASE | the bench build sheet |
| `bench/header.ts` | BASE-gen | PN resolution is `productRef` → drawing PN; generic length-family notation (`…-XX`); no default designer name |
| `bench/standard-work.ts` | BASE-gen | the shop's written work instructions replaced by a small generic step set; a module can supply its own |
| `drawing/*` | BASE-gen | the ANSI-A drawing sheet kept; the shop's traced faces, cutaway art, logo, marking font and rights line removed (`drawing/assets.ts` is an empty hook) |
| `wire-spec.ts` | BASE-gen | organisation, standard name and rights line are options (default "WireHub Standard", `WSS_` file prefix) |
| the ERP folder (contract, transport, identity table, PN reconciliation, numbering status, mock server) | MODULE | the private ERP integration |
| `lineup-export.ts` | MODULE | the configurator lineup export |
| the shop's brand font and its licence | DROP | branding |
| `scripts/*` | MODULE / DROP | ERP identity/report/contract tools, PN report, lineup export, previews, the drawing-asset extractor |

### 2.5 `packages/editor-react`

| Item | Class | Notes |
| --- | --- | --- |
| canvas, nodes, store, picker, library, wizard, documents, inspector, 3D viewer, wire builder, artwork, board journey, build editor | BASE | scrubbed |
| `store.ts` | BASE-gen | the recipe capture replaced by a module commit hook (`setCommitHook`) |
| `part-numbers.ts`, `panels/PartNumberField.tsx` | BASE-gen | over the pluggable scheme |
| `library-table.ts` | BASE-gen | PN column = the record's own number (or its body's); no register tier |
| `stock-swap.ts` | BASE-gen | generic `withTrunkStock` / `canSwapTrunkStock`; the one-stock shortcut removed |
| `panels/useDesignLifecycle.ts`, `DesignActions.tsx`, `DesignLifecycleDialogs.tsx`, `CableEditor.tsx` | BASE-gen | the two shop-specific "make a variant" actions and the recipe UI removed |
| `body-templates.ts` | BASE-gen | console connector templates removed |
| `panels/{CableJourney,RecipeBar,RecipePanel,KnownPinsDialog,ProposalDetail}.tsx`, `cable-journey.*`, `recipe-edit.ts` | MODULE | the resolver UI |
| the two ERP export/report panels | MODULE | the ERP export UI |
| `bare-scart.ts` | MODULE | a shop-specific design transform |
| `compare/*`, `revisions.ts`, `panels/RevisionsSection.tsx`, `compare.css` | MODULE | board-revision compare over the board designer's files |
| `scripts/*` | DROP | one-off generators |

### 2.6 `packages/modules` (new)

| Item | Class | Notes |
| --- | --- | --- |
| `@wirehub/modules` | BASE (new) | the build-time module registry (`docs/modules.md`) |

## 3. `apps/studio`

| Item | Class | Notes |
| --- | --- | --- |
| `server/api.ts` | BASE-gen | rules/devices/identity/register/reconciliation routes removed; module routes under `/api/modules/<id>/…`; module validation rules run with `validateDesign` |
| `server/{assets,atomic-write,definition-store,definitions,depictions,designs,drawings,etag,hono-adapter,json-text,me,plugin,request-guard,serve,standalone-app,static,versions,vocab,vocab-store,wire-library,write-journal,builds}.ts` | BASE | scrubbed |
| `server/storage/*` | BASE-gen | the declined-proposal record kind removed; derived kinds are `tags` and `module` |
| `server/derived.ts` | BASE-gen | only the `DerivedStore` contract; the PN reconciliation and lineup export left with the module |
| `server/default-deps.ts` | BASE-gen | no ERP link, board import, proposals or revisions; the module registry is wired in |
| `server/modules.ts`, `modules.config.ts` | BASE (new) | the deployment's module manifest |
| `server/auth/*` | BASE-gen | Better Auth: local allow-list, OIDC against any provider (default claim `email`), magic link; no provider-specific defaults |
| `server/locks/*` | BASE | edit leases |
| `server/backup/*` | BASE-gen | the optional git export of saves (`WIREHUB_GIT_AUTOCOMMIT`), with neutral identities and no remote-specific wording |
| `server/models/*` | BASE-gen | 3D model links, uploads, STEP/STL/GLB conversion, KiCad library mapping kept; the share matcher (`match.ts`) and the revision art/import/API left behind; importer-specific paths generalised |
| the ERP server module | MODULE | the ERP push/dry-run endpoints and their environment |
| `server/board-import.ts` | MODULE | the board import runner over the share |
| `server/lineup.ts`, `server/products.ts`, `server/proposals.ts` | MODULE | lineup, product grouping, declined proposals |
| `server/models/{match,revision-art,revision-import,revisions-api,revisions}.ts` | MODULE | the share's model matcher and board revisions |
| `server/scripts/{import-models,kicad-fetch,migrate-drawing-photos}.ts` | MODULE / DROP | importer and a one-shot migration |
| `src/cable-list.ts` | BASE-gen | rewritten: destination, wire, boards, features, PN from `productRef`/drawing; no sync column, product grouping or routes |
| `src/routes/CablesRoute.tsx` | BASE-gen | sync filter, product merge/split, lineup link and register-only rows removed |
| `src/routes/{CableRoute,LibraryRoute}.tsx`, `src/versions/*`, `src/shell/*`, `src/commands/*`, `src/locks/*` | BASE-gen | ERP export, compare and import links removed; neutral wordmark and placeholder icon |
| `src/part-numbers.browser.ts` | BASE-gen | scheme from `part-numbers.json` or a module |
| `src/me.browser.ts`, `src/modules.browser.ts` | BASE (new) | who is signed in; the browser registry |
| `src/{<erp>,board-import,lineup,products,proposals,revisions}.browser.ts`, the ERP link hook, `src/routes/{BoardImportRoute,CompareRoute,LineupRoute,LineupPush,ProductDialog,ProposalsView}.tsx` | MODULE | the UI of the module features above |
| `src/shell/RouteChip.tsx` | MODULE | the production-route badge |
| `public/*` icons and the brand mark | DROP | replaced by a neutral placeholder icon |
| `README.md` | BASE-gen | rewritten |

## 4. The starter catalog (new)

Every record cites a public standard or says "synthetic example".

| Kind | Records |
| --- | --- |
| bodies | DE-9 male/female, HD15 male, RJ45 8P8C plug, XLR3 male/female, RCA plug, 3.5 mm TRS plug, USB-A plug, JST XH 2-pin, 4-way terminal block |
| interfaces | RS-232 DTE (TIA-574), RS-485 / PROFIBUS DP (IEC 61158), VGA (VESA DDC), Ethernet MDI (IEEE 802.3, T568B), balanced audio (AES14), RCA, stereo TRS, USB 2.0, DC 2-pin |
| connectors | 11, each `CON-0000n` |
| wires | Cat 5e U/UTP, 2-pair shielded data, microphone 2-core + braid, stereo 2-core + spiral, DC 2 × 24 AWG, VGA 3 × mini-coax + 4 cores |
| components | resistors 150 Ω / 120 Ω, 100 nF capacitor, red LED |
| mechanicals, kits | DE-9 backshell and jackscrews (and a kit of both), RJ45 boot, moulded Y body, heat-shrink |
| boards | one synthetic RS-485 terminal adapter with a jumper-selected 120 Ω termination |
| designs | `db9-null-modem`, `rj45-patch-t568b`, `xlr-mic-cable` (with a length-family drawing), `trs-to-2rca-y` (breakout), `rs485-de9-terminal-board` (board + termination), `usb-a-led-lead` (inline resistor), `vga-monitor-cable` (coax stock) |
| vocab | 19 lists: signals across video, audio, serial, Ethernet, USB, power and ground |

## 5. Specs

| Spec | Class | Notes |
| --- | --- | --- |
| `storage-seam.md` | BASE-gen | ported; the source-vault seam and the private environments removed |
| `postgres-backend.md` | BASE-gen | ported as rev 6 (base): schema, write path, API tokens / batch / dry run, worker kept; private hosts, the blob service of the private deployment, the source vault, the backup host, the proxy and the identity provider replaced by a generic self-hosted deployment and a clean-install section |
| `postgres-backend-EXECUTION.md` | BASE-gen | ported for this repository; private machine rules and the production phase removed |
| `postgres-backend.questions.json`, a private host's capacity script, `prototypes/postgres-backend/*` | DROP | answered questions and host-specific tooling |
| `data-model-v2.md`, `prototypes/data-model-v2-resolver.mjs` | MODULE | the resolver's data model |
| the three ERP API / BOM integration specs | MODULE | the ERP contract |
| `pcba-importer.md`, `board-landings.md` | MODULE | board import over the share |
| `standard-work.md`, `prototypes/standard-work-compose.mjs`, `standard-work.questions.json` | MODULE | the shop's work instructions |
| `shield-bonding.md`, `schematic-svg.md`, `depictions.md`, `connector-art-review.md`, `studio-workbench.md`, `library-overhaul.md`, `ui-redesign.md`, `mockups/` | DROP (for now) | design history of the shared code; full of private examples. Their rules survive in the code's comments and in `SPEC.md`; re-specifying them generically is a follow-up (bead) |

## 6. Tests

`pnpm -r test` is green (counts in §8). Tests whose fixtures were private
designs were ported to the starter catalog where that was cheap; the rest
were dropped. Dropped whole files:

| Package | Dropped test files |
| --- | --- |
| model | `assembly`, `board-proposal`, `bonds`, `compat`, `connector-mounting`, `designs-extended`, `devices`, `ground-faces`, a light-gun lead test, `journey`, `lineup`, `production-route`, `products`, `recipe`, `resolve`, `signals`, a device-specific shell-rule test (`db`, `paths`, `validate`, `nets`, `trace`, `part-numbers`, `breakouts` were rewritten against the starter catalog; `design-edit`, `versions`, `serialization`, `vocab`, `queries`, `link-elements` ported) |
| catalog | all 24 (`board-components`, `board-pipeline`, `board-revisions`, `builds`, `carrier-through`, `components`, `depictions`, `devices`, `easyeda`, `gerber`, `importer`, `interfaces`, `kicad-direct`, `kicad`, `kits`, `legacy`, `pcba-pads`, `pin-tables`, `readme`, `recipes`, `recipe-storage`, `resolver-designs`, `tags`, `wire-recipes`); new `catalog.test.ts` |
| layout | `board-faces`, `branches`, `carrier-dock`, `connector-art`, `cross-section`, `depictions`, `end-face`, `wire-model`; new `starter.test.ts` |
| render-svg | `cross-section`, `depictions`, `entry-guides`, `part-pads`, `proposal`, `structure` (goldens regenerated) |
| docs | the three ERP test files (contract, export, transport), `bom-sheet`, `bom`, `breakouts`, `build-sheet`, `drawing-faces`, `drawing`, `library-pn`, `lineup-export`, `part-numbers`, `products`, `standalone`; new `documents.test.ts`; `test-spec` and `wire-spec` cut to their generic cases plus new starter cases |
| editor-react | the ERP export test, `artwork`, `bare-scart`, `board-art`, `board-diff`, `board-journey`, `board-node`, `board-to-board`, `breakout`, `cable-journey` (×2), `canvas-ergonomics`, `carrier-dock`, `carrier-through`, `compare-diff`, `compare-view`, `connection-rows`, `connector-leads`, `derive`, `edit-session`, `entry-guides`, `ground-bus`, `library-table`, `moulds`, `mount`, `part-numbers`, `pigtail-edit`, `pigtail-hand-edits` (×2), `recipe-overrides`, `record-page-order`, `repin`, `signal-tags`, `stock-swap`, `trace-highlight`, `wire-builder`, `wire-model3d`, `wire-scene` |
| studio (new: `modules.server.test.ts`) | the two ERP link tests, `board-import`, `board-texture`, `builds`, `cable-list-sync`, `cables-list`, `compare-route`, `derived`, `entry-guides`, `kicad-models`, `lineup-push`, `lineup`, `pn-agreement`, `products` (×2), `proposals`, `revisions` |

In the files that were kept, individual cases asserting private designs were
removed (editor 170 cases across 29 files, studio 70 across 14, docs 32 across
2). Re-covering what they covered on starter data is a follow-up (beads).

## 7. Features — summary

| Feature | Class |
| --- | --- |
| Hierarchical wire model, connectors (body + interface), PCBAs as black boxes, mechanicals, kits | BASE |
| Validation, nets, trace, pigtails/bonding, breakouts | BASE |
| Schematic (ELK layout, deterministic SVG), cross-sections, end faces, 3D wire models | BASE |
| Build sheet, BOM, continuity spec, drawing sheet, wire spec | BASE-gen |
| Editor canvas, library, wizard, versions, edit locks, login, optional git export | BASE-gen |
| Part numbers | BASE-gen (pluggable scheme) |
| Console resolver, recipes, journey, board proposals, lineup, products, routes | MODULE |
| ERP integration (contract, transport, push, identity table, PN reconciliation) | MODULE |
| Board/model/gerber importers over the board designer's share; board revision compare | MODULE |
| Shop work instructions, brand font, logo, traced drawing art | MODULE |
| Live-clone deploy, proxy/tailnet/host specifics, private remote backup | DROP |

## 8. Status at the split

- `pnpm install`, `pnpm -r build` (tsc --noEmit, strict): green.
- `pnpm test` (one workspace at a time, `--maxWorkers=2`): model 209,
  catalog 12, modules 4, layout 77, render-svg 197, docs 88, editor-react
  452, studio 395 — 1434 tests, all green.
- Not yet verified: `docker build` of `docker/app.Dockerfile` (the bundle
  and the standalone server were smoke-tested; bead filed).

## 9. Leak scan → privacy check

The split was checked by a leak scan whose patterns named the private shop,
its people, hosts, part-number series and product words. A public repository
should not carry that list, so on the rename to WireHub the scan was folded
into `scripts/privacy-check.sh` (`CONTRIBUTING.md`):

- the public script checks generic things — home paths, the machine's own
  hostname and login, keys and tokens, `.env` files, non-noreply emails, agent
  session trailers — on every commit (`.githooks/`) and in CI;
- the private words live in a **local, gitignored** `.privacy-terms` file in
  the owner's checkout. When the file is present, every mode checks it too,
  including the pass that joins comment continuation lines so a name split
  over two lines is still found.

`bash scripts/privacy-check.sh --tree` must stay clean. `--history` checks
every commit's tree, message and paths; the commits made before the rename
still carry the old leak-scan script and agent trailers, which a history
rewrite before publishing removes.

## 10. After the split: WireHub and its domain modules

On the rename to WireHub the base went one step further than the split: it no longer
carries any one *domain* either. The video vocabulary (RGB, sync types, composite,
S-Video, component, DDC and their returns), the VGA example and the HD15 family moved to
the bundled, optional `modules/av-video` pack; label reading in compat, the wizard, the
tag proposals and the continuity spec now goes through the vocabulary instead of
hard-coded video words; the wizard's bare-SCART option (a transform of one shop's board)
and the fleet colour code were dropped, not moved. A second domain module,
`modules/automotive`, shows the pattern with public OBD-II facts. Both are offered at
first-run setup (`docs/modules.md`).
