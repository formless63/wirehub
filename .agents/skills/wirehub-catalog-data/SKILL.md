---
name: wirehub-catalog-data
description: Author or edit WireHub catalog records by hand - connector bodies, interfaces (pinouts), connectors, wire stocks, components, mechanicals, kits, PCBAs, vocabulary (signals, levels, lanes, families, colour codes), and example designs - with the right ids, required fields, src citations, CC0 licensing and canonical JSON, then run the validators. Load when adding or correcting any JSON under packages/catalog/data or a module's pack/.
---

# Authoring catalog records

The catalog is JSON files; the starter catalog is `packages/catalog/data/` and a domain pack
(`modules/<id>/pack/`) has the same layout. SPEC.md ("Domain model", "The starter catalog") is the
authority on the shapes; `references/record-types.md` lists, per file, the fields and the checks
the validators run. Write a record, then validate it (section 6).

## Which file holds what

| Record | File | Required (loader / validator) |
| --- | --- | --- |
| connector body | `bodies.json` | `id`, `label`, `family`, `gender`, `positions[]`, `src` |
| interface (pinout) | `interfaces.json` | `id`, `label`, `bodies[]`, `pins{}` (position id to `{ signal }`), `src` |
| connector | `connectors.json` (required file) | `id`, `label`, `family`, `body` + `interface` (or hand-listed `pins`), `src` |
| wire stock | `wires.json` (required file) | `id`, `label`, `structure` (root group), `src` |
| component | `components.json` (required file) | `id`, `label`, `kind`, `terminals[]`, `src` |
| mechanical | `mechanicals.json` | `id`, `label`, `kind`, `src` |
| kit | `kits.json` | `id`, `label`, `sku`, `contents[]`, `src` |
| PCBA | `pcbas.json` | `id`, `label`, `partNumber`, `revision`, `terminals[]`, `internalLinks[]`, `src` |
| vocabulary list | `vocab/<list>.json` | `{ id, label, src, entries[] }`; each entry `id`, `label`, `src` |
| design | `designs/<id>.json` | the `CableDesign` (SPEC.md), `src` |

Only `connectors.json`, `wires.json` and `components.json` must exist; the rest are optional.
There is **no data file for rules**: design rules are module code (`validationRules`, see
`wirehub-module`), and a shop's own rule data was deliberately left out of the base
(`docs/boundaries.md`).

## Ids

- Kebab-case: lowercase letters and digits in hyphen-separated groups (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
- Unique across **definitions of all kinds** (connectors, wires, components, PCBAs, mechanicals
  share one id space; `validateDb` reports `duplicate-id`). Bodies and interfaces have their own
  id lists; vocabulary entries are unique within their list.
- A design id is also its file name: `designs/<id>.json`.
- **Ids never change meaning.** Renaming means a new `label` with the old one kept in `aliases`;
  merging means `deprecatedBy`; vocabulary entries are never removed (`vocabChangeIssues`).
- Pin ids are strings (`"1"`, `"shell"`, `"tip"`); wire element ids are unique among siblings and
  address as dot paths (`pair-1.a`). Wire ends: `a` = source side, `b` = destination side.
- Part numbers: never hard-code a numbering pattern. A pack record carries **no shop part
  number**; a deployment numbers records through its `PartNumberScheme`. Use `mpn` and
  `manufacturer` for a specific product (components) and leave `partNumber` out.

## `src`: the citation (mandatory)

Every record, every vocabulary entry and list, every design and every kit line carries `"src"`.
A missing `src` is a `missing-src` warning from `validateDb` and a review blocker.

- Cite a **public** source precisely: standard by number and clause (`IEC 60807-3 DE-9 contact
  numbering`, `AES14 cable-mount female`), a datasheet by manufacturer, document and revision,
  or your own measurement and how it was made.
- **Mark inferred values inside the text**: `inferred from ...`, `assumed: ...`. Where a fact is
  discretionary rather than standard (a manufacturer-chosen pin), say so; do not present it as
  standard (`docs/catalog-store.md` section 5).
- Examples with no real-world source say `synthetic example` (the starter's designs must start
  with it: `packages/catalog/test/catalog.test.ts`).
- **No private data anywhere**: no customer, supplier, person, host or internal-product names, no
  paths, no values read from a private catalog. The privacy hooks check the obvious cases
  (`wirehub-contribute`); the rest is on you.
- Pin assignments and dimensions are facts: cite the standard, **never copy its text, tables or
  figures**. Where the source is licensed, see `wirehub-import-public-data`.

## Licence of data

Starter catalog and bundled pack data are **CC0-1.0**. Data you contribute to them is dedicated
to the public domain; only contribute what you have the right to dedicate. A pack that carries
another licence says so in its manifest (`wirehub-catalog-pack`).

## Canonical JSON

Every JSON file in a catalog tree, pack included, is exactly `JSON.stringify(value, null, 2) + '\n'`:
two-space indent, key order kept as written, one trailing newline, no tabs, no minified lines.
`packages/catalog/test/canonical-json.test.ts` fails and names the offending files. To rewrite
one: `node -e "const f=process.argv[1],fs=require('fs');fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,'utf8')),null,2)+'\n')" path/to/file.json`.
List order is data: new records go at the end of the list.

## Writing each type

See `references/record-types.md` for fields. The decisions that matter:

- **Body vs interface vs connector.** A *body* is the physical part and has no signal meaning;
  an *interface* assigns a vocabulary signal to each body position and lists every body it is
  found on (male and female share one); a *connector* is a body + interface pair with its
  orderable identity (`family`, `gender` must agree with the body). Pins are composed at load; do
  not list `pins` on a connector that names both. Reuse the starter's bodies (`de9-male`,
  `de9-female`) rather than redefining them: an id already used for something different is an
  install conflict.
