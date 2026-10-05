---
name: wirehub-module
description: Create or change a WireHub module package (modules/<id> in this repo, or a private module in its own repo) - scaffold from modules/example, write the manifest with defineModule, add extension points (catalog packs, setup, importers, exporters, part-number scheme, validation rules, integrations, panels, compare views, routes, auth providers, commit hook, documents, derived records), register it in apps/studio/modules.config.ts, choose a licence, test it, and run it behind the dev flag. Load when asked to add a module, a domain module, or any extension point.
---

# Authoring a WireHub module

A module is an npm package that calls `defineModule` from `@wirehub/modules` and is listed in the
deployment's manifest at build time. There is no runtime plugin loading. Read `docs/modules.md`
first (principles, extension point table, mounting details); this skill is the procedure.

Decide first whether you need a module at all:

- Only **catalog data** (signals, connectors, stocks, example cables of a field)? That is a
  **domain module whose main contribution is a pack**; use this skill for the shell and
  `wirehub-catalog-pack` for the data.
- Something one shop needs (ERP link, numbering scheme, house rules, a file importer)? A module,
  normally in its own private repository (`docs/modules.md`, "A private module in its own repository").
- A change to how the model, validator or editor works for everyone? That is a base change, not
  a module; `wirehub-contribute`.

## 1. Scaffold

Copy `modules/example` (the reference implementation, MIT) to `modules/<id>`; the id is
kebab-case and must be unique across the deployment. Keep this shape:

```
modules/<id>/
  package.json     name @wirehub/module-<id>, "type": "module", "main"/"types": ./src/index.ts,
                   scripts test = "vitest run", build = "tsc --noEmit"
  tsconfig.json    copy of modules/example/tsconfig.json
  LICENSE          the module's licence text
  README.md
  src/index.ts     export const <name> = defineModule({...})
  src/logic.ts     pure parts (rules, importers, exporters, derive)
  src/ui.ts        panels and routes
  pack/            optional catalog pack (wirehub-pack.json + data files)
  test/<id>.test.ts
```

Rules taken from the example and the bundled modules:

- `@wirehub/model` and `@wirehub/modules` (and `react`, if you ship UI) are **peerDependencies**
  (`workspace:*` inside this repo) and also devDependencies for tests; add `@wirehub/catalog` as a
  devDependency when you test a pack. Copy the version pins from `modules/example/package.json`.
- Export TS source. The server imports modules through Node's type stripping: no enums,
  namespaces or parameter properties, and **no `.tsx`**; write components with `createElement`
  in `.ts` files (`modules/example/src/ui.ts`).
- Logic that runs in the browser too must be pure: no network, no clock, no randomness.
  Only integrations (server routes) may talk to the outside world.
- Point at your pack with a variable, so bundlers leave the directory alone:
  `const PACK_DIR = '../pack/'; export const MY_PACK = new URL(PACK_DIR, import.meta.url).href;`
  (`modules/av-video/src/index.ts`).
- Run `pnpm install` after creating the folder (`pnpm-workspace.yaml` already globs `modules/*`).

## 2. The manifest

```ts
export const acme = defineModule({
  id: 'acme', label: 'ACME workshop', version: '0.1.0', license: 'MIT', // semver; SPDX or LicenseRef-...
  // ...extension points below
});
```

`createRegistry` (`packages/modules/src/index.ts`) refuses a manifest with a `ModuleManifestError`
naming each problem. The checks to design around: kebab-case id; semver version; a module with
`setup` must ship at least one catalog pack; at most one module deployment-wide sets
`partNumberScheme`, and at most one sets `commitHook`; ids of importers, exporters, rules,
panels, packs and auth providers are unique across the deployment; a UI route path is lowercase
kebab segments (no parameters); an integration route path may not start with `_`; a document
may not sit under `data/derived/`; derived files are lowercase `.json` or `.md` names.
`manifestProblems(modules)` returns the list without throwing; assert it is empty in your test.

## 3. Extension points

