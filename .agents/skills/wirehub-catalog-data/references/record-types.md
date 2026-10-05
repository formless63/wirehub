# Record fields by file

Authority: `SPEC.md` (Domain model) and the types in `packages/model/src/model.ts`,
`packages/model/src/interfaces.ts`, `packages/model/src/vocab.ts`,
`packages/model/src/kits.ts`. Examples to copy: `packages/catalog/data/*.json` and
`modules/pro-audio/pack/`.

Every record type below (and every vocabulary entry) may also carry the optional `license`,
`provenance` and `derivedFrom` fields (`packages/model/src/provenance.ts`; see `SKILL.md`,
"Licence and provenance fields"). Their checks: `record-license`, `record-provenance`,
`record-derived-from`.

## bodies.json (ConnectorBody)

`id`, `label`, `family` (a `families` entry id), `gender` (`genders` entry id), `positions`
(`{ id, kind?: 'pin' | 'shell' | 'key', note? }`, in the order a connector lists its pins),
`mates` (the opposite-gender body id; the validator checks both sides name each other),
`partNumber?`, `construction?` (`connector-constructions` entry, e.g. `solder-cup`), `drawing?`
(one of the layout package's built-in drawings, e.g. `d-sub`, `rca`), `housing?` (a crimp
housing, below), `src`.

## interfaces.json (Interface)

`id`, `label`, `short?`, `bodies` (every body it is found on), `pins` keyed by body position id:
`{ signal: <signals id> | { oneOf: [ids] }, dir?: 'out' | 'in' | 'bidir' | 'passive', label?,
aliases?, note?, confidence?, src? }`, optional `modes` (alternative pin maps selected by a
strap), `confidence?` (`net-verified | documented | inferred | unknown`), `note?`, `src`.
Checks: `interface-body-unknown`, `interface-position-unknown`, `vocab-unknown`.

## connectors.json (ConnectorRecord)

