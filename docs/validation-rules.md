# Validation rules: checks written as data

A shop's design rules are mostly "when this, then that must hold". WireHub lets you write those as
**data**, not code: a small, safe JSON language over a design and its library records, with a
severity and a message. Rules are edited in Settings, ship in data packs, run inside the same
validators as the built-in checks (`validateDesign`, `validateDb`), and appear in each cable's
issues panel. An `error` blocks a save and a release like any other error; a `warning` does not.

Complex checks stay code (a module's `validationRules`, `docs/modules.md`). A rule here cannot run
code, read the network or the clock: evaluation is bounded (conditions at most 8 deep and 100 nodes,
at most 200 rules, a step budget per validation that stops with a `rule-budget` warning).

## A rule

```json
{
  "id": "power-conductor-min-area",
  "severity": "error",
  "each": "conductor",
  "where": { "contains": [{ "path": "signalKinds" }, "power"] },
  "require": { "gte": [{ "path": "areaMm2" }, 0.5] },
  "message": "{id} carries {signals} and is {areaMm2} mm², under 0.5 mm²",
  "src": "shop wiring rule"
}
```

- `id`: kebab-case; the issue code is `rule:<id>`. `label`, `enabled` (false: kept, not run) are optional.
- `each`: what the rule is about (below). One issue per subject that fails.
- `where`: which subjects it applies to (absent: all). `require`: what must hold of each; the
  subjects it fails for become issues.
- `severity`: `error` or `warning`. `message`: a template; `{field}` reads the subject's scope
  (`{id}`, `{design.id}`, `{signals}`), a missing value shows as `?`, a list as its items.
- `src`: where the rule comes from (a standard, a shop practice).

### Conditions

| Condition | Holds when |
| --- | --- |
| `{ "all": [c…] }`, `{ "any": [c…] }`, `{ "not": c }` | the combination holds |
| `{ "eq": [a, b] }`, `{ "ne": [a, b] }` | equal / not equal (text compares without case) |
| `{ "gt" \| "gte" \| "lt" \| "lte": [a, b] }` | numbers compare; a missing value or text is false |
| `{ "in": [a, [x, y]] }` | `a` is in the list |
| `{ "contains": [a, b] }` | the list `a` has `b`, or the text `a` includes `b` |
| `{ "startsWith" \| "endsWith": [a, b] }` | text prefix / suffix |
| `{ "exists": a }`, `{ "empty": a }` | a value is present / is absent, empty or an empty list |
| `{ "some" \| "every" \| "none": { "in": "components", "where": c } }` | some / every / no item of a list in the scope passes `c` |

An **operand** is a literal (text, number, true/false/null, a list of those) or one of:
`{ "path": "family" }` (a field of the scope; `design.tags`, `from.instance`), `{ "outer": "id" }`
(a field of the scope outside the current `some`/`every`/`none`), `{ "length": "pinsJoined" }`,
`{ "count": { "in": "mechanicals", "where": c } }`, and `{ "sum" | "min" | "max": { "in": "pins",
"field": "n", "where": c } }`. Inside a quantifier's `where`, the item's own fields are the scope.

**A missing value makes a comparison false**, so a `require` over an unknown value fails; guard an
optional value with `exists` in `where`.

### Subjects (`each`) and the fields they offer

Every scope also has `design` (`id`, `label`, `status`, `tags`, `productRef`, `labourMinutes`, `route`,
`maker`). A library definition's `route` (`make`, `contract`, `buy`) is one of its plain fields
(`docs/products.md`).
A design's **tags** are free words set in the editor (the Notes panel, "Design tags") that rules can
select designs by (`mil-spec`, `export`).

| `each` | One per | Fields |
| --- | --- | --- |
| `design` | the design | the `design` fields at the top |
| `connector` | connector instance | `id def role label family gender construction sourcing partNumber pinCount`, `pinsJoined`, `pinsOpen`, `pins` (`id signal joined`), `mechanicals` (`id def kind qty label`), `mechanicalKinds`, `shells` / `shellCount`, `boards` / `boardCount`, `ends` (run ends joined to it, `w1@a`), and the other plain fields of its definition |
| `segment` | wire run | `id def role lengthMm label partNumber odMm conductorCount minAreaMm2 maxAreaMm2` |
| `conductor` | conductor of a run | `segment path id def wire areaMm2 material color formation lengthMm signals signalKinds joinedA joinedB` |
| `component` | component instance | `id def location label kind category value partNumber …` |
| `pcba` | board instance | `id def label partNumber …`, `terminalCount`, `terminalsJoined`, `terminals` (`id role signal joined`), `connectors` (joined to it: `id def label family gender partNumber role pinCount`), `connectorFamilies`, `shells` / `shellCount` (shells of those connectors) |
| `mechanical` | mechanical instance | `id def qty attachedTo attachedFamily kind label partNumber …`, and its host connector: `host` (`id def label family gender partNumber role pinCount`), `hostDef`, `hostPartNumber` |
| `cable-end` | end (`a` or `b`) of each wire run | `id` (`w1@a`), `segment segmentDef end role label`, `connectors` / `connectorCount` / `connectorFamilies` (joined at this end), `shells` / `shellCount` (attached to those connectors), `mechanicals` / `mechanicalKinds`, `boards` / `boardCount` (joined here, directly or through a connector: `id def label partNumber`), `flying` (nothing but bare conductors) |
| `signal-path` | pair of signal-tagged pins or board terminals joined by copper and parts | `signal signalKind from to` (`instance terminal def family`), `components` (`instance def kind category value label`), `componentKinds`, `componentCategories`, `hops` |
| `connector-def`, `wire-def`, `component-def`, `pcba-def`, `mechanical-def` | library definition (run by `validateDb`) | its plain fields, plus `pinCount`, `conductorCount`, `minAreaMm2`, `maxAreaMm2` |

`signals` and `signalKinds` come from the signal tags of the pins the conductor's net reaches
(`signalKinds` are the vocabulary kinds: `power`, `ground`, `data` …); signals of kind `none`
(`any`, `nc`) are left out.

### Boards, shells and cable ends

`cable-end` is the "for each cable end" selector. Together with the lists on `connector`, `pcba`
and `mechanical` it answers "the end's shell" and "the board at this end" without code:

```json
{ "id": "end-needs-shell", "severity": "error", "each": "cable-end",
  "where": { "gt": [{ "path": "connectorCount" }, 0] },
  "require": { "gt": [{ "path": "shellCount" }, 0] },
  "message": "{segment} end {end} has a connector and no shell", "src": "shop rule" }

{ "id": "board-end-part-number", "severity": "warning", "each": "cable-end",
  "where": { "gt": [{ "path": "boardCount" }, 0] },
  "require": { "some": { "in": "boards", "where": { "exists": { "path": "partNumber" } } } },
  "message": "the board at {id} has no part number", "src": "shop rule" }
```

What an end holds is read from the design's joints: the connectors and boards its conductors are
joined to, the shells attached to those connectors, and a board a joined connector straddles.
Each related list (shells, boards, connectors …) is cut at 50 entries; the usual bounds (subjects
per rule, step budget) apply to these subjects as to the others.

## The four examples

A connector of family X on a design tagged Y must have pin Z joined:

```json
{ "id": "dsub-pin-9", "severity": "error", "each": "connector",
  "where": { "all": [{ "eq": [{ "path": "family" }, "d-sub"] }, { "contains": [{ "path": "design.tags" }, "shielded"] }] },
  "require": { "contains": [{ "path": "pinsJoined" }, "9"] },
  "message": "{id} on {design.id} must have pin 9 joined", "src": "shop rule" }
```

Wire area at least N mm² when the signal has the power kind (the rule at the top of this page).

Every connector of family F needs a mechanical of kind `boot` (a strain-relief boot is a
`mechanical` of kind `boot`):

```json
{ "id": "dsub-boot", "severity": "warning", "each": "connector",
  "where": { "eq": [{ "path": "family" }, "d-sub"] },
  "require": { "contains": [{ "path": "mechanicalKinds" }, "boot"] },
  "message": "{id} has no boot", "src": "shop rule" }
```

A part is required on signal S between its ends:

```json
{ "id": "supply-series-part", "severity": "error", "each": "signal-path",
  "where": { "eq": [{ "path": "signal" }, "pwr-v"] },
  "require": { "some": { "in": "components", "where": { "eq": [{ "path": "category" }, "resistor"] } } },
  "message": "{signal} from {from.instance} to {to.instance} has no series resistor", "src": "shop rule" }
```

## Where rules live

- **This hub's own rules**: `data/validation-rules.json`, an array of rule records (the same shape as
  the other record files), edited in Settings, **Validation rules**: start from an example, **Test
  on my designs** (it counts the errors and warnings the rule would raise on every design and the
  library, writing nothing), **Save rule**, turn off, remove. An owner or an editor saves.
- **A data pack** ships the same file, `validation-rules.json`, in its pack directory. Its rules are
  installed with the pack (an install that would add errors to the library is refused, like any
  record that breaks it) and listed as "from pack …". Save a rule with the same id here to switch
  one off or tighten it. Disabling the pack removes its rules.
- The API: `GET /api/rules`, `PUT /api/rules` (`{ "rules": [...] }`, If-Match, replaces this hub's
  own list), `POST /api/rules/preview` (`{ "rule": { … } }`). A rule that cannot be used is
  refused with every problem named; one that arrives another way (a hand edit) is skipped and
  reported as a `rule-invalid` warning by `validateDb`.

## Code rules still exist

A module's `validationRules` (pure functions over a design and the library) remain for what the
language cannot say. Both run together; their issues look alike.
