---
name: wirehub-catalog-data
description: Author or edit WireHub catalog records by hand - connector bodies, interfaces (pinouts), connectors, wire stocks, components, mechanicals, kits, PCBAs, vocabulary (signals, levels, lanes, families, colour codes), device profiles, conditioning recipes and hazards for the resolver, and example designs - with the right ids, required fields, src citations, CC0 licensing and canonical JSON, then run the validators. Load when adding or correcting any JSON under packages/catalog/data or a module's pack/.
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
| validation rule | `validation-rules.json` (array) | `id`, `severity`, `each`, `require`, `message`, `src` (below) |
| numbering scheme | `part-numbers.json` (one object) | the prefix config, or a declarative definition (below) |
| device profile | `devices.json` | `id`, `label`, `ports[]` (each `id` and an `interface` or `pins`), `src` (below) |
| conditioning recipe | `conditioning-recipes.json` | `id`, `label`, `conditioning`, `parts[]` (each a `placement`), `src` |
| hazard | `hazards.json` | `id`, `label`, `severity`, `a`, `b`, `text`, `src` |
| ranking policy | `resolver-policy.json` (one object) | `order[]` of criteria, `src` |

Any definition may also carry an optional `cost` (`unit`, `currency`, `per`, `breaks[]`, `moq`; a price
per piece, or per metre for a wire stock). Pack data does not need prices; see `docs/interop.md`.
Many records at once can come from a CSV through the Library's **Bulk CSV…** (`modules/csv-library`: a
`src` on every row, a template per kind, one change set on publish).

Only `connectors.json`, `wires.json` and `components.json` must exist; the rest are optional.
**Rules and numbering are data too.** Declarative design rules are records of `validation-rules.json`
(`docs/validation-rules.md`; a pack may ship the file) and a numbering scheme is `part-numbers.json`
(`docs/part-numbers.md`). Rules that need code stay module code (`validationRules`, see
`wirehub-module`); a shop's own private rule data was deliberately left out of the base
(`docs/boundaries.md`).

A rule record, for example (a rule cites its `src` like any record; no shop names):

```json
{ "id": "dsub-boot", "severity": "warning", "each": "connector",
  "where": { "eq": [{ "path": "family" }, "d-sub"] },
  "require": { "contains": [{ "path": "mechanicalKinds" }, "boot"] },
  "message": "{id} has no strain-relief boot", "src": "synthetic example" }
```

`each` is `design`, `connector`, `segment`, `conductor`, `component`, `pcba`, `mechanical`,
`signal-path` or a library subject (`connector-def` …); a condition has exactly one key (`all`,
`any`, `not`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `startsWith`, `endsWith`,
`exists`, `empty`, `some`, `every`, `none`); a missing value makes a comparison false. Rule ids are
kebab-case, the issue code is `rule:<id>`. Check a rule with `ruleProblems` / `ruleListProblems`
(`@wirehub/model`) and run it: `validateDesign(design, { ...db, validationRules: [rule] })`.
A design may carry `tags` (`["shielded"]`) for a rule's `where` to select by; a mechanical may be of
kind `boot`.

A numbering scheme in `part-numbers.json` is either `{ prefixes, digits?, separator?, … }` or
`{ "type": "declarative", "template": "{level}{type}-{seq}-{variant}", "segments": [ … ],
"validation"?, "immutable"? }` (segments `choice`, `counter`, `variant`; allowed values per record
kind, counters per combination with ranges). Check one with `declarativeSchemeProblems`. The starter
and bundled packs carry no shop numbering, so do not add a `part-numbers.json` to a pack: a pack
**offers** a scheme in its manifest (`wirehub-catalog-pack`).

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
  number**; a deployment numbers records through its `PartNumberScheme` (usually a declarative
  definition in Settings, `docs/part-numbers.md`). Use `mpn` and
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
- Pin assignments and dimensions are facts: cite the standard. For the bundled CC0 packs, do not
  copy a standard's text, tables or figures; your own pack's sourcing and licence are your call
  (`wirehub-import-public-data`).

## Licence and provenance fields

