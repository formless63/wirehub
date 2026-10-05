# Part numbers: a scheme written as data

A shop's part numbers are a convention, not code. WireHub numbers parts and cables through a
**scheme**: something that recognises its numbers, checks a number, and proposes the next free
one. Which scheme a hub runs is configuration, and most real schemes can be written as data in
Settings (or shipped in a data pack), with no module:

| Scheme | Where | For |
| --- | --- | --- |
| the **prefix** scheme | `data/part-numbers.json` (`prefixes`, `digits`, `separator`) | `CON-00001`: one prefix per kind and a counter |
| a **declarative** scheme | `data/part-numbers.json` (`"type": "declarative"`) | `<Level><Type>-NNNNNN-VV`: fields, per-kind values, counters per combination with ranges, a variant suffix, a validation regex |
| a **code** scheme | a module's `partNumberScheme` (`docs/modules.md`) | what data cannot say: a lookup against another system, a check digit |

Resolution: a module's scheme wins when one is registered; else `part-numbers.json`; else the
prefix defaults. The same definition is read on the server (proposals, the health report, the
duplicate checks and the save guards), in the browser (Suggest) and by the catalog loaders.

## Editing it

Settings, **Part numbers** (owner or editor): the definition as JSON, a **Check** that shows how it
reads sample numbers and what a new connector, wire or cable would be proposed, and **Save scheme**.
Check also counts how many numbers already in use do not fit (they are kept as they are). The
same through the API:

```
GET  /api/settings/part-numbers            the stored definition, the scheme in force, packs' offers
PUT  /api/settings/part-numbers            { "scheme": { … } }  |  { "scheme": null }  |  { "adoptFrom": "<pack id>" }   (If-Match)
POST /api/settings/part-numbers/preview    { "scheme": { … }, "samples": ["1C-000001-00"], "suggest": [{ "kind": "connector" }] }
```

`PUT` with `adoptFrom` takes the scheme an installed pack offers and is an owner's confirmation
in a signed-in session (below). A bad definition is refused with every problem named and nothing
saved.

## The declarative definition

```json
{
  "type": "declarative",
  "id": "level-type-seq",
  "label": "Level and type, sequence, variant",
  "template": "{level}{type}-{seq}-{variant}",
  "segments": [
    { "id": "level", "type": "choice", "label": "Level", "values": [
      { "value": "1", "label": "Part", "kinds": ["connector", "wire", "component", "shell", "fastener", "mechanical-other"] },
      { "value": "2", "label": "Assembly", "kinds": ["pcba", "design", "kit"] } ] },
    { "id": "type", "type": "choice", "label": "Type", "values": [
      { "value": "C", "label": "Connector", "kinds": ["connector", "shell"] },
      { "value": "W", "label": "Wire", "kinds": ["wire"] },
      { "value": "E", "label": "Component", "kinds": ["component"] },
      { "value": "H", "label": "Hardware", "kinds": ["fastener", "mechanical-other"] },
      { "value": "B", "label": "Board", "kinds": ["pcba"] },
      { "value": "A", "label": "Cable assembly", "kinds": ["design", "kit"] } ] },
    { "id": "seq", "type": "counter", "label": "Sequence", "width": 6, "per": ["level", "type"],
      "ranges": [{ "from": 1, "to": 999999 }] },
    { "id": "variant", "type": "variant", "label": "Variant", "style": "numeric", "width": 2, "first": "00", "max": "99" }
  ],
  "validation": { "regex": "^[12][A-Z]-\\d{6}-\\d{2}$", "message": "must look like 1C-000001-00" },
  "immutable": true,
  "src": "synthetic example"
}
```

This numbers a connector `1C-000001-00`, a wire `1W-000001-00` and a cable assembly `2A-000001-00`.
(The values are made up; use your own letters and levels.)

**`template`** lays the number out. `{id}` places a segment, any other text is a literal
separator (`-`, `.`, `/`), and `[ … ]` is an optional group that is left out when the segment in
it is absent (`P{seq}[-{rev}]`). At most 200 characters; every segment is placed exactly once.

**Segments** (at most 12), each with a kebab `id`, an optional `label` and a `type`:

