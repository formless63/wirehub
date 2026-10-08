# Terminology

The words WireHub uses on screen, in the docs and in messages. The UI follows this file; when a
string and this file disagree, fix the string. API routes, ids, file names and data keys keep
their names (`/cables/...`, `CableDesign`, `src`, `cable-list`): a rename there would break
saved data and integrations for no reader's benefit.

Decided by the owner on 2026-10-08 (prime-time plan, O-4).

## Design, not cable

**Design** is the noun for what a person builds and WireHub stores: a harness, an assembly, a
cable, a breakout. People make things that are not cables, so the product does not call
everything a cable.

| Say | Not | Where |
| --- | --- | --- |
| design / designs | cable / cables | the rail ("Designs"), page titles, buttons ("New design"), the wizard, empty states, toasts, the palette, document chrome |
| "this design", "a design" | "this cable" | any sentence about the thing being edited |
| sub-assembly | "cable inside a cable" | a design placed inside another design |
| cable | | only where a physical cable is meant: wire stock ("cable stock"), a cable's jacket, "cable side" of a board pad, a cutaway of a cable, an example name like "XLR Microphone Cable, 5 m" |

A rule of thumb: if the sentence still reads right with "harness" in place of "cable", the word
is "design".

## The two ends

A design has two ends, named for the direction of the signal, never by letter in prose:

- **source end** (wire end `a`): the console or source side.
- **destination end** (wire end `b`): the far side.

Use "source end" and "destination end" in copy. Do not write "end A / end B", "far end", "this
end" or "console side" in the UI. The data keeps `a` and `b`.

## Reference

Every record carries a note of where its values came from (the data key is `src`). The field is
called **Reference**: "the document, board or measurement behind this design". It is not
"Source", because "source" already names an end of the design.

- In the new-design wizard it is pre-filled with **own design**, so a hobbyist who has no
  datasheet is not blocked. The field stays required; the person can overwrite it.
- Inferred values are marked as inferred inside the reference text.

## Find a design

The resolver's page is called **Find a design** everywhere (rail, page title, button, palette).
"Which cable do I need?", "Find cable" and "Which cable?" are retired. The page takes two
devices and lists ranked designs that connect them.

## Extensions, packs, modules

- **Extension**: the umbrella word in the UI for anything added to WireHub that is not built in.
  The Extensions page (and later the Store) is where people add, update and remove them. A person
  does not need to know whether an extension is a pack or a module.
- **Pack**: data only. A catalog pack adds connectors, wires, signals, devices, recipes, rules
  or art; it contains no code and installs without a restart. Say "pack", not "data pack" or
  "catalog pack", except where the kind matters ("catalog pack" vs "numbering scheme").
- **Module**: code. A module adds behaviour (panels, pages, exporters, integrations) through
  the module API, and may carry a pack. Built-in modules ship with WireHub; code modules are
  installed by an owner and run with the permissions they declare.
- **Store**: a signed list of packs and modules an owner can install from.

## Other terms

- **WireHub**: the product. Never "the studio", "Workbench" or "Cable Studio" in copy.
- **hub**: one installation of WireHub and its data ("this hub's settings").
- **Library**: the parts: connectors, wires, components, boards, hardware, kits. A library
  entry is a *record* (or "part"), not a "definition", in the UI.
- **part number**: the identifier printed on a drawing or a part, made by the hub's numbering
  scheme (Settings, Part numbering). A design's *product reference* and *drawing number* are the
  same part number written twice. Write "part number", not "P/N", "PN" or "item number".
- **resolver**: the engine behind Find a design (devices, ports, recipes, hazards, ranking). It
  is named only where its data is edited ("Devices and recipes"); a person finds a design.
- **build sheet**, **BOM**, **continuity spec**, **drawing**: the documents a design produces.
  Documents are *issued*, designs are *saved*.
- **wire stock**: a purchasable cable or wire in the library (not a design).

## Copy rules that go with the words

- No explanatory paragraph under a page title. The explanation goes behind a `(?)` tip or a
  "Learn more" link (`apps/studio/src/help.ts`).
- No documentation file path, environment variable, migration number, job-engine id or raw id in
  copy. Settings, System may name an environment variable an operator needs.
- Sentence case for titles and buttons; the ellipsis (…) only on a button that opens a dialog.
