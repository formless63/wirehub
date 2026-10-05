# Spec — Runtime code modules: install from the UI, hot reload, restart from Settings

Status: **built** (cs-5oi, 2026-10-05). Owner decision (2026-10-05): *everyone runs the same
public image and picks modules in the UI.* A code module installs at runtime, not at image
build time. Any reload or restart needed to bring one in is done from the WireHub UI, never
through an outside interface (no Docker socket, no Komodo, no restarts from outside).

Read `docs/modules.md` (the module contract) and `docs/catalog-store.md` (packs, stores,
signatures) first; this spec extends both and changes no existing behaviour of a hub that
installs no code module.

## 1. The bundle format

A code module ships **inside a catalog pack**. The pack is the unit a store lists, a person
installs, a signature covers and `packs.json` records; a pack may carry records, a module, or
both. A code-only module is a pack with no record files.

```
acme-erp-1.2.0/
  wirehub-pack.json              the pack manifest, with a "module" block (below)
  wirehub-pack.sig               the publisher's signature over the manifest (required for code)
  code/acme-erp/server.mjs       the server entry: one self-contained ESM file
  code/acme-erp/browser.mjs      optional: the browser entry (panels, routes, compare views …)
  code/acme-erp/browser.css      optional: the browser entry's styles
  connectors.json …              optional: the module's data, exactly as in any pack
```

```jsonc
// wirehub-pack.json
{
  "format": 1, "id": "acme-erp", "name": "ACME ERP link", "version": "1.2.0",
  "license": "LicenseRef-ACME", "publisher": { "id": "acme", "name": "ACME" },
  "module": {
    "id": "acme-erp",                    // the WireHubModule id (kebab); unique in the hub
    "version": "1.2.0",                  // the module's own semver
    "label": "ACME ERP link",
    "apiVersion": "1.1",                 // the @wirehub/modules API it was built against
    "server": "code/acme-erp/server.mjs",
    "browser": "code/acme-erp/browser.mjs",   // optional
    "css": "code/acme-erp/browser.css",       // optional
    "extensionPoints": ["exporters", "integrations", "panels", "validationRules"],
    "permissions": ["server-code", "browser-code", "routes", "env:ACME_ERP_TOKEN"]
  },
  "files": { "code/acme-erp/server.mjs": "…sha256…", … }   // written by sign-pack
}
```

- **Entries** are single ESM files with no bare imports: `@wirehub/modules`, `@wirehub/model`
  and the module's own dependencies are bundled in. React (`react`, `react/jsx-runtime`,
  `react-dom`) is the host's, reached through `globalThis.__wirehub.shared` — a second React
  would break hooks. `wirehub-module build` (§6) writes exactly this.
- The server entry's default export (or its only export that is a module object) is the
  `WireHubModule`, with the manifest's id and version. The browser entry exports the same
  module (its components are real there; on the server they are opaque values).
- **File paths** are `code/<module id>/(server|browser).mjs` and `code/<module id>/browser.css`,
  nothing else under `code/`; each at most 4 MiB, all of a pack's code 8 MiB. A `code/` file the
  `module` block does not name is refused.
- **apiVersion** is `<major>.<minor>` of `MODULE_API_VERSION` (`@wirehub/modules`, now `1.1`;
  `1.0` was the build-time-only contract). A module is compatible when the major is equal and
  its minor is not newer than the hub's. Anything else is refused before a byte runs.
- **Extension points** declared must cover what the module object contributes
  (`extensionPointsOf`); **permissions** must cover what it does (`permissionsOf`: `server-code`,
  `browser-code`, `routes`, `writes` (a route that takes the write lock, or an importer),
  `jobs`, `sign-in`, `env:<NAME>` for every variable it names). A module that does more than it
  declared is refused at load. Permissions are not a sandbox (a module is trusted code, §2):
  they make the consent step honest.