- **`choice`**: a field with a fixed list of `values`. A value is 1 to 8 letters or digits and may
  list the record `kinds` it is allowed for (`connector`, `component`, `wire`, `pcba`, `bare-pcb`,
  `shell`, `fastener`, `mechanical-other`, `kit`, `design`); absent `kinds` means any kind. A new
  number takes, for each choice, the first value that lists the kind being numbered; a kind no value
  lists is **not numbered** by the scheme (or takes the choice's `default`). A number whose value is
  not allowed for its record's kind is reported (`pn-wrong-kind`).
- **`counter`**: a zero-padded number of `width` digits. It runs **per combination** of the choice
  segments named in `per` (default: all of them): `1C` has its own counter, `1W` another.
  `ranges` give each combination its span, the first matching range wins (`match`: segment id to a
  value or list of values, absent = every combination; `from` to `to`); without a range a counter
  runs 1 to the largest `width` digits hold. A proposal is the highest number in use in the range
  plus one, never a taken number, and none when the range is used up. A number outside its range is
  reported (`pn-out-of-range`).

  A counter can also say what it **never issues**, and use **several disjoint ranges**:

  ```json
  { "id": "seq", "type": "counter", "width": 6, "per": ["level", "type"],
    "exclude": [13, { "from": 900000, "to": 999999 }],
    "ranges": [
      { "match": [{ "level": "1", "type": "C" }, { "level": "2", "type": "A" }],
        "spans": [{ "from": 1000, "to": 4999 }, { "from": 20000, "to": 29999 }],
        "exclude": [{ "from": 2000, "to": 2099 }] },
      { "from": 1, "to": 999 } ] }
  ```

  - `exclude` (on the counter, or on one range) lists numbers and `{ from, to }` spans that are
    never proposed; a number in use that falls in one is reported (`pn-excluded`). A counter's
    exclusions apply to every range, a range's only to itself.
  - `spans` in place of `from`/`to` gives a **union** of disjoint ranges. A proposal is the first
    free number above the highest in use that lies in a span and in no exclusion, hopping from one
    span to the next; none when the last span is used up.
  - `match` may be one object or a **list of objects**; the range applies when any of them
    matches, so `1C` and `2A` can share a range without `1A` doing so. Several segments in one
    object must all match. Each segment named in `per` is part of the counter's key, so
    `1C` and `1W` still count separately.
  - Bounds: at most 100 ranges, 100 spans and exclusions per list, 50 matches per range.
- **`variant`**: the suffix of a part that is a variant of another (`-00`, `-01`; or letters `A`,
  `B` … `AA` with `"style": "alpha"`). `first` is a brand-new part's variant, `max` the highest a
  part may reach, `kinds` the kinds that carry variants, `optional: true` (inside a `[ ]` group)
  lets the number leave it out. A proposal made for a part that is a variant of an existing
  number (`variantOf` in the preview, `PnSubject.variantOf` in code) is that number with the next
  variant.

**`validation`** adds a regular expression over the whole number (and a `message` for it), on top
of what the template already enforces. It is bounded: at most 200 characters, no backreferences,
lookbehind or nested quantifiers, and only run on strings of at most 64 characters.

**`immutable`**: "existing numbers never change". A record that already carries a number cannot be
saved with another (or none): the save is refused with `pn-immutable` and nothing is written. The
first assignment is free, and switching schemes never rewrites any number. To correct a wrong
number, turn `immutable` off for the correction.

## What uses it

- **Proposals**: Suggest in the part, cable and drawing forms; the unmapped lines of the BOM and
  build sheet; the **Part numbers** page's "would be numbered" column. All read the scheme's
  `suggest`, with every number already in use (catalog, designs, drawings).
- **Health report and duplicate checks**: the canonical spelling (`parse`) is what two numbers are
  compared by (`1c-000001-00` and `1C-000001-00` are one number); numbers the scheme objects to
  (`pn-malformed`, `pn-wrong-kind`, `pn-out-of-range`) are listed, as warnings. Numbers from before
  a switch are kept, listed, and never rewritten.
- **Save guards**: a save that gives a second part a number already in use is refused; with
  `immutable`, a save that changes an existing number is refused.

## In a data pack

A pack can offer a scheme: put the same definition in its manifest, `wirehub-pack.json`:

```json
{ "format": 1, "id": "acme-numbers", "name": "…", "version": "1.0.0", "license": "CC0-1.0",
  "partNumberScheme": { "type": "declarative", "template": "…", "segments": [ … ] } }
```

Verifying the pack checks the definition (a bad scheme refuses the pack). **Installing a pack
never switches the hub's scheme**: the install answer carries `offers.partNumberScheme`, the
Packs panel and the store say so, and Settings, Part numbers lists the offer with a **Review…**
that shows how many numbers in use would not fit. An owner confirms the switch
(`PUT … { "adoptFrom": "<pack id>" }`, in a signed-in session, not with an API token).

## When it is code

Keep a module's `partNumberScheme` for what a definition cannot say: a number that depends on a
lookup elsewhere, a check digit, a register another system owns. The `PartNumberScheme` interface
(`packages/model/src/part-numbers.ts`) is unchanged and `declarativePartNumberScheme` builds one
from a definition if a module wants to start from it.
