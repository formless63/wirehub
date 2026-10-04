# Cable Studio

Cable Studio captures the cable assemblies you build as canonical definitions, and
derives everything else from them: wiring schematics, build sheets, BOMs, continuity
test specs, drawings and wire specs.

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
- **Modules.** What only one shop needs (its ERP link, its numbering scheme, its own
  importers) plugs in at build time through a small registry instead of living in the base.

## Quick start

Requirements: Node 24 or newer, pnpm 10 (`corepack enable`).

```
pnpm install
pnpm --filter studio dev        # open the printed URL
```

The studio opens on the starter catalog: seven example cables — a DB9 null modem, an
RJ45 patch lead, an XLR microphone cable, a TRS-to-2×RCA Y lead, an RS-485 adapter with
a termination board, a USB LED lead and a VGA monitor cable — built from a small library
of generic parts, every value cited to a public standard or marked as a synthetic example.

Or with Docker:

```
docker compose up --build       # http://localhost:5183
```

The catalog is plain JSON under `packages/catalog/data` and saves go straight back to it.
`.env.example` lists the optional settings (login, git export of saves).

## Develop

```
pnpm build                      # tsc --noEmit, strict, every package
pnpm test                       # vitest, each workspace in turn
pnpm --filter @cable-studio/model test -- test/trace.test.ts
bash scripts/leak-scan.sh       # keeps private material out (docs/boundaries.md)
```

| Package | |
| --- | --- |
| `@cable-studio/model` | the canonical model: types, validation, nets, trace, part-number schemes. Zero dependencies. |
| `@cable-studio/catalog` | the file-backed catalog and the starter data. Zero dependencies. |
| `@cable-studio/modules` | the build-time module registry. Zero dependencies. |
| `@cable-studio/layout` | ELK layout of a design |
| `@cable-studio/render-svg` | deterministic SVG schematics and cross-sections |
| `@cable-studio/docs` | build sheet, BOM, continuity spec, drawing, wire spec |
| `@cable-studio/editor-react` | the editor |
| `apps/studio` | the app: Vite SPA and Hono server |

## Read next

- `SPEC.md` — the model and the plan; the single source of truth.
- `docs/modules.md` — extension points and how a private module lives in its own repo.
- `docs/catalog-store.md` — catalog packs: format, provenance, install and update.
- `specs/postgres-backend.md` — the database-backed, self-hosted deployment (planned).
- `docs/boundaries.md` — what this base was split from, and what it left out.

## Licence

To be decided — see `LICENSE`. Third-party material: `NOTICE`.