- **Signals** come from the vocabulary (`vocab/signals.json`): every `signal` in an interface must
  exist there (`vocab-unknown` is an error). Add missing ones as entries of a pack's own
  `vocab/signals.json`, with `kind` (`data`, `control`, `audio`, `power`, `ground`, `none`, or a
  new kebab kind), `aliases` (the words people print on labels: the wizard and tag proposals read
  these), `returnFor` for a return signal, `standIn` only for a documented convention.
- **Wire stocks** are element trees (conductor, shield, insulation, group; SPEC.md "Wire
  structure"). Use `role` values `coax`, `shielded-core`, `twisted-pair`, `bundle`, `cable`. A shield
  and drain that touch along the whole length go in `bonded`. `colourCode` must name a
  `colour-codes` entry; `lane` on an element a `lanes` entry.
- **PCBAs are black boxes.** Declare terminals and `internalLinks`; a link with no `via` is plain
  copper, a link through a part names it in `via` (and `elements`, which must spell `via` exactly).
- **Designs** are physical joints (solder/crimp facts), not nets. `end` is required for wire
  segments and forbidden elsewhere. Every conductor end either lands or is explained by a design
  note that names the terminal. Use `schemaVersion` 4 for breakouts, else the current one in the
  examples (`packages/catalog/data/designs/`). Start from a working design and edit.
- **Do not hand-edit generated files**: `packages/catalog/data/tags/` (signal tags, instance slots, report) is built
  from the catalog by `packages/catalog/src/tags/build.ts` and checked by a test; `fixtures/v1/` is a
  frozen copy for snapshot tests (refresh deliberately, SPEC.md). Packs never ship tag tables: the
  host derives them.

## 6. Run the validators

1. Starter catalog edits: `pnpm --filter @wirehub/catalog test` (loads every design, runs
   `validateDb` / `validateDesign`, canonical JSON, tag tables), then
   `pnpm --filter @wirehub/model test`.
2. Pack edits: `node .agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs modules/<id>/pack`
   (validateDb + validateDesign over the starter with the pack laid over it, install into a copy,
   `src` on every record), then `pnpm --filter @wirehub/module-<id> exec vitest run --maxWorkers=2`.
3. Reading the output: errors fail; warnings (`missing-src`, `floating-conductor-end`,
   `screen-floating`, `vocab-unmatched`) are real and should be fixed or explained by a design note.
4. Last, `bash scripts/privacy-check.sh --tree`.

From code: `loadDb()` from `@wirehub/catalog` then `validateDb(db)` and
`validateDesign(design, db)` from `@wirehub/model`; both return `Issue[]` (`{ code, severity,
message, where }`) and never throw on bad data.
