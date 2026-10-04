<p align="center">
  <img src="brand/wirehub-header.svg" alt="WireHub — cable assemblies as canonical definitions" width="100%">
</p>

# WireHub

WireHub captures the cable assemblies you build as canonical definitions, and
derives everything else from them: wiring schematics, build sheets, BOMs,
continuity test specs, drawings and wire specs.

- **A hierarchical wire model.** A stock is a tree: cables hold pairs, coax and cores,
  which hold conductors, shields and insulation. Bonded screens, drains, pigtails and
  breakouts (moulds where some conductors pass through and others end) are modelled
  as they are built.
- **A connector library.** A connector is a physical body (DE-9 male, XLR3 female)
  composed with a pinout (RS-232, balanced audio). Reuse one body for many pinouts.
- **PCBAs as black boxes** with declared internal continuity, so a trace runs through a
  board without modelling its electronics.
- **Derived, deterministic output.** Nets and traces, a continuity spec, a BOM, a
  bench build sheet, an ELK-laid-out SVG schematic and an ANSI-A drawing sheet all come
  from the same JSON definition, byte for byte the same every time.
- **An editor.** A React canvas for the wiring, a parts library with 3D views, a new-cable
  wizard, versions, edit locks and an optional login.
- **Modules.** Domain vocabularies (video, audio, fieldbus …) and what only one shop needs
  (its ERP link, its numbering scheme, its own importers) plug in at build time through
  a small registry instead of living in the base.

## Run it

With Docker:

```
git clone https://github.com/formless63/wirehub && cd wirehub
bash scripts/setup-env.sh       # once: .env with generated secrets
docker compose up -d            # open http://localhost:5183
```

A fresh hub opens on **first-run setup**: pick the domain modules whose signals,
connectors and examples you need — AV / video and Automotive are bundled; nothing is
required, and more can be added later. The base itself stays generic.

The stack is the app, [Garage](https://garagehq.deuxfleurs.fr/) (S3-compatible storage
for uploaded files) and PostgreSQL 18. **PostgreSQL is provisioned for the upcoming
database backend and not used yet** — today the catalog and designs are JSON files in a
volume, and uploaded file bytes go to Garage. `docs/self-hosting.md` has the details,
the filesystem fallback and the recommended backups (restic through Backrest,
`compose.backup.yaml`).

From source (Node 24+, pnpm 10 — `corepack enable`):

```
pnpm install
pnpm --filter studio dev        # open the printed URL
```

The hub opens on the starter catalog: example cables built from a small library of
generic parts, every value cited to a public standard or marked as a synthetic example.
The catalog is plain JSON under `packages/catalog/data`, and saves go straight back to it.

## Develop

```
pnpm build                      # tsc --noEmit, strict, every package
pnpm test                       # vitest, each workspace in turn
pnpm --filter @wirehub/model test -- test/trace.test.ts
bash scripts/privacy-check.sh --tree
```

`pnpm install` also enables git hooks that keep home paths, secrets and personal
emails out of commits (`CONTRIBUTING.md`).

| Package | |
| --- | --- |
| `@wirehub/model` | the canonical model: types, validation, nets, trace, part-number schemes. Zero dependencies. |
| `@wirehub/catalog` | the file-backed catalog and the starter data. Zero dependencies. |
| `@wirehub/modules` | the module API and build-time registry. Zero dependencies, MIT. |
| `@wirehub/layout` | ELK layout of a design |
| `@wirehub/render-svg` | deterministic SVG schematics and cross-sections |
| `@wirehub/docs` | build sheet, BOM, continuity spec, drawing, wire spec |
| `@wirehub/editor-react` | the editor |
| `apps/studio` | the app: Vite SPA and Hono server |
| `modules/*` | bundled, optional domain modules |

## Read next

- `SPEC.md` — the model and the plan; the single source of truth.
- `docs/modules.md` — extension points, domain modules, and how a private module lives
  in its own repository.
- `docs/catalog-store.md` — catalog packs: format, provenance, install and update.
- `docs/self-hosting.md` — the compose stack, storage and backups.
- `specs/postgres-backend.md` — the database backend (planned).
- `docs/boundaries.md` — what this base was split from, and what it left out.

## Licence

WireHub is free software under the **GNU Affero General Public License v3.0 only**
(`LICENSE`), with one additional permission, the **WireHub Module Exception**
(`LICENSE-EXCEPTION.md`). In plain language:

- **WireHub itself stays open.** If you modify WireHub and run it for others — including
  over a network — you offer them the source of your modified WireHub, under the AGPL.
- **Modules can use any licence.** A module that talks to WireHub only through the module
  API (`@wirehub/modules`, the model and catalog types) and the catalog-pack formats may
  be MIT, proprietary, or anything else. You can build and distribute a WireHub image that
  includes it without the module becoming AGPL, and without publishing its source.
- **`@wirehub/modules` is MIT**, so module authors can depend on it freely.
- **Catalog data is CC0-1.0.** The starter catalog (`packages/catalog/data`) and the
  bundled modules' packs are dedicated to the public domain, so the facts in them can
  be reused anywhere. Other packs, and records in them, carry their own licence
  (`docs/catalog-store.md`).
- Third-party material keeps its own licence (`NOTICE`).

There are no per-file licence headers: `LICENSE`, `LICENSE-EXCEPTION.md` and each
package's `license` field are the record (`SPDX: AGPL-3.0-only WITH
AdditionRef-WireHub-Module-Exception-1.0`, `packages/modules`: `MIT`; `packages/catalog`: `AGPL-3.0-only AND CC0-1.0`, the code and
its data; bundled modules: `MIT`, their packs `CC0-1.0`). This summary is
not legal advice; the licence texts govern.

Contributing: `CONTRIBUTING.md` · Security: `SECURITY.md` · Conduct: `CODE_OF_CONDUCT.md`