`id`, `label`, `family`, `gender?`, `body`, `interface`, `construction?`, `sourcing?`
(`connector-sourcing` entry), `aliases?`, `partNumber?` (leave out in packs), `housing?`
(overrides the body's), `src`. A record that
names `body` and `interface` has no `pins`. Checks: `connector-body-unknown`,
`connector-interface-unknown`, `connector-interface-body` (interface not on that body),
`connector-gender-mismatch`, plus warnings for part-number / construction mismatches and pins
that diverge from the interface.

## wires.json (WireDefinition)

`id`, `label`, `structure` (a `group` element with `role`), `odMm?`, `colourCode?`, `layOrder?`
(`{ arrangement, direction, ring[], center?, inner?, src }`; every member must be an element
path, and the ring length must match the arrangement), `bonded?`
(`{ members[], src }[]`, members are shields or bare conductors, each in at most one set),
`manufacturer?` (`manufacturers` entry), `specRef?`, `src`. Elements: `conductor`
(`color?, material?, areaMm2?, bare?, formation?`), `shield` (`construction`, `coveragePct?`),
`insulation` (`material?, odMm?, color?`), `group` (`role`, `children`). Checks:
`duplicate-sibling-element-id`, `missing-element-id`, `unknown-lay-order-element`,
`lay-order-arrangement-mismatch`, `bonded-member-not-screen`.

## components.json (ComponentDefinition)

`id`, `label`, `kind` (`component-kinds` entry), `terminals` (`{ id, label?, polarity? }`;
two-terminal passives use `a` and `b`, polarised parts `a` = `+`), `value?` (`"120 Ω"`),
`tolerance?`, `package?`, `category?`, `mpn?`, `manufacturer?`, `src`.

## mechanicals.json / kits.json

Mechanical: `id`, `label`, `kind` (`shell | fastener | other | contact | seal | plug | tool`),
`partNumber?`, `revision?`, `termination?`, `src`; no terminals.

**Crimp parts** (`packages/model/src/crimp.ts`). A `contact` (crimp terminal), `seal`
(single-wire seal), `plug` (cavity plug) or `tool` (hand tool or applicator) carries
`termination`: `systems?` (contact-system ids, free kebab strings shared with housings),
`housings?` (connector or body ids it fits outright), `wireMinMm2?`/`wireMaxMm2?` (contact),
`insulationMinMm?`/`insulationMaxMm?` (contact, seal), `gender?` (`male` pin / `female` socket),
`plating?`, `stripMm?`, `ratedCurrentA?` (per contact; the electrical rules prefer it to the connector's `contactRatingA`), `crimpHeights?` (`{ wireMm2, heightMm, widthMm? }[]`), `tool?` (a
mechanical id of kind `tool`), `tools?` (`{ tool, crimpHeights?, stripMm?, note? }[]`: further applicators with their own heights; a cavity's `tool` picks one), `src?`. Leave out every value no source states. A **crimp
housing** is a body's or connector's `housing`: `systems?`, `sealing?` (`none | per-wire |
mat`), `plugUnused?` (unused cavities take a plug), `cavities?` (pin ids; default every pin
but the shell), `src?`. Solder-cup and PCB connectors have no housing. Checks:
`termination-range`, `termination-tool-unknown` (errors), `termination-on-non-part`. Kit: `id`, `label`, `sku` (one token of letters, digits and `- . _ /`),
`contents` (`{ part: { kind, def }, qty, src }[]`, whole quantities, every part must exist), `src`.
Checks: `kit-sku-format`, `kit-empty`, `kit-part-unknown`, `kit-qty`.

## pcbas.json (PcbaDefinition)

`id`, `label`, `partNumber`, `revision`, `build?`, `terminals` (`{ id, label?, role?, signal?,
note?, pads? }`), `integratedConnectors?` (`{ connectorDefId, terminalPrefix }`, exposes
`<prefix>.<pin>` terminals), `internalLinks` (`{ from, to, via?, elements?, note? }`), `status?`, `src`.
Checks: `unknown-pcba-terminal`, `unknown-connector-def`, `link-elements-via-mismatch`.

## vocab/<list>.json (VocabList)

`{ id, label, src, entries }`; `id` equals the file name. Entry: `id`, `label`, `short?`,
`aliases?`, `deprecatedBy?`, `pending?`, `note?`, `src`. List-specific fields: `signals`
(`kind`, `returnFor?`, `near?`, `standIn?`), `lanes` (`signal?`), `pad-roles` (`lane?`),
`colour-codes` (`lanes`: colour to lane id). Starter lists: signals, levels, lanes,
colour-codes, pad-roles, families, genders, locations, materials, constructions, core-kinds,
colours, component-kinds, conditioning, sources, manufacturers, connector-constructions,
connector-mountings, connector-sourcing. Checks: `vocab-bad-id`, `duplicate-id`, `vocab-no-label`,
`missing-src`, `vocab-unknown` (a reference to an entry that does not exist),
`vocab-deprecated-by-unknown`, `vocab-bad-kind`. Lists are append-only: never remove an entry.
A pack's list of the same name is merged by entry id over the starter's.

## designs/<id>.json (CableDesign)

`schemaVersion`, `id` (= file name), `label` (`<source> → <destination>`), `instances`
(`connectors`, `segments`, `components`, `pcbas`, `mechanical?`, `breakouts?`; a connector
instance may carry `cavities?`: `{ pin, contact?, seal?, plug?, crimpHeightMm?, note? }[]`), `joints`
(`{ a, b, note? }`, refs `{ instance, terminal, end? }`), `notes?`, `extensions?`, `src`.
Common issue codes: `unknown-def`, `unknown-terminal`, `unknown-element-path`, `missing-end`,
`unexpected-end`, `self-joint`, `duplicate-instance-id`, `terminal-not-electrical`,
`floating-conductor-end` (warning), `screen-floating` (warning). Cavities: `cavity-unknown-pin`,
`cavity-duplicate`, `cavity-unknown-part`, `cavity-contact-and-plug` (errors); `contact-wire-range`,
`contact-insulation-range`, `seal-wire-range`, `cavity-part-housing`, `cavity-no-contact`,
`cavity-no-seal`, `cavity-unplugged`, `cavity-plug-on-used`, `cavity-contact-unused`,
`cavity-not-crimp` (warnings).

## devices.json (DeviceProfile)

`id`, `label`, `ports[]`, `src`; optional `kind` (kebab word), `manufacturer`, `model`, `extends`
(a parent device), `aliases[]`, `board` (an adapter: a PCBA id), `status`, `note`, and the
licence and provenance fields. A port: `id`; `label?`; `interface?` (an interface id); `body?` (the
device's jack, a body id) or `gender?`; `role?` (`source`, `sink`, `both`); `pins?` (position id to
`"nc"` or `{ signal, dir?, level?, accepts?[], needs?[], confidence?, note?, src? }`); `requires?[]`
(`{ id, conditioning, positions[1..2], text?, src }`); `terminals?` (adapters: the board's prefix,
or `""` for pads). Checks (`deviceLibraryIssues`): kebab and unique ids, `extends` known and not
looping, interface, body, board and vocabulary ids known, positions the interface has, an open
`{ oneOf }` pin bound (warning), `src` (warning).

## conditioning-recipes.json (ConditioningRecipe)

`id`, `label`, `conditioning` (vocabulary `conditioning`), `parts[]`, `src`; optional `from` and `to`
(`{ signal?, kind?, level? }`), `location` (vocabulary `locations`), `bidirectional`, `note`. A part:
`placement` (`series`, `shunt`, `across`) and `component` (a component id) or `kind` with `value`.

## hazards.json (HazardRule)

`id`, `label`, `severity` (`reject`, `warning`), `a` and `b` (patterns: `kinds`, `notKinds`, `signals`,
`notSignals`, `dirs`, `levels`), `text` (`{a}` and `{b}` stand for the two pins), `src`; optional
`relation` (`same-signal`, `different-signal`, `different-level`) and `enabled` (`false` switches a
built-in or a pack's hazard of the same id off).

## resolver-policy.json (ResolverPolicy)

One object: `order[]` of `missing`, `hazards`, `unverified`, `boards`, `prefer-boards`, `parts`,
`conductors`, `straight`; optional `maxOptions`, `screens` (`both` or `source`); `src`.