Beside `src`, any record (and vocabulary entry) may carry three optional fields, defined in
`packages/model/src/provenance.ts` and checked by `validateDb` (`record-license`,
`record-provenance`, `record-derived-from` errors; the studio's definition routes refuse a bad one):

```json
"license": "CC0-1.0",
"provenance": { "method": "transcribed", "sources": [{ "title": "TIA-574 clause 4", "url": "https://...", "retrieved": "2026-09-30" }], "reviewed": [{ "by": "someone", "on": "2026-10-01" }] },
"derivedFrom": { "pack": "pc-serial", "id": "de9-rs232-dte", "version": "0.1.0" }
```

- `license`: an SPDX expression (`CC0-1.0`, `CC-BY-4.0`, `LicenseRef-...`); absent means the pack's
  (or the catalog's, CC0-1.0).
- `provenance.method`: `transcribed`, `derived`, `measured`, `generated` or `synthetic`;
  `sources` is non-empty, each with a `title` (citation) and/or an `http(s)` `url`.
- `derivedFrom` is written by the studio's **fork to edit** action on a record that came from a
  pack; do not write it by hand into a pack.
- Bundled pack records carry `license` and `provenance` drawn from their `src`; starter records
  may omit them. Keep `src`: it stays the mandatory one-line citation.

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
- **Crimp contacts, seals, plugs and tools** are mechanicals (`kind` `contact`, `seal`, `plug`,
  `tool`) with a `termination` block: the contact systems they belong to, the wire range in mm²
  and insulation Ø in mm, plating, strip length, crimp heights per wire size, and the tool. The
  housing they go into says the same systems in its body's (or connector's) `housing`, with its
  sealing and whether unused cavities are plugged. A design picks them per cavity
  (`cavities` on the connector instance); the BOM counts them per cavity, a tool never. Cite the
  datasheet the ranges come from; values typical of a class rather than one part are flagged as
  inferred. Example: `modules/automotive/pack/mechanicals.json` and its sealed 3-way housings.
- **PCBAs are black boxes.** Declare terminals and `internalLinks`; a link with no `via` is plain
  copper, a link through a part names it in `via` (and `elements`, which must spell `via` exactly).
- **Designs** are physical joints (solder/crimp facts), not nets. `end` is required for wire
  segments and forbidden elsewhere. Every conductor end either lands or is explained by a design
  note that names the terminal. Use `schemaVersion` 4 for breakouts, else the current one in the
  examples (`packages/catalog/data/designs/`). Start from a working design and edit.
- **Sub-assemblies** (a design placed in another, SPEC.md "Sub-assemblies"): list them in
  `instances.subassemblies` as `{ id, def: <design id>, rev?: <saved version>, role?, label?, note? }`
  and write the design at `schemaVersion` 5. The placed design's free ends are its ports: every
  connector pin (`j1:3`) and each conductor of a wire end nothing is soldered to (`w1@b:red`, a
  flying lead); joints land on them as `{ instance: <sub id>, terminal: <port id> }`, never with an
  `end`. A design made to be placed with flying leads names them in a design note
  (`w1:red@b and w1:black@b are left free …`) so its own floating-end warnings are explained. Place
  only designs of the same catalog or pack, never one that places the design back (a cycle). Example:
  `packages/catalog/data/designs/dc-y-from-leads.json` placing `dc-pigtail-lead.json` twice.
- **Devices and recipes** (the resolver, `docs/resolver.md`). A device profile names a port's
  `interface` and the device's own jack (`body`, or `gender`): the cable's plug is the connector of
  that interface on the mating body, so the pinout and the plug must exist. Per position, `pins`
  states what the device does: `signal`, `dir` as the device sees it (`out`, `in`, `bidir`,
  `passive`), `level` (vocabulary `levels`), `accepts`, `needs` (vocabulary `conditioning`), and
  `"nc"` for an open position; cite each from the standard or datasheet that says it, and say
  `confidence: "inferred"` where you reasoned it. A port's `requires` asks for a conditioning on one
  or two positions (a termination across a bus pair). A variant `extends` its parent and states
  only what differs. An adapter board is a device with `board` (a PCBA id), a mating port with
  `terminals` (the board's prefix) and a pads port with `terminals: ""`. In the vocabulary, give a
  transmit signal `pairsWith: ["<its receive>"]` and the two lines of a differential pair `diffPair`.
  A conditioning recipe names its `conditioning`, the level change it makes (`from` / `to`) when it
  is one, and its `parts`, each a component id (or a `kind` and `value`) with a `placement`
  (`series`, `shunt`, `across`); cite the arithmetic behind the values. Check them with
  `deviceLibraryIssues` (`validateDb` runs it) and try them: `resolve(db, { source: { device },
  destination: { device } })`, then `deriveCable` and `validateDesign` on the result. Examples:
  `modules/pc-serial/pack/devices.json`, `modules/pro-audio/pack/conditioning-recipes.json`.
- **Do not hand-edit generated files**: `packages/catalog/data/tags/` (signal tags, instance slots, report) is built
  from the catalog by `packages/catalog/src/tags/build.ts` and checked by a test; `fixtures/v1/` is a
  frozen copy for snapshot tests (refresh deliberately, SPEC.md). Packs never ship tag tables: the
  host derives them.

## 6. Run the validators

1. Starter catalog edits: `pnpm --filter @wirehub/catalog test` (loads every design, runs
   `validateDb` / `validateDesign`, canonical JSON, tag tables), then
   `pnpm --filter @wirehub/model test`. A design placing sub-assemblies is checked against the
   designs it places only when they are given: `validateDesign(design, withAssemblies(db, { working: loadDesigns() }))`.
2. Pack edits: `node .agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs modules/<id>/pack`
   (validateDb + validateDesign over the starter with the pack laid over it, install into a copy,
   `src` on every record), then `pnpm --filter @wirehub/module-<id> exec vitest run --maxWorkers=2`.
3. Reading the output: errors fail; warnings (`missing-src`, `floating-conductor-end`,
   `screen-floating`, `vocab-unmatched`) are real and should be fixed or explained by a design note.
4. Last, `bash scripts/privacy-check.sh --tree`.

From code: `loadDb()` from `@wirehub/catalog` then `validateDb(db)` and
`validateDesign(design, db)` from `@wirehub/model`; both return `Issue[]` (`{ code, severity,
message, where }`) and never throw on bad data.
