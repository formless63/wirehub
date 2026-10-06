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
  `1.0` was the build-time-only contract). A breaking change to the module contract bumps the
  major; anything added bumps the minor. A module is compatible when the major is equal and
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
  documents, derived records, art and bench steps (unregistered and registered again on every
  swap, `installModuleArt`), and **auth providers** apply live (sign-in is rebuilt in-process by
  `liveStudioAuth`, the runtime-settings mechanism, now also on a provider change). **Restart
  required:** none of the supported runtime extension points. Integration job queues on Postgres
  apply live: the worker serializes registry reconciliation, creates and works added queues,
  reschedules updated queues, and unschedules and stops working removed queues. Running jobs
  finish; pending recorded jobs of a removed queue are cancelled, and no new job executes a
  disabled module. A job resolves its handler from the current registry after its claim, so an
  update uses the latest implementation. The worker heartbeat lists the queues currently worked.
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
- **Worker.** The worker builds the same live registry and host, loads it before it binds its
  queues, and follows the same `LISTEN studio_catalog` notification; import jobs and derived
  records use the live set.
- **Art validation.** Art or bench rules of a runtime module that do not validate are left out
  (the built-ins' stay) and logged; they never stop the hub.

## 4. Restart from the UI

Settings → Code modules → **Restart WireHub** (owners, signed in), `POST /api/system/restart`:

1. answers `202 { restarting: true, bootId, supervised, poll }` at once (`bootId` is the process being
   replaced, `poll` is `/api/system/boot`; 202 means accepted, the drain has not happened yet), then **drains** (`system.ts`, each step
   bounded at 20 s): the HTTP server stops accepting connections and new requests on open ones
   get 503 *restarting*; the requests in flight finish; the write lock is taken and held (no write
   is half done, none starts); the worker is told; the code-module host stops following the
   catalog; sign-in, the stores, the pools and LISTEN connections are closed; the remaining
   connections (event streams) are closed. Edit leases belong to the people holding them, not to
   the process: on Postgres they stay in the database, on files they are in memory and every
   holder takes its lease again on its next heartbeat, as after any restart;
2. logs `[restart] requested by <name>: exiting with code 75 (restart requested, not a crash)` and
   exits with **75** (`RESTART_EXIT_CODE`), distinct from a crash (1) and a stop (0).
3. On Postgres the worker is told through `NOTIFY studio_control` (`{ org, action: 'restart' }`):
   it lets a running job finish (the pg-boss graceful stop, 30 s), logs the same line and exits 75.

`restart: unless-stopped` (compose: `wirehub`, `worker` and every other long-running service —
`postgres`, `garage`, `backup-dump`, `backup-mirror`, `backrest`, `pdf`; the one-shots `bootstrap`,
`migrate`, `garage-init`, `backup-init` are `"no"`; verified 2026-10-05) brings both back. The page
shows *Restarting WireHub…*, polls `GET /api/system/boot` until the boot id changes (and `restarting` is
false), then reloads (`waitForRestart` in `src/code-modules.browser.ts`). Any other client does the same:
the response carries the id it must see replaced.
Without a supervisor (a checkout run by hand) the process simply exits; the page says so when
`WIREHUB_RESTART_SUPERVISED` is not `true` (compose sets it for the app).

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

- `packages/modules/test/runtime.test.ts`: API compatibility, points, permissions, the live
  registry, composition with built-ins.
- `apps/studio/test/code-modules.server.test.ts` (files) and `test/pg/code-modules.server.test.ts`
  (Postgres), one session (`test/code-modules-scenario.ts`): the example module built by
  `wirehub-module build` into a signed bundle; unsigned, untrusted, wrong key, an editor, an
  incompatible apiVersion, an undeclared point, no consent and the kill switch (Settings and
  environment) refused; installed by upload with a pinned key, its route, rule, exporter, panel and
  browser entry working without a restart; off and on; updated; a module that throws at load
  never enabled by a click and quarantined at the next start with the hub answering; removed;
  installed from a signed test store, and refused from a store that does not name its publisher.
  On Postgres also: one change set each, the code in the blob store, and the worker told to restart
  over `NOTIFY studio_control`. The restart drain and exit code, simulated.
- `test/code-modules-contract.server.test.ts`: the example installed at runtime answers the module
  contract (`storage-contract/modules.ts`) step for step as the built-in does.
- `test/code-modules.dom.test.tsx`: the open page loads a verified browser entry on a catalog event
  and renders its panel, drops it and asks for a refresh, refuses bytes that do not match.
- `test/code-modules-ui.dom.test.tsx`: consent before Install; Settings lists, turns off, restarts
  and reloads.
- `test/store-template.server.test.ts`: a store builds a code module from `modules/`.
- `scripts/restart-smoke.sh <image>` (port 5560 by default): the compose stack, a runtime install by
  upload, Restart WireHub through the API, the app and the worker exiting 75 and restarted by their
  policy, the page's reconnect, the module loaded again.
