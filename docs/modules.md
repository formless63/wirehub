# Modules

Cable Studio's base is generic. What only one shop needs — its ERP link, its numbering
scheme, its importers for its own file layout, extra design rules, branding — goes in a
**module**: a package that contributes to a fixed set of extension points, registered at
build time in the deployment's manifest.

The skeleton exists today: `@cable-studio/modules` (`packages/modules/src/index.ts`) defines
the module shape and the registry; `apps/studio/modules.config.ts` is the manifest (empty in
the base); the server and browser each build the registry from it. Not every extension point
is mounted in the app yet — the table below says which.

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

## The module object

```ts
import { defineModule } from '@cable-studio/modules';

export const acme = defineModule({
  id: 'acme',                    // kebab, unique; also the key under CableDesign.extensions
  label: 'ACME workshop',
  version: '1.2.0',              // semver
  license: 'LicenseRef-ACME-Proprietary',
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

| Point | Shape (in `@cable-studio/modules`) | Where it runs | Mounted today |
| --- | --- | --- | --- |
| **Catalog packs** | `CatalogPackContribution { id, label, version, root?, license? }` — a data directory laid out like `packages/catalog/data` | server, at install | registry only; install flow in `docs/catalog-store.md` |
| **Importers** | `ImporterContribution { id, label, accepts: ['.kicad_pcb'], import(input, db) → { definitions?, designs?, notes } }` — proposes records, never writes | server (may run in the browser if pure) | registry + `importersFor(fileName)`; UI not yet |
| **Exporters / document types** | `ExporterContribution { id, label, description?, render(design, db, options) → { mimeType, fileName, body } }` | browser and server | registry only; Documents view not yet |
| **PN schemes** | `PartNumberScheme { id, label, parse, check, suggest }` (`@cable-studio/model`) | everywhere | **yes** — the editor's PN field, the library, BOM proposals |
| **Validation rules** | `ValidationRuleContribution { id, label, check(design, db) → Issue[] }` | everywhere | **yes** — every design save runs them after `validateDesign` |
| **Integrations** | `IntegrationContribution { id, label, env?, routes?: { method, path, writes?, handle(request) }[] }` | server only | **yes** — `/api/modules/<module>/<path>`; `writes: true` routes take the write lock |
| **UI panels** | `PanelContribution { id, label, slot: 'cable-inspector' \| 'cable-documents' \| 'library-detail' \| 'settings', component }` | browser | registry only |
| **UI routes** | `UiRouteContribution { path, label, icon?, component }` under `/m/<module>/` | browser | registry only |
| **Auth providers** | `AuthProviderContribution { id, label, kind: 'oidc' \| 'oauth2' \| 'other', config }` | server | registry only; the base's own OIDC is configured by environment |
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
acme-cable-studio-module/          (private repo)
  package.json                     name: @acme/cable-studio-module
                                   peerDependencies: @cable-studio/model, @cable-studio/modules
  src/index.ts                     export const acme = defineModule({...})
  src/panels/*.tsx                 (peer: react)
  data/                            a catalog pack, if it ships one
  test/                            vitest against @cable-studio/catalog's starter catalog
```

Rules for the module's package:

- `@cable-studio/*` packages are **peer dependencies**, so the module is built against the
  deployment's copy and never bundles a second one.
- It exports TS source like the base packages (or compiled ESM — either bundles).
- Its tests run against the base's starter catalog or its own fixtures, never against a
  deployment's live data.

### Adding it to a deployment

A deployment is a checkout of this repository (or a fork that tracks it) plus its manifest:

1. Add the module as a dependency of the app — a git dependency, a private registry
   package, or a workspace folder:
   ```
   pnpm --filter studio add git+ssh://git@git.example.com/acme/acme-cable-studio-module.git#v1.2.0
   ```
   (For local development of the module, add its folder to `pnpm-workspace.yaml` instead.)
2. List it in `apps/studio/modules.config.ts`:
   ```ts
   import { acme } from '@acme/cable-studio-module';
   export const modules = [acme];
   ```
3. `pnpm build && pnpm test`, then rebuild the image (`docker compose up --build`). A bad
   manifest fails at startup and in the build with `ModuleManifestError`, naming each
   problem.

Keeping the deployment's own changes to the manifest and the lockfile only means pulling a
new base version is a plain merge. A deployment that must not have its manifest in a public
fork keeps a private fork of this repository whose only difference is those two files.

### Versioning and compatibility

- The registry API (`@cable-studio/modules`) and the model types are the module contract.
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
an `examples/hello-module` package exercising every point in tests.
