# Modules

WireHub's base is generic. What only one shop needs — its importers for its own file
layout, its own screens, rules and numbering that data cannot express, branding — goes in a
**module**. (Numbering schemes, most design rules and integrations with other systems are
configuration, not modules: see "Configuration or code?" below.) A module is a package that
contributes to a fixed set of extension points. A module reaches a hub one of two ways, with the
same module object:

- **Built in**: listed in `apps/studio/modules.config.ts` and bundled with the image. The
  bundled modules below are built in.
- **Installed at runtime** (a *code module*): everyone runs the same public image, and an owner
  installs a module from a store or a signed upload in the UI; the hub loads it without a rebuild
  and, for almost every extension point, without a restart (see "Runtime code modules" below and
  `specs/runtime-modules.md`).

`@wirehub/modules` (`packages/modules/src/index.ts`, `runtime.ts`) defines the module shape, the
registry and the live registry runtime modules are swapped into; `apps/studio/modules.config.ts`
lists the built-in modules; the server, the worker and the browser each build their registry
from it and lay the installed code modules over it. The base bundles five optional **domain
modules** there (`modules/pc-serial`, `modules/networking`, `modules/pro-audio`,
`modules/av-video`, `modules/automotive`, below), and an **example module**
(`modules/example`) that contributes to every extension point, off unless a dev flag is set
(see "The example module"), and the always-on **board import** module (`modules/board-import`,
see "Board import"). Every extension point below is mounted in the app.

**Licensing.** `@wirehub/modules` is **MIT**, so a module can depend on it whatever its own
licence. WireHub itself is AGPL-3.0-only with the **WireHub Module Exception**
(`MODULE-EXCEPTION.md`): a module that talks to WireHub only through the module API — this
package, plus the public exports of `@wirehub/model` and `@wirehub/catalog` — and the
catalog-pack formats may be licensed on any terms, open or closed, and a WireHub image that
includes it can be distributed without the module becoming AGPL. Changes to WireHub itself
stay AGPL. The bundled domain modules are MIT (code) and CC0-1.0 (pack data), so they can
be copied as templates.

## Principles

1. **Trusted code, from the image or from a signed bundle.** A built-in module is an npm package
   the manifest imports, type-checked and bundled with the app. A runtime code module is the same
   kind of package built into a bundle (`wirehub-module build`) that runs only after an owner
   installed it, signed by a publisher key the hub trusts, with the owner's consent to what it
   declares it does; no code is fetched or run otherwise, and the server can turn every runtime
   module off (`WIREHUB_ALLOW_CODE_MODULES=false`). Either way a module is trusted code: there is
   no sandbox.
2. **The model owns truth.** A module never changes the meaning of base data. It may add data
   of its own under `CableDesign.extensions[<module id>]`, add validation issues, add
   documents, add routes and UI. The base never reads a module's extension data.
3. **Pure where the base is pure.** Validation rules, part-number schemes and exporters take
   data and return data — no network, no clock — so they run identically in the browser, in
   the server and in tests. Integrations (which do talk to the outside world) run only on the
   server.
4. **One owner per singleton.** At most one module sets the part-number scheme, and at most
   one sets the editor commit hook. Lists (importers, exporters, rules, panels, routes, packs,
   auth providers) compose; ids must be unique across the deployment. `createRegistry`
   refuses a manifest that breaks these rules, with one sentence per problem.
5. **Namespaced.** Module ids are kebab-case. A rule's issue codes are prefixed
   `<module>/`; a module's server routes live under `/api/modules/<module>/…`; its UI routes
   under `/m/<module>/…`; its design data under `extensions.<module>`.

## Configuration or code?

Reach for a module last. Most of what looks like a code module is **plain configuration**, which
needs no build, no restart and no review of someone's code, and which an owner can edit and a data
pack can ship:

| You want | Use | Where |
| --- | --- | --- |
| a numbering convention (`<Level><Type>-NNNNNN-VV`, prefixes, ranges, variants) | a **declarative part-number scheme** | Settings, Part numbers; a pack's manifest (`docs/part-numbers.md`) |
| design rules ("a boot on every connector of family F", "power conductors at least 0.5 mm²") | **validation rules** | Settings, Validation rules; a pack's `validation-rules.json` (`docs/validation-rules.md`) |
| another system told when something happens (an ERP, a chat channel) | **event webhooks**, and the API with a token | Settings, Webhooks (`docs/webhooks.md`) |
| your catalog: connectors, wires, signals, example cables | a **catalog pack** | `docs/catalog-store.md` |
| the organisation's name, logo, thresholds, approvals, alerts | **Settings** | `specs/runtime-settings.md` |

An integration is rarely code: the system subscribes to **version released** and pulls the BOM
(`GET /api/designs/:id/exports/…`) with a token, and writes back through the API with the same
token. A module is for what only code can do:

- a **numbering scheme** that looks something up or computes a check digit (`partNumberScheme`);
- a **rule** the language cannot express: it needs a calculation, another record's history, an
  algorithm (`validationRules`: pure functions; they run beside the declarative ones);
- an **importer or exporter** for a file format, a **screen or panel** inside WireHub, a **job queue**
  with its own code, a **route** the API does not have, **derived data** a save must recompute,
  **branding art**, a **sign-in provider**.

