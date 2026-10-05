# Shield bonding

How WireHub models cable screens that touch along their length, and screens that are
twisted together at an end and landed once. The generic spec of the code in
`packages/model/src/bonds.ts` (truth), `validate.ts` (rules), `nets.ts` (connectivity) and
`packages/layout/src/bond-fold.ts` (how a bonded mass draws). Examples are the starter
catalog's. When SPEC.md disagrees, SPEC wins.

A **screen** is a shield (foil, braid, spiral, tape) or a bare conductor (a drain wire).
Two physical facts live in the model, and nothing else about screens is invented.

## 1. Bonded sets: a fact about a stock

`WireDefinition.bonded` is a list of sets of screen paths that touch for the whole length of
the stock, so each set is **one copper mass**:

```json
"bonded": [{ "members": ["foil", "drain"], "src": "the drain lies on the foil for the whole length" }]
```

(`shielded-2pair-24awg` in the starter catalog.) Rules:

- every member resolves to a shield or a bare conductor of the stock (`bonded-member-not-screen`);
- a screen is in at most one set;
- the set has a `src`, like every catalog record.

`isFullyBonded(wire)` is true when every screen of the stock is in one set: the stock is a
single shield mass. That decides how a pigtail is written (section 2).

Connectivity: `deriveNets` ties the members of a set together at every end where any member
is connected (`bond` links), because they are one conductor. The tie is derived, never a
joint.

## 2. Pigtails: a fact about a segment end

A **pigtail** (`SegmentInstance.pigtails`) is a set of screens of one segment, twisted
together at one end and landed once:

```json
{ "id": "shield", "end": "a", "members": ["foil", "drain"], "note": "foil and drain twisted together" }
```

- It is a terminal of the segment, `pigtail:<id>`, at its end. Its landing is an ordinary
  joint to that terminal, so **joints stay the only solder facts**.
- `members` lists the screens twisted into it. On a fully bonded stock `members` is omitted:
  the pigtail stands for the whole mass (`pigtailMembers`). Listing members there is
  `pigtail-members-on-mass`.
- An id is unique per segment end (`duplicate-pigtail-id`). A pigtail has members, or is a
  mass pigtail on a fully bonded stock (`pigtail-empty`). Every member is a screen
  (`pigtail-member-unknown`) and is in at most one pigtail at that end (`pigtail-member-twice`).
- A screen that is in a pigtail has no joint of its own at that end (`pigtail-and-joint`).
- A pigtail lands exactly once: no joint is `pigtail-no-landing`; more than one is a warning
  (`pigtail-multi-landing`), because one tail is soldered in one place; split it.
- On a fully bonded stock a joint straight onto a screen is a warning (`bonded-screen-joint`);
  land the mass through a pigtail.

A physical pad of a board terminal may be named on the landing (`TerminalRef.pad`, checked by
`pad-unknown`) without changing the net.

## 3. What is terminated

`screenTerminations(design, db)` answers, for every screen end that is terminated, how:

| Value | Meaning |
| --- | --- |
| `joint` | a joint lands on it directly |
| `pigtail` | it is a member of a pigtail that has a landing |
| `bonded` | another member of its set is terminated at that end, so the mass is (a cut drain) |
| `through` | it passes uncut through a breakout mould and continues on a leg |

The `screen-floating` warning reads this: a screen, or a whole bonded mass reported once, that
is landed at one end and not the other is a warning asking for a design note naming the
terminal if it is deliberate (a drain left unconnected at the far end, a drain policy).

## 4. Foil that is never landed

`isTrimmedFoil(wire, path)`: a foil or tape shield bonded to a bare drain, on a stock that is
**not** one shield mass (a mini-coax), is trimmed back at the bench and never landed; the
drain is what is soldered. It gets no indication on the drawings. On a fully bonded stock the
foil is part of the mass a pigtail lands.

## 5. How a bonded mass draws

Presentation only (`bond-fold.ts`; nothing here changes what a joint may land on or what the
picker offers):

- Each set has one **representative** (`bondedRepresentative`): a bare drain if there is one,
  else the first copper member, never the foil. The other members fold into it: the schematic
  band draws one track for the mass, the end face one port.
- A foil that is not a representative is never drawn or labelled.
- A fully bonded stock's representative is labelled as the whole screening
  (`bondedMassLabel`): "shields - 7 copper screens + drain, bonded", not "foil".
- The cutaway keeps every ring: they are real geometry. Only its legend text folds.
- A pigtail draws as a bracket gathering its member tracks at the band end and one lead out
  to its landing (`DiagramPigtail`); several pigtails at one end take successive slots.

The build sheet reads the same facts (`deriveGroundLandings`): which screens are twisted
together at an end and the pad they land on. The continuity spec carries one visual
**ground landing** check per pigtail per end, to be made before the shell goes on: the
pigtail sits on its landing and nothing else is on it.

## 6. Editing

The canvas edits pigtails through `editPigtails` (`packages/editor-react/src/pigtail-edit.ts`):
add or remove a pigtail, change its members, land it on a terminal, with each edit a pure
design-in, design-out function validated by the one door into the design (a candidate with a
new error is dropped whole).
