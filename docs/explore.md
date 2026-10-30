# Exploring solutions

State what you need; WireHub lists the combinations of what the library already has, says of each
whether it is **valid**, **invalid** (and why) or **unknown** (and which facts nobody has stated),
lets you compare a few side by side, and turns the one you pick into a draft. Nothing needs to be
complete first, and nothing is saved until you decide something.

The engine is `explore.ts` in `@wirehub/model` (pure, deterministic, no network); it builds on the
device resolver (`docs/resolver.md`), the stock suggestion, the plug matching, the firmware projects
(`docs/firmware.md`), the enclosure parameters and inventory lots (`docs/inventory.md`).

## Requirements

| Kind | Says | Dimensions enumerated |
| --- | --- | --- |
| `connect` | `source` and `destination` device (and port), optional `signals` it must carry, optional `lengthMm` | resolver options (refused ones too), the three best-fitting stocks per option, plugs that mate each end, firmware projects of an adapter board the option uses |
| `enclose` | a `board`, the `ports` that need an opening, `firmware: true` when it needs firmware | enclosure presets, the printers of the hub's print profiles, the board's firmware projects (or the supported targets when none exists yet) |

## Verdicts

- **invalid**: a reject hazard refuses the option; a missing piece (a level nothing converts, a bus
  line nothing carries); an asked-for signal the option does not carry; no stock or plug in the
  library; a port opening that runs into the lid; an outside size over a preset's `maxOuterMm`; a
  base that does not fit a printer's plate (turned 90° if that helps) or build height.
- **unknown**: facts nobody stated — an unconfirmed pin fact, a signal neither port declares, the
  board's width/length/part height, where a required port sits, a firmware project never compiled, a
  target with no project yet, the cable length.
- **valid**: neither. Hazard warnings and notes stay on the row.

Unknown is not a refusal: **Use** works on any derivable row, so experimental drafts are possible.

## Decisions (overrides)

Kept per requirement (its key: ends, signals, ports; not the length) and applied on every re-run:

| Kind | Target | Effect |
| --- | --- | --- |
| `exclude` | `option:`, `stock:`, `plug:source:`, `plug:destination:`, `firmware:`, `target:`, `preset:`, `printer:`, `combo:` | the row is shown last, marked excluded |
| `prefer` | same | ranks first within its verdict |
| `include` | `stock:<id>` | adds a stock the suggestion did not list (checked like any other) |
| `assume` | `fact:<key>` | that unknown fact is accepted; the row reads valid when nothing else is missing |

A decision whose target no longer appears (a library change) is listed as **stale**, not dropped.

## Presets

Built in: `compact`, `standard` (the generator defaults), `rugged`, `split-vented`. A hub adds or
shadows presets by id (`data/explore/presets.json`): `{ id, label, params, maxOuterMm?, src }`.

## Picking

- `connect`: `deriveCable` on the chosen option and stock; other plugs are swapped in and recorded as
  recipe overrides (so drift stays honest). The design is status development, with its recipe.
- `enclose`: a shell mechanical with the preset's parameters and the board's known facts.

The pick is recorded on the saved exploration. Board proposals for an option's gaps are offered only
when asked (**Board proposals for the gaps**); a decline goes to the one proposals log.

## API

| Route | |
| --- | --- |
| `GET /api/explore` | saved explorations, presets (built-in, local, in force), firmware targets, ETags |
| `POST /api/explore/run` | `{ requirement, overrides? }` → the exploration (saved overrides when none are sent), with firmware build state and inventory availability |
| `PUT /api/explore/saved` | `{ exploration: { requirement, overrides, label?, picked? } }` (If-Match) |
| `DELETE /api/explore/saved?key=` | forget one (If-Match) |
| `PUT /api/explore/presets` | `{ presets }` (If-Match) |
| `POST /api/explore/pick` | `{ requirement, combo, overrides?, id?, label? }` → the combination made a draft through the ordinary create route (a design, or a shell mechanical) and the pick kept on the saved exploration, one change set; `?dryRun=1` previews. A draft-work token (`drafts:write`) may pick |

`POST /api/explore/run` writes nothing, so a token needs only `read` for it. Over MCP the two are the
`explore` and `explore_pick` tools (`docs/mcp.md`). Both work on the database backend (the saved
explorations are catalog documents in the unit of work there too).

Both are catalog documents through the unit of work (`data/explore/saved.json`,
`data/explore/presets.json`); no schema migration.

## In the app

`/explore` (from **Find a design → Explore alternatives**, or a board's **Explore enclosures**).
Left: the requirement, the decisions, the kept explorations. Right: the rows, filters by verdict,
tick 2–4 to compare (differences in bold), **Use**.
