---
title: Concepts
summary: Designs, the library, packs and modules, part numbers and the resolver.
---

# Concepts

## Designs

A design is the canonical definition of one assembly, stored as JSON: connectors placed with a pinout, wire segments, and the joints that tie conductors to pins. Nothing else is stored by hand. Nets, traces, the BOM, the build sheet, the continuity spec and the schematic are all computed from it, and the same design always produces byte-identical output.

A design saves **versions**, and a version can be released, compared with another, and printed. The **History** page lists who changed what and when.

## The library

The library holds the parts a design is built from. Each kind is a tab: connectors, components, wire stocks, boards (PCBAs), mechanicals and kits.

- A **connector** is a physical body (DE-9 male, XLR3 female) composed with a pinout (RS-232, balanced audio), so one body serves many pinouts.
- A **wire stock** is a tree: cables hold pairs, coax and cores, which hold conductors, shields and insulation. Drains, bonded screens, pigtails and breakouts are modelled as built.
- A **board** is a black box with declared internal continuity, so a trace can run through it without modelling its electronics.

Records carry a source, so every value can be traced to where it came from. Records that change save **revisions** you can compare ([Revisions](../reference/revisions/)).

## Packs and modules

A fresh hub has a small, generic starter catalog. Two mechanisms add more.

A **catalog pack** is a signed, versioned bundle of library records (connectors, stocks, parts, example designs) from the **catalog store**. Install, update or disable packs from the Library; a pack's records are read-only until you fork one to edit it. See [Catalog store](../reference/catalog-store/), and [Store hosting](../reference/store-hosting/) to publish your own.

A **module** adds behaviour: a domain vocabulary (video, audio, fieldbus), importers, rules or numbering that data cannot express. Some ship with the app; an owner can install more from a store or by signed upload, and the hub loads them without a rebuild. See [Modules](../reference/modules/).

Most customisation is configuration, not code: part-number schemes, validation rules and webhooks are all set in the app.

## Part numbers

A shop's numbering is a convention, so WireHub treats it as data. A **scheme** recognises a number, checks it, and proposes the next free one. The built-in scheme uses a prefix per kind and a counter (`CON-00001`); a declarative scheme can combine fields, ranges and a variant suffix, and is edited under **Settings > Part numbering**. See [Part numbers](../reference/part-numbers/).

## The resolver

The resolver, the **Find a design** page, takes two devices and the ports to join, and lists every way to connect them, ranked, with reasons, hazards and missing pieces. Choosing one derives a design, and the design remembers its recipe so a later library change can re-derive it. See [Resolver](../reference/resolver/).

## Products and rules

A **product** is a family of builds that differ in length, colour or an option, each documented by a design with its own number ([Products](../reference/products/)). **Validation rules** are checks written as data that run alongside the built-in ones ([Validation rules](../reference/validation-rules/)).