The declarative forms are not a lesser kind: both feed the same checks as the code (the
`PartNumberScheme` interface, `validateDb` and `validateDesign`), and the code extension points
below stay for the exotic cases. Start from the data form; a definition can grow into a module
later (`declarativePartNumberScheme` builds a `PartNumberScheme` from a definition).

When code it is, it still needs no build of your own: a module ships as a signed bundle an owner
installs from a store or an upload ("Runtime code modules" below).

## Domain modules

The base is generic: it knows wires, connectors, boards, ground and power, and nothing about
any one field. A **domain** — video, automotive, fieldbus, pro audio — is a module whose
main contribution is a catalog pack: the signals of that field with the words that name them
(labels, short names, aliases), their returns (`returnFor`), lanes, levels, connector
families, and the connectors and example cables built from them. Every reader in the base —
the new-cable wizard, the joint compatibility rules, the continuity spec, the tag proposals
— reads signals through the vocabulary (`packages/model/src/signal-words.ts`), so a pack
teaches all of them its field without code.

A domain module marks itself optional with `setup`:

```ts
export const avVideo = defineModule({
  id: 'av-video',
  label: 'AV / video',
  version: '0.1.0',
  license: 'MIT',
  setup: { kind: 'domain', description: 'Video signals, VGA and SCART connectors …' },
  catalogPacks: [{ id: 'av-video', label: 'AV / video', version: '0.1.0', root: AV_VIDEO_PACK, license: 'CC0-1.0' }],
});
```

**First-run setup** (`/setup`, `apps/studio/server/setup.ts`) lists `registry.domains()`
with each one's description, **every one unticked**, forces nothing, and installs the chosen
modules' packs as layers in the **packs directory** (`installPackLayer`,
`docs/catalog-store.md` §3): `WIREHUB_PACKS_DIR`, which is `/data/packs` (the `packs` volume)
in the container and the gitignored `data/packs/` in a checkout. The starter catalog is never
written, so a domain record cannot reach a commit to the base by accident. The selection is
stored in `setup.json` beside the packs. A deployment pre-ticks modules with
`WIREHUB_SUGGESTED_MODULES=pc-serial,networking` (the config generator writes it); a module's
own `setup.suggested` counts only where that variable is unset, and the bundled modules leave
it unset. A hub opens on `/setup` while no selection is stored when the host sets
`WIREHUB_SETUP_PROMPT=1` (the container image does), and then asks for the one-time **setup
code** the server prints in its log (`WIREHUB_SETUP_CODE`, generated by the stack's
`bootstrap` service). The command palette reaches `/setup` any time, to enable more.
Enabling is additive.

| Bundled module | Adds |
| --- | --- |
| `modules/pc-serial` (`@wirehub/module-pc-serial`) | RS-232 data and handshake, RS-485 A/B and USB D± signals; RS-232 and RS-485 levels; the RS-232 DTE (TIA-574) and PROFIBUS-style RS-485 pinouts on the base's DE-9 bodies; USB 2.0 on a Type-A plug; a null modem, an RS-485 cable to the base's terminated adapter board, a USB LED supply lead |
| `modules/networking` (`@wirehub/module-networking`) | the Ethernet MDI pair signals; the RJ45 (8P8C) body and family, plugs terminated T568A and T568B; a boot; a T568B patch cable and a T568A-to-T568B crossover on the base's Cat 5e stock |
| `modules/pro-audio` (`@wirehub/module-pro-audio`) | audio L/R/mono and hot/cold signals and the audio return; audio lanes, line level, the RCA and microphone colour codes; XLR3, RCA and 3.5 mm TRS bodies, pinouts and connectors; microphone and stereo stocks; an XLR microphone cable and a TRS-to-2×RCA Y lead |
| `modules/av-video` (`@wirehub/module-av-video`) | video R/G/B, H/V and composite sync, composite, S-Video, component, DDC, SCART switching signals and their returns; lanes and levels; HD15, SCART and BNC families; the VGA and SCART connectors; a VGA monitor cable (and identical copies of the audio signals SCART carries, so it installs with or without `pro-audio`) |
| `modules/automotive` (`@wirehub/module-automotive`) | CAN, K/L-line, J1850 and battery-positive signals; the OBD-II (SAE J1962) plug with its mandated pins |

### Interop modules

Two bundled modules are always on, are not domain modules (no `setup`, no pack) and exist to
move records and designs in and out of other tools. Both are MIT; neither adds a table or a route.

| Bundled module | Adds |
| --- | --- |
| `modules/wireviz` (`@wirehub/module-wireviz`) | an importer for WireViz YAML (`.yml`, `.yaml`) and a **WireViz (YAML)** exporter in the Documents toolbar. The mapping is written from WireViz's public syntax documentation; none of WireViz's GPL-3.0 code is used or copied (the one dependency is the MIT-compatible `yaml` parser). |
| `modules/csv-library` (`@wirehub/module-csv-library`) | an importer (new records, or update-existing) for CSV and XLSX files of connectors, wire stocks, components, mechanicals, boards and kits, and the pure column-mapping, validation and dry-run functions behind the Library's **Bulk CSV…** dialog; a third importer, `connection-list`, makes a design from a from/to pin CSV (the Library's **Connections CSV…**) |