- **Not allowed in a runtime module:** `migrations` (the hub's migrate one-shot runs as the
  schema owner before the app; a runtime module cannot reach it — bead filed) and `setup` /
  `catalogPacks` (the carrying pack *is* the data; the host ignores both, and the build tool
  copies the module's pack directory into the bundle instead).

### Installing is installing a pack

Upload (Library → Modules → Install pack…) and a store (Library → Browse store) take the pack
doors they always did (`POST /api/packs/install`, `POST /api/packs/store/install`): the same
archive reader, file pins, record-level diff and plan, one change set (files: the pack layer
and `packs.json`; Postgres: one change set through the scratch copy), the same history.
`packs.json` records the module beside the pack:

```jsonc
{ "id": "acme-erp", "version": "1.2.0", …, "assets": { "code/acme-erp/server.mjs": "…" },
  "module": { "id": "acme-erp", "version": "1.2.0", "label": "…", "apiVersion": "1.1",
              "files": { "server": "<sha256>", "browser": "<sha256>" },
              "extensionPoints": […], "permissions": […],
              "trust": { "via": "store" | "pinned", "keys": ["RW…"] } } }
```

The code files are pack **assets** (as images are): on files they live in the pack's layer
(`<WIREHUB_PACKS_DIR>/<pack>/code/…`, the `packs` volume); on Postgres they are catalog files
(`data/code/<module>/…`, `catalog_file` → the blob store), reconciled on update and removed on
disable like every other pack asset. Disabling (removing) the pack removes the module; turning a
module off keeps its files (§3).

## 2. Trust

- **Owners only** install, update, enable or disable a code module, in a signed-in session (a
  host without roles counts as an owner; no API token, ever). An editor may still install data
  packs; a pack that carries a module answers 403 for anyone else.
- **Signed by a trusted publisher key**, always: from a store, the index must list the pack's
  publisher and the pack must carry a valid signature by one of its keys (phase 5's rules, which
  for a data pack are optional, are mandatory for code: an index that does not name the publisher
  is not enough); by upload, the signature must verify with a key the owner **pinned** — in the
  request (`trustKey`, saved to the pinned list on apply) or earlier (Settings → Code modules →
  Trusted keys). A revoked key never counts. Unsigned or untrusted: 422, nothing written.
- **Consent.** The install preview shows a `code` block — the module, its declared extension
  points and permissions, who signed it, and the sentence *"This module runs code in your hub,
  with the same access as WireHub itself."* The apply must repeat `consent: { code: "<module
  id>@<version>" }`; without it 409, nothing written.
- **Kill switch.** `WIREHUB_ALLOW_CODE_MODULES` (install-level, default `true`; `false` in the
  environment wins over everything) and Settings → Code modules → *Allow code modules* (owner,
  default on). Off: no code module is installed, enabled or loaded, already-loaded ones are
  unloaded at the next sync, and the page says why. The **bundled built-in modules always load**.

## 3. Loading

State: `packs.json` (what is installed) plus the owner's document `data/settings/code-modules.json`
(`{ allow, modules: { <id>: { enabled, by, on } }, keys: [{ key, label, by, on }] }`), written
through the same change-set path. A module is loaded when it is installed, enabled, allowed and
not quarantined.

- **The live registry.** `@wirehub/modules` gains `createLiveRegistry(initial)`: a
  `ModuleRegistry` that delegates every call to the registry it currently holds, plus
  `replace(next)` and `subscribe`. The server's `registry` (`server/modules.ts`) and the
  browser's are live; everything that held the registry keeps holding it and sees the swap.
- **Composition and precedence.** `composeRegistry(builtins, runtime)`: the built-ins
  (`modules.config.ts`) first, in manifest order; then the runtime modules in id order, each
  accepted only if the registry with it still has no `manifestProblems`. An id the image already
  has is refused (*a built-in wins; uninstall or rename*), as is a second part-number scheme or
  commit hook or a clashing importer/exporter/provider id. A refused module is reported with
  the sentence, never half-registered.
- **Server.** `CodeModuleHost.sync()` reads the state, fetches each enabled module's server entry
  (the pack layer on files, the blob store on Postgres), checks its sha256 against `packs.json`,
  writes it to the module cache (`WIREHUB_MODULE_CACHE_DIR`, default `<tmp>/wirehub-code-modules`)
  as `<id>-<sha>.mjs` and `import()`s it with a generation query (`?g=<n>`), so an update or a
  re-enable is a fresh module instance. Then one registry swap. It runs at boot (before sign-in
  is built), on every catalog change notification, and before answering the module APIs.
- **Hot reload where safe** (`applyModeOf(points)`): validation rules, importers, exporters, the
  part-number scheme, panels, compare views, UI routes, integration routes, the commit hook,
  documents, derived records and **auth providers** apply live (sign-in is rebuilt in-process by
  `liveStudioAuth`, the runtime-settings mechanism, now also on a provider change). **Restart
  required:** integration job queues (pg-boss queues are bound at boot) and art (registered once,
  first wins). A change to a module with a restart-required point is recorded and the module
  loads on the next start; the API and the page say "restart required" with the Restart button.
- **Isolation.** An import that throws, a default export that is not a module, a mismatch with
  the manifest, an undeclared point or permission, or a registry clash: the module is
  **quarantined** in that process (not registered, status `failed` with the error), the rest load,
  and the hub stays up. On an owner's enable or install the trial load runs first and a failure
  is the answer (409 with the error), so a broken module is never left enabled by a click.
  Quarantine is per (module, sha): a new version, or an enable, retries.
- **Browser.** `GET /api/code-modules/browser` lists the loaded modules' browser entries as
  content-addressed URLs (`/api/code-modules/files/<sha>.mjs|.css`, immutable) with their
  `sha256-…` integrity. The SPA fetches each, checks the digest (SubtleCrypto), imports it from a
  blob URL, composes the same registry and re-renders its slots — no page reload. It re-syncs on
  every catalog event. When a module it already ran is removed or replaced and that module set a
  commit hook or carried CSS, a banner asks for a page refresh (old code cannot be unloaded from
  a page).
- **Worker.** The worker builds the same live registry and host and follows the same
  `LISTEN studio_catalog` notification; import jobs and derived records use the live set.

## 4. Restart from the UI

Settings → Code modules → **Restart WireHub** (owners, signed in), `POST /api/system/restart`:

1. answers `202 { restarting: true, bootId }` at once, then **drains**: the HTTP server stops
   accepting connections and waits for in-flight requests (at most 20 s), the write lock is taken
   (so no write is half done), edit leases held by this process are released (memory leases on
   files; the database's leases expire on their own), the job runner is stopped, pools and
   LISTEN connections closed;
2. logs `[restart] requested by <name>: exiting with code 75 (restart requested, not a crash)` and
   exits with **75** (`RESTART_EXIT_CODE`), distinct from a crash (1) and a stop (0).
3. On Postgres the worker is told through `NOTIFY studio_control` (`{ org, action: 'restart' }`):
   it lets a running job finish (the pg-boss graceful stop, 30 s), logs the same line and exits 75.

`restart: unless-stopped` (compose: `wirehub`, `worker` and every other long-running service;
one-shots are `"no"`) brings both back. The page shows *Restarting WireHub…*, polls
`GET /api/system/boot` until the boot id changes, then reloads. Without a supervisor (a checkout
run by hand) the process simply exits; the button says so when `WIREHUB_RESTART_SUPERVISED` is not
`true` (the image sets it).

Install, update, enable and disable answer `apply: 'live' | 'restart'` per §3 so the UI offers
"Applied" or "Restart required — Restart now".

## 5. Built-ins and bundled

`modules.config.ts` keeps listing what the image ships (the domain modules, board import,
wireviz, csv-library, the example behind its flag). Those always load and cannot be turned off
by the kill switch. Store-installed code modules sit on top (§3, precedence).

## 6. Tooling

`pnpm --filter studio wirehub-module build <module package dir> [--export name] [--pack dir]
[--out dir] [--key publisher.key]` (`apps/studio/scripts/wirehub-module.ts`): bundles the
module's entry twice with Vite's library build (Rollup/Rolldown, already the app's toolchain: no
new dependency), server and browser, with the shared React shim; derives `extensionPoints` and
`permissions` from the module object; copies `--pack` (default: the package's `pack/` when it
has one) as the bundle's data; writes the pack directory, and signs it when a key is given
(`sign-pack`). `store-index.mjs bundle` zips it; the store template and its action build code
modules from `modules/<dir>` beside `packs/`.

## 7. Tests

`packages/modules/test/runtime.test.ts` (API compatibility, points, permissions, live registry,
composition), `apps/studio/test/code-modules.server.test.ts` and
`test/pg/code-modules.server.test.ts` (the example module packaged as a runtime bundle: upload with
a pinned key and from a signed test store; its rule, exporter, panel and route answer without a
restart; disable, update, auto-quarantine of a module that throws, incompatible apiVersion,
unsigned and untrusted refused, non-owner refused, kill switch; the restart drain and exit code,
simulated), `test/code-modules.dom.test.tsx` (the SPA loads a browser entry and renders its panel
without a reload). `scripts/restart-smoke.sh` runs the stack, presses Restart through the API and
shows the container restart and the page reconnect.
