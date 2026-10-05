# WireHub — Master Spec

Single source of truth for everyone building on this repository. Read this fully before
writing code or data. When this spec and another doc disagree, this spec wins; flag the
conflict rather than silently choosing.

## Mission

An **engineering tool for cable assemblies**: capture the cables a shop actually builds as
canonical, machine-readable definitions, from which wiring schematics, build sheets, BOMs,
continuity/test specifications and drawings derive. It documents cables as built; it is not
a generative configurator. It is also not WireViz: the model is hierarchical (cables contain
coax which contain conductors and shields), connectors are reusable library assets composed
of a physical body and a pinout, and PCBAs are first-class black boxes with declared internal
continuity.

This repository is the **open base**. What one shop needs and no other does — its ERP link,
importers for its own file layout, its branding — is a **module** (`docs/modules.md`); what one
shop knows (its devices, its numbering, its rules) is **data** a private pack or Settings supplies. Public catalog data is distributed as **catalog packs**
(`docs/catalog-store.md`). What was deliberately left out of the base is recorded in
`docs/boundaries.md`.

There is no 3D renderer for whole cable assemblies; cable documents are 2D. Parts in the
Library may show 3D models (KiCad's library, uploads), and wire stocks render parametrically
in 3D from their definitions.

## The one architectural rule

**The model owns truth.** `@wirehub/model` knows nothing about SVG, React Flow,
coordinates, databases or modules. Every downstream artifact (schematic, build sheet, BOM,
continuity spec, drawing, editor state) derives from the same serialized definition.
Renderers and editors may carry their own presentation metadata, but never inside the
electrical model. Module-owned data rides in `CableDesign.extensions` under the module's id;
the base never interprets it.

## Ground rules

- Library code is local and deterministic — no network calls, no `Date.now()`/randomness.
  Pure functions; loaders take data in and return typed results.
- Every catalog data record carries `"src"`: a short citation for where its values came from
  (a public standard, a datasheet, a measurement, or "synthetic example"). Inferred values
  are flagged in the src text.
- TypeScript strict everywhere; ESM (`"type": "module"`); packages export TS source
  (`main: ./src/index.ts`, `build` = `tsc --noEmit`). IDs are kebab-case strings.
- Zero runtime dependencies in `model`, `catalog` and `modules`. Dev deps pinned:
  typescript 7.0.2, vitest 4.1.10, @types/node 26.1.2. Node ≥ 24. pnpm workspaces.
- Part numbers go through a `PartNumberScheme` (below); no code hard-codes a numbering
  pattern.

## Repository layout

```
SPEC.md                         this file
packages/model/                 @wirehub/model — the canonical model: types, path
                                addressing, validation, nets, trace, bonds, breakouts,
                                part-number schemes, design edits, versions. Zero deps.
packages/catalog/               @wirehub/catalog — the file-backed catalog: loaders over a
  data/                         CatalogSource (filesystem or in-memory), the starter catalog,
  fixtures/v1/                  its frozen copy for snapshot tests, signal-tag builder,
  src/                          artwork (depiction) loading and import
packages/modules/               @wirehub/modules — the module registry (built-in and runtime)
packages/layout/                ELK layout of a design into a drawable graph
packages/render-svg/            deterministic SVG schematics and cross-sections
packages/docs/                  build sheet, BOM, continuity spec, drawing sheet, wire spec
packages/editor-react/          the React editor: canvas, library, wizard, inspectors
modules/                        bundled optional domain modules (pc-serial, networking,
                                pro-audio, av-video, automotive):
                                catalog packs + module objects, offered at first-run setup
apps/studio/                    the app: Vite SPA + Hono server (file store, auth, locks,
                                change history and restore, optional git export, module routes)
specs/                          per-epic build specs (storage seam, Postgres backend)
docs/                           boundaries, module system, catalog store, self-hosting
docker/, compose.yaml           the self-hosted stack in one file (app, PostgreSQL, Garage,
                                the bootstrap/migrate one-shots; profile `backup`:
                                restic through Backrest) — docs/self-hosting.md
site/                           the config generator, published to GitHub Pages
```

---

## Domain model (`packages/model`)

### Wire structure — hierarchical elements

A wire stock is a tree of **elements**. No special-casing of coax: a coax is simply a group
containing a conductor, a dielectric, a shield and a sheath.

```ts
type Element =
  | { kind: 'conductor'; id: string; label?: string; color?: string;
      material?: string; formation?: string;      // e.g. "OFC 7x0.12 mm"
      areaMm2?: number; bare?: boolean;           // bare=true for drain wires
      src?: string }
  | { kind: 'shield'; id: string; label?: string;
      construction: 'braid' | 'spiral' | 'foil' | 'tape';
      material?: string; coveragePct?: string; src?: string }
  | { kind: 'insulation'; id: string; label?: string;   // dielectric / sheath / jacket
      material?: string; odMm?: number; color?: string; src?: string }
  | { kind: 'group'; id: string; label?: string;
      role: 'coax' | 'shielded-core' | 'twisted-pair' | 'bundle' | 'cable';
      children: Element[]; src?: string }
```

- **Electrical elements** (things with terminals): `conductor` and `shield`. Insulation and
  groups have no terminals of their own.
- **Element paths** address elements within a wire definition: `pair-1.white`,
  `overall-shield`, `drain` — dot-joined child ids from the root group's children. Paths must
  resolve uniquely; ids must be unique among siblings.
- A **WireDefinition** is `{ id, label, partNumber?, structure: Element (root group), odMm?,
  bonded?, src }`. Lengths live on instances, not definitions.
- **Bonded sets** (`bonded?: { members: string[]; src }[]`): screens — shields and bare
  conductors (drains) — that touch for the whole length of the stock, so they are one copper
  mass (a foil and the drain laid against it, for example). A screen is in at most one set.
  A stock whose screens are all in one set is **fully bonded**.
- A wire **segment instance** in a design has two ends, `a` and `b`. A wire terminal is
  `(segment, elementPath, end)`. Convention throughout: **end `a` = source side, end `b` =
  destination side**.

Wire stocks can also be composed from a library of parts (conductors, insulations, shields,
jackets) by a **wire recipe** (`wire-recipe.ts`) that compiles to a `WireDefinition`; the
wire builder in the editor writes these.

### Connectors — bodies and interfaces

A connector is the composition of a **body** (the physical part: shell, positions, gender,
family — no signal meaning) and an **interface** (a named pinout: a signal per body
position). The same DE-9 male body carries an RS-232 pinout on one connector and a
PROFIBUS DP pinout on another.

```ts
interface ConnectorBody { id; label; family; gender; positions: { id; label?; … }[];
                          mates?: string; partNumber?; construction?; drawing?;
                          housing?: HousingSpec; src }   // housing: crimp cavities
interface Interface     { id; label; short?; bodies: string[];
                          pins: Record<string, { signal: string; … }>;
                          modes?: { id; label; selectedBy; pins }[]; src }
interface ConnectorDefinition {
  id: string; label: string; family: string; gender?: 'male' | 'female';
  body?: string; interface?: string;           // the composition; pins derive from both
  pins: { id: string; label: string; aliases?: string[]; note?: string }[];
  partNumber?: string; construction?: string; sourcing?: string; src: string;
}
```

Pin ids are strings (`"1"`…`"15"`, `"shell"`, `"tip"`, `"sleeve"`). Signals are vocab ids
(`vocab/signals.json`, extended by domain packs), which is what lets tags, trace and the continuity spec reason about
"which pin is ground".

### Discrete components

```ts
interface ComponentDefinition {
  id: string; label: string;
  kind: string;                      // vocab component-kinds: resistor, capacitor, led, …
  value?: string;                    // "120 Ω", "100 nF"
  partNumber?: string;
  terminals: { id: string; label?: string; polarity?: '+' | '-' }[];
  src: string;
}
```

Two-terminal passives use terminal ids `a` and `b` (polarized parts: `a` = `+`). The same
record kind is the library of the parts placed *on* PCBAs (optional `category`, `package`,
`mpn`, `manufacturer`, `suppliers`, `footprint`, `usedOn`). A PCBA stays a black box in a
cable BOM: one line for the populated board, never lines for its parts.

### PCBAs — black boxes with declared continuity

```ts
interface PcbaDefinition {
  id: string; label: string;
  partNumber: string; revision: string; build?: string;
  terminals: { id: string; label?: string; note?: string;
               pads?: { ref: string; side?: 'top' | 'bottom' | 'both'; role?: 'shell' }[] }[];
  // A PCBA sold pre-soldered to its connector exposes that connector's mating pins as
  // terminals with ids '<prefix>.<pin>' (e.g. 'de9.5'):
  integratedConnectors?: { connectorDefId: string; terminalPrefix: string }[];
  // Declared internal continuity — enough for end-to-end tracing without modelling the
  // electronics:
  internalLinks: { from: string; to: string; via?: string; note?: string }[];
  status?: 'active' | 'development' | 'legacy' | 'retired';   // absent = active
  src: string;
}
```

`via` is a human-readable annotation of what sits in the path (`"R1 120 Ω via JP1"`). A link
with no `via` is plain copper. Board **builds** (`builds.ts`) describe population variants and
jumper settings of one board revision.

### Mechanical parts and kits

A **mechanical** is a non-electrical physical part: a shell/housing/boot, a fastener, a mould,
heat-shrink, or a crimp termination part. `{ id, label, partNumber?, revision?, kind: 'shell' |
'fastener' | 'other' | 'contact' | 'seal' | 'plug' | 'tool', termination?, src }`.
It has **no terminals**, so it lives outside the joint/net/trace graph.

**Crimp terminations** (`crimp.ts`). A crimp housing — a body's or connector's `housing`
(`{ systems?, sealing?: 'none' | 'per-wire' | 'mat', plugUnused?, cavities?, src? }`; the
connector's wins) — has cavities (its pins, the shell excepted). Each takes a loose `contact`,
in a `per-wire` sealed housing a `seal`, and when unused in a housing that plugs them a
`plug`; a contact is crimped with a `tool`. Those four are mechanicals whose `termination`
says what they fit (`systems`, `housings`) and take (`wireMinMm2`/`wireMaxMm2`,
`insulationMinMm`/`insulationMaxMm`, `gender`, `plating`, `stripMm`, `ratedCurrentA`, `crimpHeights`, `tool`,
and `tools?: { tool, crimpHeights?, stripMm?, note? }[]` — further applicators, each with its own
heights). A design records them per cavity on the connector instance:
`cavities?: { pin, contact?, seal?, plug?, tool?, crimpHeightMm?, note? }[]` (`tool` picks the
applicator when the contact lists more than one; without it the contact's `tool` and table apply). Everything is optional:
a solder-cup or PCB connector has no housing, and a design with no cavities validates as
before. Validation: an unknown pin or part, a part of the wrong kind, a duplicate cavity or a
contact and a plug together are errors; the wire's total cross-section outside the contact's
range, insulation Ø outside the contact's or seal's, a part that fits another system, a
landed cavity with no contact (or, sealed, no seal), an unused cavity unplugged, and cavities
on a non-crimp connector are warnings. The BOM counts contacts, seals and plugs per cavity
(section "Contacts, seals & plugs"; a tool is never a line); the build sheet prints contact,
seal, strip length, crimp height and tool per cavity and lists the tools; `crimp-list.csv`
exports the same rows. A **kit** is an
orderable bundle of parts (`{ id, label, sku, contents: { part: { kind, def }, qty }[], src }`) —
a backshell with its jackscrews, say.

Every definition record may carry an optional `cost` (`{ unit, currency?, per?, breaks?, moq?, src? }`,
`docs/interop.md`, "Costing"), and a design an optional `labourMinutes`: additive fields that feed the
BOM's cost roll-up and change nothing else.

The electrical rules (`packages/model/src/electrical.ts`: conductor ampacity, contact rating, voltage
drop; warnings, silent without declared currents) read a pin's `currentA` or its signal's default
current. A design may state its own: `electrical: { currents: { "j1:3": 2.5 }, rules?: { ampacityDerate?,
contactDerate?, maxDropV?, maxDropPct?, enabled?, ampacity? } }`, keyed `instance:terminal`, which wins
over the library's figures for that net (so it can lower a load as well as raise it) and over the
organisation's thresholds. The built-in ampacity table is PowerStream's published "maximum amps for
chassis wiring" by AWG (a rule of thumb, not a standard; a stock's `ratedCurrentA` or a hub table replaces it).

### The design document

```ts
interface CableDesign {
  schemaVersion: 1 | 2 | 3 | 4 | 5;  // 2 = shield bonding (pigtails, pads); 4 = breakouts;
                                     // 5 = sub-assemblies; older versions still load unchanged
  id: string; label: string;         // label: "<source> → <destination>"
  productRef?: string;               // the product part number this design documents
  status?: 'active' | 'development' | 'legacy' | 'retired';   // absent = active
  instances: {
    connectors: { id: string; def: string; role?: string; note?: string;
                  cavities?: CavityAssignment[] }[];   // crimp contacts, seals, plugs
    segments:   { id: string; def: string; lengthMm?: number; role?: string;
                  pigtails?: Pigtail[];
                  scope?: string[] }[];  // only these elements of the stock (a breakout run)
    components: { id: string; def: string; location?: string; note?: string }[];
    pcbas:      { id: string; def: string; note?: string }[];
    mechanical?: { id: string; def: string; qty: number; attachedTo?: string; note?: string }[];
    breakouts?: Breakout[];          // schema v4
    subassemblies?: { id: string; def: string;   // another design, by id (schema v5)
                      rev?: number;              // pinned saved version; absent = working copy
                      role?: string; label?: string; note?: string }[];
  };
  joints: { a: TerminalRef; b: TerminalRef; note?: string }[];
  notes?: string[];                  // build-level annotations (drain policy etc.)
  extensions?: Record<string, unknown>;   // module-owned data, keyed by module id
  recipe?: CableRecipe;              // the devices it connects and the resolver's choices
  src: string;
}

type TerminalRef = {
  instance: string;                  // instance id from `instances`
  terminal: string;                  // pin id | element path | 'pigtail:<id>' | component terminal
  end?: 'a' | 'b';                   // REQUIRED for segments, FORBIDDEN otherwise
  pad?: string;                      // physical pad of a multi-pad PCBA terminal;
}                                    //   NOT part of the terminal key — nets unchanged

// Screens of one segment, at one end, twisted together and landed once.
type Pigtail = {
  id: string;                        // kebab, unique per (segment, end)
  end: 'a' | 'b';
  members?: string[];                // screen paths; omitted = the whole mass of a fully bonded stock
  note?: string;
}
```

**Joints are physical solder/crimp facts, not nets.** A three-way joint (shield + drain
twisted onto one ground pad) is two joints sharing a terminal. Nets are derived.

**Shield bonding.** A pigtail is a terminal of its segment, `pigtail:<id>` at its end, and
its landing is an ordinary joint — joints stay the only solder facts. A PCBA terminal may
declare the physical pads behind it, and a landing may name its pad.

**Breakouts** (`breakouts.ts`). A breakout is a point along the cable — a mould or overmould
— where one segment end (the trunk) meets the ends of its legs.

```ts
type Breakout = {
  id: string;
  mould?: string;                    // a `mechanical` instance id
  trunk: { segment: string; end: 'a' | 'b' };
  legs: { segment: string; end: 'a' | 'b' }[];
  housed?: string[];                 // instances inside the mould (a jack inset in it)
  conductors: { segment: string; path: string;
                fate: 'through' | 'terminated' | 'nc';
                leg?: string;        // through: the leg it continues on
                reason?: string }[]; // nc: why
};
```

Every conductor and screen (in scope) of the trunk end and of each leg end is accounted for
exactly once. **Through**: the same physical conductor continues uncut on a leg of the same
stock — continuous copper, no joint. **Terminated**: it ends in the mould, soldered there.
**NC**: cut back in the mould, with a reason. A design carrying breakouts is schema v4.

**Sub-assemblies** (`subassemblies.ts`). A design may place other designs: a harness made of
cables, a Y made of two leads. A sub-assembly instance names the design (`def`) and, optionally, a
saved version (`rev`); absent, it follows the working copy, and **saving a version pins every
unpinned sub-assembly to that design's released revision** (approved when approvals are on, else
the latest saved) — a version always names the same parts, and is refused when a placed design has
nothing released. The placed design's unconnected ends are its **ports**: every connector pin
(including a board's integrated connector), each conductor and screen of a wire end nothing is
soldered to and that is in no breakout and twists no pigtail (a **flying lead**), and the free ports
of its own sub-assemblies. A port is a terminal of the instance named `<instance>:<terminal>` or
`<segment>@<end>:<path>` (`j1:3`, `w1@b:red`, nested `lead-1:j2:1`); the parent's joints land on
them like any terminal (no `end`). A design placing any is schema v5 (`schemaVersionFor`; a design
without stays at 4, so existing designs are unchanged).

The placed designs come from `Db.assemblies` (`{ working: CableDesign[]; versions?: { designId,
rev, released, design?, definitions? }[] }`), which the host fills for the design at hand; without
it references are not checked and ports resolve unverified (a frozen version validates against its
own definitions alone). `flattenSubassemblies` undoes the hierarchy: every placed part re-identified
`<sub>/<id>` (`lead-1/j1`), the parent's joints moved from the ports onto what they stand for, a
pinned version's frozen definition carried under `<id>@<design>.<rev>` where it differs from the
live one. Nets, trace (`port` edges tie each port to its flat terminal), the continuity spec and the
schematic run on it. Validation: an unknown design, an unknown or unparseable revision and a cycle
(a design placing itself, directly or not) are errors, and so is a joint to a port the placed design
does not expose (`subassembly-unknown-port`: it changed, or that end is connected inside it); a pin
to an unreleased revision, a newer released revision and a schema number below 5 are warnings. A
port profiles for the compatibility rules as the terminal it is inside the placed design.

The BOM lists each sub-assembly as **one line** (category `subassembly`, section
"Sub-assemblies") by the placed design's `productRef` and revision, its cost the placed design's own
roll-up; `explode` lists the placed parts instead. The build sheet references each sub-assembly's
own build sheet and lists what lands on its ports, never inlining it. "Where used" for a design
(`subassemblyParents`, `GET /api/designs/:id/used-in`) names the designs and saved versions placing
it; deleting or renaming such a design is refused, naming them; on Postgres each placing is a
`ref_edge` (role `subassembly`).

**Extensions.** `extensions` is an object keyed by module id; each value is that module's own
JSON. The base validates only its shape (`invalid-extensions`), keeps it through edits,
versions and serialization, and never reads it.

### Derived views

- `resolveTerminal(design, db, ref)` — validates and resolves a TerminalRef; the foundation
  everything else uses.
- `validateDesign(design, db): Issue[]` — structural validation returning typed issues
  (`{ code, severity: 'error' | 'warning', message, where }`), never throwing on bad data.
  Errors: unknown def/instance refs, bad element paths, terminal refs to non-electrical
  elements, `end` present/absent wrongly, duplicate instance ids, self-joints, pigtail and
  breakout rule violations. Warnings: conductor ends connected at one end and floating at
  the other **unless** a design note references that terminal; screens likewise
  (`screen-floating`), where a screen counts as landed when it has a joint there, is in a
  landed pigtail there, or is bonded to a landed member. Modules may add rules
  (`docs/modules.md`); their codes are prefixed `<module>/`.
- `deriveNets(design, db): Net[]` — union-find over joints, bonds, conductors passing
  through a breakout, and PCBA internal links without `via`. Components and `via` links are
  net boundaries (a net is continuous copper). A design placing sub-assemblies is flattened
  first (`flattenSubassemblies`), its ports tied to what they are.
- `trace(design, db, from)` — walks outward through joints, plain links, two-terminal
  components (annotating each passage) and `via` links; returns reachable terminals with the
  ordered list of things passed through. The continuity spec derives from it.
- `validateDb(db)`: duplicate ids, bad element trees, PCBA links or integrated-connector
  prefixes referencing unknown terminals/defs, bonded members that are not screens, missing
  `src` (warning).
- Serialization is plain JSON of the types above — no classes, no Maps in the model.

`Db` is the bundle `{ connectors, wires, components, pcbas, mechanicals?, bodies?,
interfaces?, kits?, vocab?, tags?, validationRules?, devices?, conditioningRecipes?, hazards?,
resolverPolicy? }` the catalog loads, plus — given by the host,
for a design placing sub-assemblies — `assemblies?` (the designs those reach). A design may carry
free `tags?: string[]` that declarative validation rules select by.

### Part numbers — a pluggable scheme

```ts
interface PartNumberScheme {
  id: string; label: string;
  parse(text: string): string | undefined;          // canonical form, or not one of ours
  check(pn: string, kind?: PnKind): PnIssue[];      // warnings only
  suggest(subject: PnSubject, known: readonly KnownPartNumber[]): PnSuggestion | undefined;
  shape?: string;       // the layout in words, for messages and forms
  immutable?: boolean;  // existing numbers never change: a saved number cannot be edited into another
}
```

The built-in **prefix scheme** numbers each kind with a prefix and a zero-padded counter:
`CON-00001` connectors, `CMP-` components, `WIR-` wires, `PCA-` populated boards, `PCB-` bare
boards, `SHL-` shells, `HW-` fasteners, `MEC-` other mechanicals, `KIT-` kits, `CBL-` cable
designs; a drawing may name a length family `CBL-00010-XX` whose variations are
`CBL-00010-03`, `-05`, …. A catalog configures it with an optional `part-numbers.json`
(`{ id?, label?, prefixes, digits?, separator?, allowRevisionSuffix? }`) — or with a
**declarative scheme** (`"type": "declarative"`; `pn-declarative.ts`, `docs/part-numbers.md`): a
template of segments (`<Level><Type>-NNNNNN-VV`), allowed values per record kind, zero-padded
counters per combination of segments with ranges, a variant suffix, separators, a validation
regex and `immutable` ("existing numbers never change"), edited in Settings and offered by a data
pack's manifest (`partNumberScheme`; installing never switches it, an owner confirms). A module may
register a code scheme for what data cannot say. A suggestion is a proposal — nothing writes a
number without a person accepting it.

### Validation rules as data

`validateDesign` and `validateDb` also run the **declarative rules** in `Db.validationRules`
(`validation-rules.json`, an array of rule records a data pack may ship; `rules.ts`,
`docs/validation-rules.md`): a bounded JSON condition language (`all`, `any`, `not`, comparisons,
`contains`, `some`/`every`/`none` over lists, counts) over a design and its library records, with a
subject (`connector`, `conductor`, `signal-path`, `connector-def` …), a severity and a message
template. No code runs: evaluation is bounded (depth, node count, a step budget). Their issues
carry the code `rule:<id>`. Code rules in a module remain for the complex cases.

### Devices and the resolver

"Which cable do I need?" (`devices.ts`, `resolve.ts`, `derive-cable.ts`, `cable-recipe.ts`;
`docs/resolver.md`). **Device profiles** (`devices.json`) are what cables plug into: ports, each
an interface on the device's jack (a body, or a gender), with per-position facts laid over the
interface — signal, direction, level, what the cable must add (`needs`), confidence — and port
requirements (a termination across a pair). A variant `extends` its parent. A device with a
`board` is an **adapter**: one port mates a device, the other is its cable pads.
**Conditioning recipes** (`conditioning-recipes.json`) say what a conditioning takes: a level
conversion (`from` → `to`) or a requirement, as components in `series`, `shunt` or `across`.
**Hazards** (`hazards.json`, over built-in ones) are patterns over the two pins of a connection,
`reject` or `warning`. The **ranking policy** (`resolver-policy.json`) orders the criteria.
Signals pair through the vocabulary: `pairsWith` (transmit onto receive) and `diffPair`.

`resolve(db, { source, destination })` lists every option — wired by signal (direct, or
conditioned by recipes), straight pin for pin, or through adapter boards — ranked, each with
reasons, hazards, missing pieces and unconfirmed facts; options a reject hazard matches are
refused with why. `deriveCable` turns one into a design (plugs, a suggested stock, joints, the
recipes' parts, status `development`) that carries `recipe: { source, destination, option, stock,
lengthMm, ids?, overrides? }`. `validateDesign` checks a design against its recipe (`recipe-drift`
and kin, warnings); `inferCableRecipe` finds the recipe of a hand design; `rederive` rebuilds one.
All of it is data a pack ships; the engine knows no field's devices.

### Event webhooks

Integrations are configuration, not code: owners subscribe URLs to events (design saved, version
submitted / approved / released, part number assigned, pack installed, job finished, catalog
changed) in Settings; each delivery is a `webhook` job carrying a versioned JSON payload
(`wirehub.event/1`: ids, links, the actor, a diff summary, fetch URLs) signed with HMAC-SHA256
under the subscription's secret (kept encrypted in the settings secrets store), retried with
backoff, logged and redeliverable. The receiver pulls full data through the API with a token
(`docs/webhooks.md`).

---

## Modules (`packages/modules`)

A module is a plain object contributing to fixed extension points — catalog packs,
importers, exporters / document types, a part-number scheme, validation rules, integrations
(server routes under `/api/modules/<id>/…`), UI panels and routes, auth providers, an editor
commit hook, and — for an optional **domain module** — a setup entry that first-run setup
(`/setup`) offers. The image's built-in modules are listed in `apps/studio/modules.config.ts`;
on top of them an owner installs **runtime code modules** from a store or a signed upload in the
UI (owner decision 2026-10-05: one public image for everyone), loaded into a live registry without
a rebuild, and Settings can restart WireHub when a change needs a fresh process
(`specs/runtime-modules.md`). `@wirehub/modules` is
MIT; modules that use only the module API may take any licence (`MODULE-EXCEPTION.md`).
Full design: `docs/modules.md`.

## The starter catalog (`packages/catalog/data`)

A small, generic catalog so a fresh install has something real to open. Every record cites
a public standard or says "synthetic example"; no value comes from any private source.
The data is **CC0-1.0** (`data/LICENSE`), like the bundled packs; the catalog's code is
AGPL-3.0-only with the module exception.

| Kind | Records |
| --- | --- |
| bodies (4) | DE-9 M/F, JST XH 2-pin, 4-way terminal block |
| interfaces (2) | DE-9 pins by number (no signals), DC 2-pin |
| connectors (4) | `de9-female` / `de9-male` (`CON-00012`, `CON-00013`, pins by number), `jst-xh-2-dc` (`CON-00010`), `terminal-block-4` (`CON-00011`) |
| wires (4) | Cat 5e U/UTP, 2-pair shielded 24 AWG (foil + drain), DC 2 × 24 AWG, a neutral multicore of 3 × mini-coax + 4 cores (foil + drain) |
| components (4) | 150 Ω and 120 Ω resistors, 100 nF capacitor, red 5 mm LED |
| mechanicals (6), kits (1) | DE-9 backshell, 4-40 jackscrews, moulded Y body, heat-shrink, an XH-series crimp socket contact and its hand crimp tool; a backshell kit |
| PCBAs (1) | `pair-terminal-board`: cable pads to a 4-way terminal block with a jumper-selected 120 Ω termination across one pair |
| designs (6) | `de9-crossover` (2 ↔ 3 crossed, loopbacks, a pigtail), `de9-terminal-board` (board + termination), `dc-led-lead` (inline resistor; a length-family drawing; crimp contacts in the JST XH housing), `dc-y-splitter` (breakout), `dc-pigtail-lead` (a JST XH lead with flying leads, made to be placed) and `dc-y-from-leads` (a Y built from two of them as sub-assemblies, schema v5) |
| vocab (19 lists) | signals (power, ground and the none kinds only — **no domain**), levels, lanes, colour codes, pad roles, families, genders, locations, materials, constructions, core kinds, colours, component kinds, conditioning, sources, manufacturers, connector constructions / mountings / sourcing |

**Domain modules** (`modules/`, `docs/modules.md`) bring the vocabulary and records of one
field as catalog packs laid over the starter, installed at first-run setup when a person
picks them: `pc-serial` (RS-232, RS-485 and USB signals and pinouts, a null modem, an RS-485
board cable, a USB LED lead), `networking` (Ethernet MDI signals, RJ45 plugs wired T568A and
T568B, a patch cable and a crossover), `pro-audio` (audio signals, XLR, RCA and TRS, audio
stocks, a microphone cable and a Y lead) — these three suggested at setup — and
`av-video` (video signals, VGA and SCART, a VGA cable) and `automotive` (bus signals, the
OBD-II plug, a generic sealed 3-way connector family with its crimp contacts, seals, cavity
plug and crimp tool, and a sealed sensor lead). `pc-serial`, `pro-audio` and `automotive` also
ship device profiles and conditioning recipes for the resolver (a PC port to an RS-485 device
through a converter board, a line output into a microphone input through a pad, a control unit
to sensors of two pinouts). Pack data is CC0-1.0 and every record keeps its `src`; pack records carry no
part numbers. The base code knows no domain's signals: label reading goes through the
vocabulary (`signal-words.ts`), and signal kinds are open strings.

`fixtures/v1/data` is a frozen copy the snapshot tests render from; refresh it deliberately
(`cp -rf data/. fixtures/v1/data/`) and regenerate goldens when the starter catalog changes.
The signal-tag tables (`data/tags/`) are generated from the catalog by the tag builder and
checked by a test.

Only `connectors.json`, `wires.json` and `components.json` are required; every other file is
optional, so an empty catalog is three `[]` files.

## Tests

vitest per package; `pnpm test` runs each workspace in turn. Every design in the starter
catalog validates with zero errors; nets, trace, bonds, breakouts, part numbers, the module
registry, layouts, SVG goldens, documents and the app's API and browser paths are covered.
Tests that need data use the starter or fixture catalog, never a private one; a domain's
cases live in its module's tests, over the starter plus that module's pack.

## Verification bar

- `pnpm -r build` green (tsc --noEmit, strict), `pnpm test` green.
- `bash scripts/privacy-check.sh --tree` clean (with the local private-terms file where one exists).
- Every catalog value traceable to its cited source; anything inferred is flagged in `src`.

## Phase plan

1. **Done in the base**: the model, the file-backed catalog, layout and SVG, documents, the
   editor and the app with login, edit locks, versions and the optional git export; the
   module registry skeleton; the pluggable part-number scheme; the starter catalog. Since
   the rename to WireHub: vocabulary-driven signal reading, the pc-serial, networking,
   pro-audio, av-video and automotive domain modules (the starter now generic), first-run
   setup (`/setup`), pack layering and install in the file backend, the compose stack with
   Garage blob storage and the backup add-on.
2. **Postgres backend** (`specs/postgres-backend.md`, `specs/storage-seam.md`): a database
   and blob store behind the storage seam, a write path with batch / dry-run API tokens and a
   worker, and a clean self-hosted install (`docker compose up`, first-run setup).
3. **Module system, wired through**: module panels, routes, importers and exporters
   mounted in the editor and server; a first example module.
4. **Catalog store** (`docs/catalog-store.md`): pack format, install/update, provenance and
   licence per record, signing.
5. **More generic coverage**: connector art for the families that draw as generic
   rectangles today (RJ45, XLR, USB, JST, terminal block), re-covered tests for what the
   private suite tested on private data, generic specs for the drawing language.
6. **Generic engines once left private** (owner 2026-10-05: only proprietary data stays
   private): the device resolver and recipes (`docs/resolver.md`), products and variants, part
   revisions and compare — engines in the base, the data in packs.
