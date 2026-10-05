# The device resolver: "Which cable do I need?"

Give WireHub two devices and the ports a cable joins, and it lists every way to connect them,
ranked, each with its reasons, hazards and missing pieces. Pick one and it derives a design: the
plugs, a wire stock, the joints and the conditioning parts. The design remembers the choices (its
**recipe**), so a later library change can re-derive it and a hand edit shows up as **drift**.

The engine is generic and lives in the base (`@wirehub/model`: `devices.ts`, `resolve.ts`,
`derive-cable.ts`, `cable-recipe.ts`). What it knows about devices is **data**: device profiles,
conditioning recipes, hazards and a ranking policy, in the catalog or in a pack. Nothing about one
field (serial, audio, video, automotive) is in the code; the bundled domain packs carry examples.

## The data

Four optional catalog files, each a pack may ship (array files merge by id, a hub's own record
shadows a pack's):

| File | Holds |
| --- | --- |
| `devices.json` | device profiles: what cables plug into |
| `conditioning-recipes.json` | the parts a level change, a termination or another conditioning takes |
| `hazards.json` | connections to refuse or warn about, over the built-in ones |
| `resolver-policy.json` | one object: the order options are ranked in |

They are validated with the library (`validateDb` runs `deviceLibraryIssues`): an unknown
interface, body, board, component or vocabulary id is an error, a missing `src` a warning.

### Devices

```json
{
  "id": "desktop-pc", "label": "Desktop PC with a serial port", "kind": "computer",
  "ports": [{
    "id": "com1", "label": "COM1 (DE-9 male)", "interface": "rs232-dte", "body": "de9-male", "role": "both",
    "pins": { "3": { "signal": "rs232-txd", "dir": "out", "level": "rs232", "src": "TIA-574" },
              "2": { "signal": "rs232-rxd", "dir": "in", "level": "rs232", "src": "TIA-574" } }
  }],
  "src": "TIA-574 DTE on DE-9 male; synthetic example"
}
```

- A **port** carries an `interface` (a pinout, `interfaces.json`) on the device's own jack: a
  `body`, or just a `gender`. The cable's plug is the connector with the same interface on the body
  that mates the jack (`mates`), or of the other gender.
- `pins` lays per-position facts over the interface: the `signal` (vocabulary), the direction as
  the device sees it (`out`, `in`, `bidir`, `passive`), the `level` it drives or expects
  (vocabulary `levels`), further levels an input `accepts`, the conditioning the cable must add on
  that line whatever the far end is (`needs`), a `confidence`, and `src`. `"nc"` means the device
  leaves the position open. An interface's open pin (`{ oneOf }`) must be bound by the device.
- `requires` lists what the port needs from any cable beyond pairing its pins: a `conditioning`
  (vocabulary) on one or two `positions` — a termination across a bus pair, a pull-up.
- `extends` makes a variant: a regional or revision model states only what differs, its ports
  merged by id over the parent's.
- An **adapter board** is a device with `board` (a PCBA id). One port mates a device (`terminals`:
  the board's footprint or integrated-connector prefix, `j1` makes position 3 the terminal `j1.3`)
  and the other is the cable pads (`terminals: ""`, the positions are the pad ids). The pads port
  states what the board puts on each pad, so the resolver pairs it like any port.

### Signal pairing in the vocabulary

Two optional fields on a `signals` entry tell the resolver how lines meet:

- `pairsWith`: the signals this one lands on at the far device — a transmit onto a receive
  (`rs232-txd` → `rs232-rxd`). Read both ways.
- `diffPair`: the other line of a differential pair (`rs485-a` ↔ `rs485-b`); a derived cable gives
  the two one twisted pair when its stock has one.

### Conditioning recipes

```json
{
  "id": "line-to-mic-pad-40db", "label": "Line-to-mic pad, about −40 dB", "conditioning": "attenuation",
  "from": { "kind": "audio", "level": "line" }, "to": { "level": "mic" },
  "parts": [{ "component": "r-6k8", "placement": "series" }, { "component": "r-68", "placement": "shunt" }],
  "location": "dest-head",
  "src": "voltage divider per leg: 2 × 68 Ω / (2 × 6.8 kΩ + 2 × 68 Ω) ≈ −40 dB; synthetic example"
}
```

- `conditioning` names what the recipe realises (vocabulary `conditioning`); a pin's `needs` and a
  port's `requires` are matched against it.
- `from` / `to` make it a level conversion: a line whose driver is at `from.level` and whose
  receiver takes `to.level`. `from.signal` or `from.kind` narrow which lines it takes.
- `parts` are components by record id, or by `kind` and `value` (the first library record of that
  kind whose value reads the same). `series` sits in the line, `shunt` from the line to that end's
  ground (or chassis), `across` between the two positions of a requirement.
- `location` (vocabulary `locations`) is where the parts go; absent, at the receiving end.
- `bidirectional: true` lets a bus line (both ends `bidir`) take it.

### Hazards

A hazard is a pattern over the two pins of a connection, matched both ways round:

```json
{ "id": "no-12v-on-data", "label": "12 V never onto data", "severity": "reject",
  "a": { "signals": ["pwr-12v"] }, "b": { "kinds": ["data"] },
  "text": "{a} must never meet {b}", "src": "synthetic example" }
```

A pattern may test `kinds` / `notKinds` (signal kinds), `signals` / `notSignals`, `dirs` and
`levels`; `relation` adds `same-signal`, `different-signal` or `different-level`. A `reject` hazard
refuses every option that makes the connection (listed with the reason); a `warning` one is shown
on the option. The built-in hazards (`BUILT_IN_HAZARDS`): `power-into-signal`, `power-into-ground`,
`power-mismatch` and `output-contention` (reject), `parallel-supplies` (warning). A hazard of the
same id replaces a built-in; `"enabled": false` switches it off.

### The ranking policy

```json
{ "order": ["missing", "hazards", "unverified", "boards", "parts", "conductors"], "maxOptions": 12, "screens": "both", "src": "…" }
```

Criteria, lowest first: `missing` (fewest missing pieces), `hazards` (fewest warnings),
`unverified` (fewest unconfirmed facts), `boards` (plain wire first) or `prefer-boards`, `parts`,
`conductors`, `straight` (a pin-for-pin cable first). `screens`: where both ends have a chassis pin,
land the screen at `both` ends (the default) or at the `source` end only. Absent, the default above.

## What the resolver does

`resolve(db, { source: { device, port? }, destination: { device, port? } })` binds both ports, then
builds options:

- **Wired by signal** (`direct`, or `conditioned` when recipes are on it): each destination pin is
  fed by a free source pin carrying the same signal (an output onto an input, a bus line onto a bus
  line) or a signal the vocabulary pairs with it; supplies go to the inputs that need the same rail
  (a recipe may convert one rail to another); grounds share one return conductor; chassis pins take
  the screen. A line whose driver level the receiver does not take gets a converting recipe, or is a
  missing piece. A pin's `needs` and a port's `requires` get their recipes. Alternatives (two
  recipes for one conversion) become separate options.
- **Straight** (pin for pin), when both ports have the same positions and the pairing is not
  already pin for pin: an off-the-shelf cable. Usually refused, and the reason is the point: "a
  straight DE-9 cable would join the device's +5 V to the PC's DSR".
- **Through a board**: every adapter whose mating port carries the port's interface, at the source
  end, the destination end, or both. The mating side is checked pin for pin like a plug; the pads
  are paired with the far end by signal.

Missing pieces: an input nothing drives (a `control` input — a handshake — is only noted), a bus
line nothing carries, no signal paired at all, a supply the other end does not offer, a level
nothing converts, a requirement no recipe meets, no return. Facts with `confidence` `inferred` or
`unknown` are listed as unconfirmed. Options that a `reject` hazard matches are refused, with why;
nothing valid is dropped for ranking lower (past `maxOptions` they are counted).

## Deriving a design

`deriveCable(db, query, optionId?, { stock?, lengthMm?, id?, label? })` makes a `CableDesign`
(status `development`):

- **plugs**: `j1` and `j2`, the library's connectors that mate each device's port; a board end places
  the board (`u1` / `u2`), with no plug when the board carries the connector itself, else a plug
  on its footprint;
- **stock**: the given one, else the best of `suggestStocks`: enough conductors for the lines and the
  return, a screen when an end has a chassis pin, twisted pairs for the differential pairs, the
  fewest spare conductors. When no conductor is left for the return the screen carries it; when
  the stock is short of conductors the control lines are left out first (noted);
- **joints**: one conductor per line, a differential pair on a twisted pair, the return on every
  ground pin, the screen on the chassis pins (through a pigtail when its screens are a bonded mass);
- **parts**: each recipe's components as instances (`r1`, `c1` …), wired in series, to ground, or
  across, at the recipe's location; crimp housings get their contacts, seals and plugs by wire
  (`fillCavities`);
- **notes**: the option, what was left out, anything missing (a part not in the library is noted,
  never invented).

The design carries `recipe: { source, destination, option, stock, lengthMm }`. It validates like any
other design.

## Recipes, drift and inference

- `recipeDrift(design, db)`: re-derive from the recipe, apply its `overrides` (the override language
  of `body.ts`: added, removed and moved joints, changed instances and pigtails, each with a
  reason), and compare the physical body. A difference nobody recorded is drift.
- `validateDesign` runs `recipeIssues` for every design with a recipe: `recipe-drift`,
  `recipe-override-stale`, `recipe-option-gone`, `recipe-hazard`, `recipe-unresolved`,
  `recipe-device-unknown` — all warnings: a recipe is advice, the body is the truth.
- `rederive(design, db)` rebuilds the body from the recipe (after a library change), keeping prose
  where the parts survive.
- `inferCableRecipe(design, db)` finds, for a hand design, the device ports its plugs fit, resolves
  every pair, derives every option on the design's own stock and length, aligns instance ids
  (`ids`), and keeps the recipe with the fewest differences; they become its overrides.
- `recipeJointProposals(design, db)`: the joints the recipe derives that the design lacks.

## In the app

- **Which cable do I need?** (`/resolver`, the rail and the Cables toolbar): pick the two devices and
  ports, read the ranked options with their reasons, hazards and missing pieces and the refused
  ones, pick a stock (the fitting ones first), a length, an id, and **Create design**.
- **Devices and recipes** (the second tab): the devices, recipes and hazards in force with where each
  came from, JSON editing with examples to start from, the built-in hazards, and the ranking policy.
- The editor's **Recipe** tab (shown when the design has a recipe or the library has devices): the two
  ends, the option and stock, the option's hazards and missing pieces, the drift (badged on the tab),
  the overrides; **Record as overrides**, **Re-derive**, **Detach** — each one undo step. A hand
  design gets **Infer a recipe** and **Adopt**.
- **Connect known pins** also offers the joints the recipe derives that the design lacks.

## The API

| Route | |
| --- | --- |
| `GET /api/resolver` | devices, recipes, hazards (built-in and library) and policy in force, with `origin` (`local` / `pack`), the library's issues, each file's ETag |
| `PUT /api/resolver/devices` · `/recipes` · `/hazards` | `{ <list>: [...] }`: this hub's own list (If-Match); a pack record saved under its id shadows it; refused (422) when it would add an error |
| `PUT /api/resolver/policy` | `{ policy }`, or `{ policy: null }` for the default |
| `GET /api/resolver/resolve?source=&sourcePort=&destination=&destinationPort=[&boards=0]` | the resolution, and the fitting stocks per option |
| `GET /api/resolver/derive?…&option=&stock=&lengthMm=&id=&label=` | the proposed design, its issues and missing pieces; nothing is written — `POST /api/designs` creates it |
| `GET /api/resolver/designs/:id` | a design's drift, proposals and re-derived body; for a hand design, its inferred recipe |

Writes go through the unit of work like every catalog document, on files and on Postgres; a pack
cannot be disabled while a design's recipe names its devices (the pack lifecycle lists the
reference).

## What a private pack supplies

Only data: its devices and their ports (pinouts it is allowed to describe), its boards as adapter
devices, its recipes with its own component records, its hazards, its ranking policy. A shop's
product rules (which option it sells for which pair) are data in its policy and pack, or a module's
validation rule when they need code.