**WireViz import** (`docs/interop.md`) runs through the importer and job flow, so the person reviews a plan and publishes
one change set. A connector or cable is matched to the library only by an identity the file names (`pn`,
`mpn` or `type` equal to a part number, id, alias or label); otherwise a new record is **proposed** and
flagged INFERRED in its `src`, never forced onto a lookalike. The review lists what WireViz can say and the
model cannot as `Not carried over: …` notes.

**Bulk CSV** (`docs/interop.md`): a template per kind, a column-mapping step, a dry run (new, already in the
library with the fields that differ, invalid with reasons) and the same job review. Every record needs a `src`.

An importer may return designs together with the definitions they use: inside one change set (a batch, a job's
publish) a design is validated against the definitions staged before it.

`/setup` also mentions domains that have no module yet (fieldbus today) as plain
suggestions, not installable.

Every bundled pack is laid over the **generic starter catalog** (`packages/catalog/data`): it
reuses the base's DE-9 bodies, stocks, components, mechanicals and terminal adapter board and
adds only its field's records. Pack records carry no part numbers (a deployment numbers them
through its scheme when it adopts them); each keeps its `src` citation. Each module's tests
(`modules/<id>/test`) check that its pack validates over the starter, installs into a copy of
it without a conflict, and teaches the base's readers its words — the serial, networking and
audio cases that used to be the base's own tests live there now.

Connector faces, body layouts and sheet art: the base keeps the **generic physical shapes**
(`packages/layout/src/connector-art.ts`: D-sub, HD15, mini-DIN, DIN, and a generic side
view for the profile families; `packages/editor-react/src/body-templates.ts`) and a pack
or module supplies the rest (see "Art" below). The SCART and JP21 faces and body layouts and
the BNC side view are `modules/av-video`'s; the RCA and 3.5 mm TRS side views are
`modules/pro-audio`'s.

## The example module

`modules/example` (`@wirehub/module-example`, MIT, README inside) contributes once to **every**
extension point and is the template to copy for a module of your own: `src/index.ts` is the table,
`src/logic.ts` the pure parts, `src/ui.ts` the panels and page. It is **not for production** and is
labelled so in its name and its setup description. It is in the manifest only when the dev flag
`WIREHUB_EXAMPLE_MODULE=1` is set (at bundle time for the browser, at start for the server —
`apps/studio/modules.config.ts`), so it is never offered at `/setup`, and adds no panel, route, rule
or hook, on a hub that did not ask for it. When flagged it also sets the deployment's one
part-number scheme and one commit hook, so use it on a scratch checkout:

```
WIREHUB_EXAMPLE_MODULE=1 pnpm --filter studio dev
```

A module's UI is imported by the server too (through Node's type stripping, which does not read
`.tsx`), so write panels with `createElement` in `.ts` files, or build them to JavaScript first.

Its tests prove each point works through the app: `apps/studio/test/storage-contract/modules.ts` drives
the server points (routes, rule, importer, exporter, documents, derived records) against the file
backend and the commit tree the database uses, and `test/pg/modules.server.test.ts` runs the same
session on Postgres, comparing every answer and the final catalog byte for byte;
`test/modules.dom.test.tsx` mounts the panels, route, importer review, exporters and commit hook in
the SPA; `test/module-auth.server.test.ts` signs in through contributed providers;
`modules/example/test` checks the module's own logic and that it touches every point.

## Board import

`modules/board-import` (`@wirehub/module-board-import`, MIT, README inside) brings a PCBA in
from its open fabrication files, for any shop. It is in the manifest always (it has no data of
its own and is not a setup choice) and contributes three importers and a page:

| Importer | Accepts | Proposes |
| --- | --- | --- |
| `kicad-board` | `.kicad_pcb`, `.net` | the PCBA — terminals with their pads (positions in the art frame), internal links from its nets and two-terminal parts, integrated connectors named in review — and, from a `.kicad_pcb`, `kicad`-tier art (outline and pads) with anchors |
| `gerbers` | `.zip` (RS-274X/X2 and Excellon) | `gerber`-tier art for the board: top and bottom SVG (substrate, copper, mask, silkscreen, holes, clipped to the outline), anchored on the board's pads and checked against the copper flashes; it replaces `kicad`-tier art |
| `fab-bom` | `.csv`, `.board-bom.json` | component records (one per distinct part, reusing the Library's by MPN or supplier number) and the board's placed parts |

The page `/m/board-import/boards` is the review step: the options (board id, part number,
revision; the board a Gerber set or BOM belongs to), the BOM and placement column mapping
(detected, then editable), the job's proposal and plan with the art previewed, **Publish**, and,
once a board is published, **Attach … as its 3D model**: the `.kicad_pcb` goes to
`POST /api/models/pcbas/:id/upload`, the server keeps it as a catalog document
(`data/model-sources/<sha256>.kicad_pcb.txt`) and links the board to a model built from it
(`sourceKind: 'kicad-board'`, `build: { kind: 'assembly', library: <commit> }`). The
`model-cache` job builds it, fetching the KiCad library models the footprints name from
kicad-packages3D at the pinned commit into the model cache (`WIREHUB_KICAD_LIBRARY_DIR`,
`WIREHUB_KICAD_LIBRARY_FETCH=0` to stay offline). Those models are CC-BY-SA: fetched, never
committed. Its tests: `modules/board-import/test` (parsers, derivation, art, BOM on a synthetic
board), `apps/studio/test/board-import.server.test.ts` and `test/pg/board-import.server.test.ts`
(the whole flow as jobs on both backends, compared), `test/board-import.dom.test.tsx` (the page).

## The module object

```ts
import { defineModule } from '@wirehub/modules';

export const acme = defineModule({
  id: 'acme',                    // kebab, unique; also the key under CableDesign.extensions
  label: 'ACME workshop',
  version: '1.2.0',              // semver
  license: 'LicenseRef-ACME-Proprietary',
  setup,                         // optional: offered at first-run setup (a domain module)
  partNumberScheme,              // optional, singleton
  validationRules: [...],
  importers: [...],
  exporters: [...],
  catalogPacks: [...],
  integrations: [...],
  panels: [...],
  routes: [...],
  authProviders: [...],
  commitHook,                    // optional, singleton
  documents: [...],              // catalog documents the module owns
  derived: [...],                // derived records kept beside the catalog
  art,                           // optional: connector drawings, body layouts, sheet art
});
```

## Extension points

| Point | Shape (in `@wirehub/modules`) | Where it runs | Mounted today |
| --- | --- | --- | --- |
| **Catalog packs** | `CatalogPackContribution { id, label, version, root?, license? }` — a data directory laid out like `packages/catalog/data` plus `wirehub-pack.json`; `root` a path or `file:` URL | server, at install | **yes** — installed by first-run setup for domain modules (`/setup`); `layeredCatalogSource` reads one without installing |
| **Setup (domain)** | `SetupContribution { kind: 'domain', description, suggested? }` | server + browser | **yes** — `/setup` lists `registry.domains()` |
| **Importers** | `ImporterContribution { id, label, accepts: ['.kicad_pcb'], import({ fileName, bytes, options? }, db) → { definitions?, updates?, designs?, boardParts?, depictions?, notes } }` — proposes records (and a board's placed parts and artwork), never writes | server | **yes** — the Library's **Import…** button (every kind's list) offers the importers that take the file; the person reviews the proposal and accepts it; `POST /api/modules/<module>/_import/<importer>` (below); with `job: true` it runs as a job instead (the worker on Postgres) and its plan is published with `POST /api/jobs/<job>/publish` (`specs/postgres-backend.md` §7.5) |
| **Exporters / document types** | `ExporterContribution { id, label, description?, source?, render(design, db, options) → { mimeType, fileName, body } }` — `source: 'continuity'` makes the host pass the neutral continuity data as `options.continuity`, for a tester's own format (`docs/exports.md`) | browser and server | **yes** — one download button per exporter in the cable's Documents toolbar; `GET /api/modules/<module>/_export/<exporter>?design=<id>` (below) |
| **PN schemes** | `PartNumberScheme { id, label, parse, check, suggest }` (`@wirehub/model`) | everywhere | **yes** — the editor's PN field, the library, BOM proposals |
| **Validation rules** | `ValidationRuleContribution { id, label, check(design, db) → Issue[] }` | everywhere | **yes** — every design save runs them after `validateDesign` |
| **Integrations** | `IntegrationContribution { id, label, env?, routes?: { method, path, writes?, handle(request) }[], queues?: JobQueueContribution[] }` | server only | **yes** — `/api/modules/<module>/<path>`; `writes: true` routes take the write lock; a route path may not start with `_`; `queues` are job queues (below) |
| **UI panels** | `PanelContribution { id, label, slot: 'cable-inspector' \| 'cable-documents' \| 'library-detail' \| 'settings', component }`; the component takes `PanelProps` | browser | **yes** — below |
| **Compare views** | `CompareViewContribution { id, label, kinds?, component }`; the component takes `CompareProps` | browser | **yes** — below |
| **UI routes** | `UiRouteContribution { path, label, icon?, component }` under `/m/<module>/`; the component takes `RouteProps` | browser | **yes** — below |
| **Auth providers** | `AuthProviderContribution { id, label, kind: 'oidc' \| 'oauth2' \| 'other', config }` | server | **yes** — below; the base's own OIDC is still configured by environment |
| **Documents** | `DocumentContribution { path: 'data/<prefix>/' \| 'data/<file>', class: 'imported' \| 'report' }` — catalog documents the module owns | server | **yes** — `PUT /api/docs/*path` writes only these (scope `imports` for an API token); the file backend's catalog version covers their directories |
| **Derived records** | `DerivedContribution { id, label, files, derive({ designs, db }) → { [file]: data \| text } }` — files recomputed when a save changes their inputs | server (the commit) | **yes** — below; on files and on Postgres |
| **Migrations** | `ModuleMigrationsContribution { dir }` — forward-only SQL for the module's own tables, Postgres backend only | server, `db:migrate` | **yes** — applied after the base's, into schema `mod_<id>` (below) |
| **Art** | `ArtContribution { connectors?, bodyLayouts?, drawing? }` — parsed JSON from the pack's `art/` directory (`ConnectorArtRecord`, `BodyLayoutRecord` in `@wirehub/catalog`; `DrawingArt` in `@wirehub/docs`), opaque in the contract | browser and server, at start | **yes** — below |
| **Bench steps** | `BenchContribution { rules?, provider? }` — the shop's work instructions on the build sheet, as JSON rules or a `BenchStepsProvider` | server and browser | **yes** — see "Bench work instructions" |
| **Commit hook** | `(before, proposed, description) → CableDesign` — rewrite an edit as it is committed (e.g. record it as an override in module data) | browser (editor) | **yes** — the app installs `registry.commitHook()` into the editor store (`setCommitHook`) when it starts |

### Art (connector drawings, body layouts, sheet art)

A pack's directory may hold `art/connectors/<id>.json` (a mating face as painted shapes
with a handle per pin, or a side profile, `"view": "profile"`, drawn once with the cable end
on the left and mirrored by the host when the wire leaves from the right; keyed by body,
`drawing` name or family, optionally by `gender`), `art/body-layouts.json`
(the standard position layouts a family offers for a new body) and `depictions/<id>/…`
(SVG faces with pin anchors, mirrored solder-side views, a stock's cutaway illustration —
the existing depiction mechanism). A module that carries such a pack hands the parsed
records to the host with `art: { connectors, bodyLayouts, drawing }` (JSON imported with
`with { type: 'json' }` so the browser bundle has them); `apps/studio/module-art.ts`
validates and registers them at start, in the browser and on the server
(`registerConnectorArt`, `registerBodyLayouts`, `registerDrawingArt`), and a bad record stops
the start with one sentence per problem. Record ids are unique across the manifest.
Art is keyed by body, drawing name or family, so a catalog without those bodies is
unaffected; with no module the base draws exactly what it always did. The formats, the order
art is chosen in and the licensing rules (CC0, a `src` on every file, nothing traced from a
vendor drawing, and a `license` and `provenance` on every art record, validated like a
catalog record's) are `specs/drawing-language.md` §7. Depictions of bundled modules reach the
browser through globs over `modules/*/pack/depictions/`; an *installed* third-party pack's SVG
files are not copied by `installPackLayer` yet (it copies `.json` only).

**Bench work instructions** are the module point `bench: { rules?, provider? }`
(`specs/drawing-language.md` §8). The build sheet prints a shop's own steps in place of the
generic ones, per phase (`prep`, `end`, `assembly`, `solder`, `qa`). The types (`Step`,
`BenchEnd`, `ShellSet`, `BenchStepsProvider`, `BenchStepRule`) live in `@wirehub/model`
(`bench-types.ts`), so a module names them without importing `@wirehub/docs`.

- **As data**: `rules` is plain JSON a module or pack ships (import it with `with { type: 'json' }`):
  `{ id, phase, when?: { connector?, family?, wire?, stockFamily? }, steps: [{ text, src, images?, tools?, checks? }] }`.
  `when` matches the connector definitions or families at the end, or the stock; a rule with no
  `when` always applies; the steps of all matching rules, in order, replace the generic steps of
  that phase. `solder` and `qa` rules take no `when`. `images` are `data:image/` URIs or `https:` URLs,
  `tools` print as a line, each of `checks` with a tick box. Every step needs a `src`.
- **As code**: `provider` is the `BenchStepsProvider` with the bench facts in hand (stock, end,
  terminations, shells).

The host validates the rules at start (`benchRuleProblems`; a bad rule stops the start with a
sentence per problem) and registers them in manifest order, rules before the module's provider; the
first registration with an answer for a phase wins. `modules/example` shows both. The
lower-level `registerBenchSteps(provider)` in `@wirehub/docs` is what the host calls.


**The hub's own identity.** A hub with no branding module still sets its organisation name,
standard name, rights line, default designer, the prefix of its wire spec files (default `WSS_`) and a PNG or SVG logo on `/settings` (an owner or an
editor; stored as `data/settings/branding.json` plus a sanitised asset, so both backends keep it
with the catalog; an SVG logo is cleaned of scripts and external references and drawn to a PNG on
the server, the same rasteriser the PDF exports use). The app registers them as drawing art
(`titleBlock.organisation / standard / rights / designer / filePrefix`, and `logo`) **after** the modules' art. The first registration to set a part
wins, so a module's `art.drawing` still beats the setting, and an unset field keeps the generic
text. The drawing sheet's title block, the wire spec, and the bench build sheet / BOM header read
it; no renderer is branded by hand.

### Job queues

An integration may register queues of its own for work that outlasts a request or runs on a
schedule (a push to another system, a nightly re-index):

```ts
integrations: [{
  id: 'sync', label: 'Sync',
  queues: [{
    id: 'push',                    // kebab; the job kind is '<module id>:push'
    label: 'Push to the ERP',
    schedule: '*/30 * * * *',      // optional five-field cron, container time; Postgres worker only
    async run({ request, step, db }) {
      await step('reading the catalog');
      const catalog = await db();  // the catalog as it is when the job starts (read only)
      return { pushed: catalog.connectors.length };   // plain JSON: the job's result
    },
  }],
  routes: [{ method: 'POST', path: 'push', async handle(request) {
    const job = await request.jobs!.enqueue('push', { full: true });   // this module's queues only
    return { status: 202, body: { job } };
  } }],
}]
```

- A queue's jobs are recorded like the base's (`GET /api/jobs?kind=<module>:<queue>`, the
  `job_run` table), run one at a time per queue by the worker process on the Postgres backend
  and in the studio process on files, and never retried: a `run` that throws fails the job
  with its message. `request` is what was enqueued (`{ reason: 'schedule' }` for a scheduled
  run, `{ reason: 'requested' }` for `POST /api/jobs { kind }`, which any module queue accepts).
- A route's `request.jobs` offers `enqueue(queue, request?)` and `get(id)` for the module's
  **own** queues only (it is absent where the studio runs no jobs); `get` answers `undefined`
  for any other job.
- Catalog writes still go through the module's importers and routes, not a job's `db()`.
  The queue ids must be kebab-case and unique in the module; `manifestProblems` checks them
  and the schedule. On pg-boss the queue is named `<module>.<queue>` (it takes no colon).
- `registry.queues()` lists them; the example module's `example:recount` shows all of it.

### Module tables (Postgres backend)

A module that needs relational state of its own (an integration's push log, an import
register) sets `migrations: { dir }`. The directory holds `NNNN_<module_id>_<name>.sql`
files — `NNNN` from `0001` without gaps, the module id with `-` written `_` — which
`pnpm --filter studio db:migrate` (the compose `migrate` one-shot) runs **after** the
base's migrations, as the schema owner, into the schema `mod_<module_id>` (`pc-serial` →
`mod_pc_serial`). The interface is that one field; the runner is
`apps/studio/server/pg/module-migrations.ts` (`migrateModules`, `pendingModuleMigrations`).

- Each module's pending files run in one transaction with `search_path = mod_<id>, studio,
  public`; tables may reference `studio.entity`, `studio.design_revision` and
  `studio.person`, never the other way round. Applied files are recorded with their sha256
  in `wirehub_migrations.module_migration`; editing an applied file is refused (a change is a
  new file), and so is a vanished one.
- Every table with an `org_id` column must have `FORCE ROW LEVEL SECURITY` and an
  `org_isolation` policy (`USING/WITH CHECK (org_id = studio.current_org())`); otherwise the
  module's migrations roll back with a message naming the table.
- `studio_app` gets select/insert/update/delete and sequence usage on the schema, `studio_ro`
  select (the base's grants, §3.12).
- Catalog truth still goes through change sets; module tables hold evidence and indexes.
  Removing a module from the manifest leaves its schema; dropping it is an explicit admin act.
- The file backend ignores `migrations`.

UI contributions carry their component as an opaque value (`unknown` in the registry
package, so it needs no React); the app renders it as a React component.

### Mounting details (the stable contract)

**Panels.** `registry.panels(slot)` are rendered in manifest order, each in a labelled
`<section data-module data-panel>` and its own error boundary (a panel that throws shows one
error line, the page stays up). The component receives `PanelProps`:
`{ slot, module, db, design?, record?, readOnly, api }`. `cable-inspector` is appended to the
inspector column with the **live** design; `cable-documents` sits under the Documents tabs with
the design being printed (a saved revision when one is chosen, with `readOnly: true`);
`library-detail` sits under the open Library record with `record: { kind, id }`; `settings`
panels are listed per module on `/modules`, which the rail links to only when some module has
one. `api(method, path, body?)` calls the module's own routes
(`/api/modules/<module>/<path>`) and resolves `{ status, body }`.

**Compare views.** The Library's **Compare** actions (a record's head, and the list's pick-two
mode) open a compare view. The base ships a generic one — a field diff of two records of one kind
(`RecordCompare`: changed fields by default, unchanged on request, the second record chosen from a
list when only one was given). `registry.compareViewFor(kind)` returns the first module view that
declares the kind (`kinds`; absent means every kind) and the Library uses it instead, inside the
same error boundary as a panel. The component receives `CompareProps`:
`{ module, db, a: { kind, id }, b?: { kind, id }, api, onClose }` — `a` is the record Compare was
pressed on (or the first ticked), `b` the second when it has been chosen (a view with no `b` asks
for it), and `onClose` returns to the Library. A module's own view is where a board's artwork and
3D revisions, or two shells' dimensions, are shown side by side.

**UI routes.** `/m/<module>/<path>` renders the route's component with `RouteProps`
(`{ module, path, db, api }`) inside the shell. A route with an `icon` (a Tabler icon name from
`IconPlug`, `IconPuzzle`, `IconReport`, `IconSettings`, `IconTool`, `IconBox`, `IconList`; anything
else is a puzzle piece) gets a rail entry and a place in the mobile menu. Paths are lowercase
kebab segments joined by `/`, with no parameters.

**Importers.** The server runs them (`POST /api/modules/<module>/_import/<importer>` with
`{ fileName, base64, accept?, options? }`, a JSON body, so files up to about 24 MB).
`options` is what a review step chose — an object of up to 32 text values (a target board,
a column mapping as JSON) handed to the importer as `input.options`; the raw upload below
takes them as `option.<name>=…` query parameters. Besides definitions and designs an importer
may propose a board's **placed parts** (`boardParts`, `BoardPartsEntry` rows appended to
`data/board-parts.json`; a board and revision already listed is kept) and **board artwork**
(`depictions`: a depiction's `meta.json` record and its SVG files by name). The host runs every
SVG through the artwork sanitiser and every manifest through the depiction validator (anchors
must name the definition's terminals, including ones the same import adds) and stages them with
the records in the same change set; an existing depiction is kept unless every one of its views
is of a tier the importer lists in `replaces` (`['kicad']`), so a person's own artwork is never
overwritten. The proposal names them (`boardParts: ['<board>@<rev>']`, `depictions: [<id>]`). Without `accept` the
answer is the proposal — new definitions by kind, ids the library already has (skipped, never
overwritten), designs, the importer's notes and, when it returns `updates` (whole replacement records for ids the library has, an "update existing" mode), the records it would edit — each saved as a `PUT` against the version it read — and nothing is written. With `accept: true` the
file is read again and the proposal is written as **one change set** (the batch machinery:
definition and design validation apply, nothing lands if one record is refused). Importers must
be deterministic in their input. A bigger file goes up as raw bytes, always as a job:
`PUT /api/modules/<module>/_import/<importer>?fileName=…` with `application/octet-stream`
(no base64; up to `WIREHUB_IMPORT_MAX_MB`, default 100; the standalone server only). The
studio's Import… uses the job form where the studio runs jobs, and shows its progress, the plan
and **Publish** (also from the Jobs page). The sub-path prefix `_` is reserved for the host: an integration
route may not use it.

**Exporters.** The Documents toolbar renders the design on screen in the browser (so drafts
export too) and downloads the file; `GET /api/modules/<module>/_export/<exporter>?design=<id>`
renders a *stored* design on the server, with the other query parameters as `options`. The base's own
exports (BOM, wire and cut lists, continuity, labels) and the headless rendering are in `docs/exports.md`.

**Auth providers.** `kind: 'oidc'` takes `{ issuer, clientId, clientSecret?, scopes?, emailClaim?, name? }`;
`'oauth2'` takes `{ authorizationUrl, tokenUrl, userInfoUrl, clientId, clientSecret?, scopes?, emailClaim?, name? }`;
`'other'` takes `{ plugin }`, a Better Auth plugin object mounted as it is. The provider's `id` is its
sign-in id (`/api/auth/callback/<id>`), and it gets a "Sign in with …" button on the sign-in page. Any
config key ending in `Env` names an environment variable whose value becomes the key without the suffix
(`clientSecretEnv: 'ACME_SSO_SECRET'` → `clientSecret`), so a secret never sits in a module's source; a
variable that is not set stops the server at startup, naming it. A provider only proves who someone is:
the allow-list (the allowed emails of Settings > Sign-in, `AUTH_ALLOWED_EMAILS`, or the hub's people) still decides who may sign in, and a
deployment whose only sign-in is module-contributed starts without `AUTH_OIDC_*` or SMTP.

**Derived records.** A module lists the files it keeps (`files: ['summary.json', 'report.md']`, lowercase,
`.json` or `.md`) and a pure `derive({ designs, db })` returning one entry per file (data for `.json`, text for
`.md`). The commit that changes a design, drawing, definition, vocabulary or build file recomputes them,
so they are never stale and travel with the change that moved them: on files they are
`data/derived/<module>/<file>` in the catalog (and in the git export); on Postgres they are
`studio.derived_doc` rows (`derived_kind 'module'`, `module_id`) written in the same transaction, and the
export and the S1 gate see the same bytes. Nobody writes them by hand: `PUT /api/docs/…` refuses
`data/derived/`, and a module may not claim it as a document.

**Owned files and the catalog version.** The file backend's catalog version (what the unit of work caches
the loaded definitions under) hashes the base's directories plus the ones modules own, from
`registry.catalogDirs()`: the directories of their `documents` and `data/derived/<module>/`. The
base no longer hard-codes a module's directory names.

**The commit hook** is a singleton and runs on every committed edit in the editor; keep it cheap and pure.
It is installed once by `<App>` and removed when the app unmounts.

### What each point is for — worked examples

- *An ERP link*: an integration with routes `POST push` (`writes: false`, reads saved
  versions and sends them) and `GET status`; a panel in `cable-documents` with a dry-run and
  a send button; environment variables listed in `env` so the settings page can say what is
  missing. Product identity tables the ERP needs live under `extensions.<module>`.
- *A shop numbering scheme*: a `PartNumberScheme` whose `parse` recognises the shop's
  format and whose `suggest` reads `known` (every number already in the catalog and
  designs) to propose the next free one.
- *A board importer for one file share*: an importer accepting `.kicad_pcb` that returns
  proposed `pcbas` and `components` records with `src` citing the file and revision; the
  person reviews and accepts them in the Library. The file formats themselves are read by the
  public `modules/board-import`; a private module adds only the share's discovery (which
  folder, which revision is released) and calls the same parsing.
- *A product resolver*: rules and a panel; its recipe data under `extensions.<module>`; a
  commit hook that records hand edits against the recipe.
- *House rules*: a validation rule `acme/no-unsleeved-splice` that warns when a splice has no
  heat-shrink instance attached.

## Runtime code modules

The design is `specs/runtime-modules.md`; this is the summary.

- **The bundle is a pack.** `wirehub-pack.json` gains a `module` block (id, version, label, the
  `apiVersion` of `@wirehub/modules` it was built against, its entries, the extension points and
  permissions it uses), and the code sits at `code/<id>/server.mjs`, `browser.mjs` (UI) and
  `browser.css`, pinned by the manifest's `files` and covered by `wirehub-pack.sig`. A pack may
  carry data and code together; a code-only pack has no records. `wirehub-module build`
  (`apps/studio/scripts/wirehub-module.ts`) makes one from a module package: Vite library builds
  (no new dependency), `@wirehub/*` bundled in, React the host's (`globalThis.__wirehub.shared`).
- **Installed like a pack**, through the same doors (Library → Modules → Install pack…, Library →
  Browse store), the same diff, one change set, recorded in `packs.json` with the module and the
  sha256 of its entries. The code lives in the pack's layer (files) or as catalog files in the blob
  store (Postgres). Removing the pack removes the module.
- **Trust.** Owners only (a signed-in session, never an API token). Signed by a publisher the store
  index lists, or by a key an owner pins (`trustKey` on the upload, or Settings → Code modules).
  The preview lists what it may do and the apply needs `consent: { code: "<id>@<version>" }`. A
  module built for another major of the module API, or a newer minor, is refused (`MODULE_API_VERSION`,
  now `1.1`). `migrations` cannot be used at runtime; `setup` and `catalogPacks` are ignored (the
  pack is the data).
- **Loading.** The server, the worker and the page load the enabled modules into a **live
  registry** (`createLiveRegistry`, `composeRegistry`): the built-ins first, then runtime modules in
  id order, each refused with the manifest sentence if it clashes (an id the image has — the
  built-in wins —, a second scheme or commit hook, a duplicate importer, exporter or provider id).
  Rules, importers, exporters, the scheme, panels, compare views, UI routes, integration routes,
  the commit hook, documents, derived records, art, bench steps and auth providers (sign-in is
  rebuilt in-process) apply live. Job queues on Postgres start at the next start: Settings → Code
  modules → **Restart WireHub** drains the app and exits with code 75 for the container's restart
  policy to bring it back, and tells the worker through the database. A module that throws at load
  is disabled automatically, with its error shown; the hub stays up.
- **Settings → Code modules**: the installed modules and their state, on and off, the kill switch,
  pinned keys, Restart WireHub. `GET /api/code-modules`, `POST /api/code-modules/<id>/enable|disable`,
  `PUT /api/code-modules/settings`, `POST|DELETE /api/code-modules/keys…`, `POST /api/system/restart`.
- **Stores carry code modules**: the store template's workflow builds `modules/<name>/` packages
  into signed packs (`templates/store/README.md`).

## A private module in its own repository

A private module never lives in this repository. It is its own package, in its own
(private) repository, and a deployment opts in to it.

```
acme-wirehub-module/          (private repo)
  package.json                     name: @acme/wirehub-module
                                   peerDependencies: @wirehub/model, @wirehub/modules
                                   license: any (see MODULE-EXCEPTION.md)
  src/index.ts                     export const acme = defineModule({...})
  src/panels/*.tsx                 (peer: react)
  data/                            a catalog pack, if it ships one
  test/                            vitest against @wirehub/catalog's starter catalog
```

Rules for the module's package:

- `@wirehub/*` packages are **peer dependencies**, so the module is built against the
  deployment's copy and never bundles a second one.
- It exports TS source like the base packages (or compiled ESM — either bundles).
- Its tests run against the base's starter catalog or its own fixtures, never against a
  deployment's live data.

### Adding it to a deployment

The usual way: build it into a signed bundle and install it at runtime (above; the
`wirehub-module` skill has the steps). No fork, no image of your own.

To build it into the image instead, a deployment is a checkout of this repository (or a fork that
tracks it) plus its manifest:

1. Add the module as a dependency of the app — a git dependency, a private registry
   package, or a workspace folder:
   ```
   pnpm --filter studio add git+ssh://git@git.example.com/acme/acme-wirehub-module.git#v1.2.0
   ```
   (For local development of the module, add its folder to `pnpm-workspace.yaml` instead.)
2. List it in `apps/studio/modules.config.ts`:
   ```ts
   import { acme } from '@acme/wirehub-module';
   export const modules = [acme];
   ```
3. `pnpm build && pnpm test`, then rebuild the image (`docker compose up --build`). A bad
   manifest fails at startup and in the build with `ModuleManifestError`, naming each
   problem.

Keeping the deployment's own changes to the manifest and the lockfile only means pulling a
new base version is a plain merge. A deployment that must not have its manifest in a public
fork keeps a private fork of this repository whose only difference is those two files.

### Versioning and compatibility

- The registry API (`@wirehub/modules`) and the model types are the module contract.
  Breaking changes to them bump the base's major version and are listed in the changelog.
- `MODULE_API_VERSION` (`<major>.<minor>`, now `1.1`) is what a runtime bundle records as its
  `apiVersion`: a hub runs a bundle of the same major and a minor no newer than its own.
- A module declares the base range it supports in `peerDependencies`; pnpm warns on a
  mismatch at install.
- Module design data is the module's own: it should carry its own schema version inside
  `extensions.<module>` and migrate it on read.

## Not in scope

- Modules overriding base routes, base validation, or base documents. A module adds; it
  does not replace. If a base behaviour needs to vary, the base grows an extension point.
- Sandboxing. A module is trusted code, reviewed like the base; a runtime module's declared
  permissions are checked against what it registers, so the consent is honest, but they are not a
  sandbox.
- Runtime module migrations (bead filed): a module with its own tables is built in for now.

## Next steps

Tracked in beads: bench work instructions as a module point; copying an installed pack's SVG art; an upload route for importers
larger than a JSON body; panels in the saved-revision view.