Full shapes and mounting contracts are in `docs/modules.md` ("Extension points", "Mounting
details"); `modules/example/src/index.ts` has one working instance of each. Quick guide:

| Want | Field | Notes |
| --- | --- | --- |
| Offer at first-run `/setup` | `setup: { kind: 'domain', description, suggested? }` | needs `catalogPacks`; `/setup` lists `registry.domains()`, all unticked |
| Ship catalog data | `catalogPacks: [{ id, label, version, root, license }]` | pack format: `wirehub-catalog-pack` skill |
| Part numbers | `partNumberScheme` | build with `prefixPartNumberScheme` from `@wirehub/model`, or implement `PartNumberScheme` (`packages/model/src/part-numbers.ts`); singleton |
| House rules | `validationRules: [{ id, label, check(design, db) }]` | returns `Issue[]`; code is namespaced `<module>/<code>` by the host; runs on every save, in browser and server |
| Read a file | `importers: [{ id, label, accepts: ['.csv'], import(input, db) }]` | returns `{ definitions?, designs?, boardParts?, depictions?, notes }`; proposes, never writes; deterministic in the file and `input.options` (the review step's text choices); ids the library has are skipped, never overwritten; board art is sanitised and validated by the host. A worked importer with a review page: `modules/board-import` |
| Write a file | `exporters: [{ id, label, source?, render(design, db, options) }]` | returns `{ mimeType, fileName, body }`; `source: 'continuity'` passes the neutral `ContinuityData` as `options.continuity` for a tester's format (`docs/exports.md`) |
| Server routes | `integrations: [{ id, label, env?, routes: [{ method, path, writes?, handle }] }]` | served at `/api/modules/<module>/<path>`; `writes: true` takes the write lock |
| Job queues | `integrations: [{ …, queues: [{ id, label, schedule?, run({ request, step, db }) }] }]` | kind `<module>:<queue>`; run by the worker (Postgres) or the studio process (files), never retried; routes enqueue and read them through `request.jobs` (own queues only); `modules/example` has `example:recount` (docs/modules.md, "Job queues") |
| UI panel | `panels: [{ id, label, slot, component }]` | slots: `cable-inspector`, `cable-documents`, `library-detail`, `settings`; component takes `PanelProps` |
| Compare view | `compareViews: [{ id, label, kinds?, component }]` | the Library's Compare for those kinds (`pcbas`, `mechanicals` …; none = every kind) opens it with `CompareProps`; where no module has one the base shows a field diff |
| UI page | `routes: [{ path, label, icon?, component }]` | rendered at `/m/<module>/<path>` with `RouteProps` |
| Sign-in | `authProviders: [{ id, label, kind: 'oidc' \| 'oauth2' \| 'other', config }]` | a config key ending `Env` names an environment variable (secrets never sit in source) |
| Rewrite edits | `commitHook(before, proposed, description)` | singleton, pure, cheap |
| Own files | `documents: [{ path: 'data/<prefix>/', class: 'imported' \| 'report' }]` | written through `PUT /api/docs/*path` |
| Derived files | `derived: [{ id, label, files, derive({ designs, db }) }]` | written to `data/derived/<module>/<file>` by the commit that changes their inputs |
| Art | `art: { connectors, bodyLayouts, drawing }` | parsed JSON of the pack's `art/` files (import with `with { type: 'json' }`); SVG faces go in `pack/depictions/<id>/`; formats and rules in `specs/drawing-language.md` §7 |
| Own tables | `migrations: { dir }` | Postgres backend only: `NNNN_<module_id>_<name>.sql` files applied into schema `mod_<id>` after the base's migrations; tables with `org_id` need forced RLS and an `org_isolation` policy (docs/modules.md, "Module tables") |

Per-design data of your own goes under `CableDesign.extensions[<module id>]`; carry a `schema`
number inside it and migrate on read (`dataOf` in `modules/example/src/logic.ts`). A module never
changes the meaning of base data and never overrides base routes, validation or documents.

## 4. Register it

Inside this repository (a bundled module): add `"@wirehub/module-<id>": "workspace:*"` to
`apps/studio/package.json` dependencies, `pnpm install`, import it in
`apps/studio/modules.config.ts` and add it to the exported `modules` list. Bundling a new domain
module also changes the expected lists in `site/test/generate.test.js`,
`apps/studio/test/setup.server.test.ts` and `apps/studio/test/example-flag.server.test.ts`; the
config generator (`site/build.mjs`) reads the list from `modules.config.ts` and each module's
`src/index.ts` (it needs a `label:` and a `setup` `description:` it can find by pattern).

A private module in its own repository follows `docs/modules.md`, "Adding it to a deployment"
(git dependency or workspace folder, import in the manifest, `pnpm build && pnpm test`).

## 5. Licence

The module's licence is its author's choice: a module that talks to WireHub only through the
module API (`@wirehub/modules` plus the public exports of `@wirehub/model` and `@wirehub/catalog`)
and the catalog-pack formats may be licensed on any terms, open or closed (`MODULE-EXCEPTION.md`,
section 0 defines "Independent Module"; read it before choosing). `@wirehub/modules` itself is MIT,
which is why a module may depend on it whatever its licence. Bundled modules are MIT with CC0-1.0
pack data; use that for anything you contribute here. Put the licence in three places that agree:
`package.json` `license`, the `license` field of `defineModule`, and a `LICENSE` file (the pack
directory gets its own `LICENSE` and `wirehub-pack.json` `license`). Changes to WireHub itself stay
AGPL-3.0-only.

## 6. Test

Model your test on `modules/example/test/example.test.ts` and `modules/av-video/test/av-video.test.ts`:

- `manifestProblems([mod])` is empty; `createRegistry([mod])` exposes what you contribute.
- Every pure function with fixtures (a rule, an importer's bytes in and records out, an exporter).
- For a pack: validates over the starter catalog, installs with no conflicts, teaches the base's
  readers its words (see `wirehub-catalog-pack`).
- Use the starter catalog (`@wirehub/catalog`) or your own fixtures, never a live deployment's data.

Run: `pnpm --filter @wirehub/module-<id> exec vitest run --maxWorkers=2` and
`pnpm --filter @wirehub/module-<id> build`. The end-to-end proof for server points is in
`apps/studio/test/storage-contract/modules.ts`, for the SPA `apps/studio/test/modules.dom.test.tsx`.

## 7. Run it (dev flag)

The example module is in the manifest only when `WIREHUB_EXAMPLE_MODULE=1`
(`apps/studio/modules.config.ts`): `WIREHUB_EXAMPLE_MODULE=1 pnpm --filter studio dev`. It also sets
the deployment's single part-number scheme and commit hook, so use a scratch checkout. To try your
own module the same way, list it in the manifest behind a similar flag while developing, and
remove the flag before you contribute it. `WIREHUB_SUGGESTED_MODULES=<id>,<id>` pre-ticks modules at `/setup`.

## Checklist

- [ ] id kebab-case, unique; version semver; licence consistent in three places
- [ ] only the extension points you need; pure where the base is pure; no `.tsx`
- [ ] namespaced: rule codes, `/api/modules/<id>/`, `/m/<id>/`, `extensions.<id>`
- [ ] `manifestProblems` empty, tests and `build` green
- [ ] no shop-specific names, hosts or paths in anything public (`wirehub-contribute`)
