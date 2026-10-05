# Modules

WireHub's base is generic. What only one shop needs — its ERP link, its numbering
scheme, its importers for its own file layout, extra design rules, branding — goes in a
**module**: a package that contributes to a fixed set of extension points, registered at
build time in the deployment's manifest.

The skeleton exists today: `@wirehub/modules` (`packages/modules/src/index.ts`) defines
the module shape and the registry; `apps/studio/modules.config.ts` is the manifest; the
server and browser each build the registry from it. The base bundles five optional **domain
modules** there (`modules/pc-serial`, `modules/networking`, `modules/pro-audio`,
`modules/av-video`, `modules/automotive`, below). Not every extension point is mounted in the
app yet — the table below says which.

**Licensing.** `@wirehub/modules` is **MIT**, so a module can depend on it whatever its own
licence. WireHub itself is AGPL-3.0-only with the **WireHub Module Exception**
(`MODULE-EXCEPTION.md`): a module that talks to WireHub only through the module API — this
package, plus the public exports of `@wirehub/model` and `@wirehub/catalog` — and the
catalog-pack formats may be licensed on any terms, open or closed, and a WireHub image that
includes it can be distributed without the module becoming AGPL. Changes to WireHub itself
stay AGPL. The bundled domain modules are MIT (code) and CC0-1.0 (pack data), so they can
be copied as templates.

## Principles

1. **Build-time registration, no runtime loading.** A module is an npm package (a workspace
   package or a git dependency) that the manifest imports. It is type-checked and bundled
   with the app. There is no plugin directory, no `eval`, no fetching code at runtime: what
   runs is what was built and reviewed.
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

`/setup` also mentions domains that have no module yet (fieldbus today) as plain
suggestions, not installable.

Every bundled pack is laid over the **generic starter catalog** (`packages/catalog/data`): it
reuses the base's DE-9 bodies, stocks, components, mechanicals and terminal adapter board and
adds only its field's records. Pack records carry no part numbers (a deployment numbers them
through its scheme when it adopts them); each keeps its `src` citation. Each module's tests
(`modules/<id>/test`) check that its pack validates over the starter, installs into a copy of
it without a conflict, and teaches the base's readers its words — the serial, networking and
audio cases that used to be the base's own tests live there now.

Connector face drawings (`packages/layout/src/connector-art.ts`) and body layouts
(`packages/editor-react/src/body-templates.ts`) remain a base library of physical shapes —
they appear only for a family a catalog actually has; letting a pack contribute its own is
a follow-up.

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
});
```

## Extension points

| Point | Shape (in `@wirehub/modules`) | Where it runs | Mounted today |
| --- | --- | --- | --- |
| **Catalog packs** | `CatalogPackContribution { id, label, version, root?, license? }` — a data directory laid out like `packages/catalog/data` plus `wirehub-pack.json`; `root` a path or `file:` URL | server, at install | **yes** — installed by first-run setup for domain modules (`/setup`); `layeredCatalogSource` reads one without installing |
| **Setup (domain)** | `SetupContribution { kind: 'domain', description, suggested? }` | server + browser | **yes** — `/setup` lists `registry.domains()` |
| **Importers** | `ImporterContribution { id, label, accepts: ['.kicad_pcb'], import(input, db) → { definitions?, designs?, notes } }` — proposes records, never writes | server (may run in the browser if pure) | registry + `importersFor(fileName)`; UI not yet |
| **Exporters / document types** | `ExporterContribution { id, label, description?, render(design, db, options) → { mimeType, fileName, body } }` | browser and server | registry only; Documents view not yet |
| **PN schemes** | `PartNumberScheme { id, label, parse, check, suggest }` (`@wirehub/model`) | everywhere | **yes** — the editor's PN field, the library, BOM proposals |
| **Validation rules** | `ValidationRuleContribution { id, label, check(design, db) → Issue[] }` | everywhere | **yes** — every design save runs them after `validateDesign` |
| **Integrations** | `IntegrationContribution { id, label, env?, routes?: { method, path, writes?, handle(request) }[] }` | server only | **yes** — `/api/modules/<module>/<path>`; `writes: true` routes take the write lock |
| **UI panels** | `PanelContribution { id, label, slot: 'cable-inspector' \| 'cable-documents' \| 'library-detail' \| 'settings', component }` | browser | registry only |
| **UI routes** | `UiRouteContribution { path, label, icon?, component }` under `/m/<module>/` | browser | registry only |
| **Auth providers** | `AuthProviderContribution { id, label, kind: 'oidc' \| 'oauth2' \| 'other', config }` | server | registry only; the base's own OIDC is configured by environment |
| **Documents** | `DocumentContribution { path: 'data/<prefix>/' \| 'data/<file>', class: 'imported' \| 'report' }` — catalog documents the module owns | server | **yes** — `PUT /api/docs/*path` writes only these (scope `imports` for an API token) |
| **Commit hook** | `(before, proposed, description) → CableDesign` — rewrite an edit as it is committed (e.g. record it as an override in module data) | browser (editor) | `setCommitHook` exists in the editor store; wiring from the registry not yet |

UI contributions carry their component as an opaque value (`unknown` in the registry
package, so it needs no React); the app renders it as a React component.

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
  person reviews and accepts them in the Library.
- *A product resolver*: rules and a panel; its recipe data under `extensions.<module>`; a
  commit hook that records hand edits against the recipe.
- *House rules*: a validation rule `acme/no-unsleeved-splice` that warns when a splice has no
  heat-shrink instance attached.

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

A deployment is a checkout of this repository (or a fork that tracks it) plus its manifest:

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
- A module declares the base range it supports in `peerDependencies`; pnpm warns on a
  mismatch at install.
- Module design data is the module's own: it should carry its own schema version inside
  `extensions.<module>` and migrate it on read.

## Not in scope

- Runtime installation of modules from the UI. (Catalog *data* packs can be installed at
  runtime — `docs/catalog-store.md` — because they are data, not code.)
- Modules overriding base routes, base validation, or base documents. A module adds; it
  does not replace. If a base behaviour needs to vary, the base grows an extension point.
- Sandboxing. A module is trusted code, reviewed like the base.

## Next steps

Tracked in beads: mount panels and UI routes in the app; mount importers and exporters in
the Library and Documents views; wire the commit hook from the registry into the editor;
an `examples/hello-module` package exercising every point in tests; let a pack contribute
connector drawings and body layouts.
