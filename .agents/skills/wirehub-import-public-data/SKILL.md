---
name: wirehub-import-public-data
description: Derive WireHub catalog records from public sources (standards, vendor datasheets, KiCad libraries, Wikipedia, distributor data) without breaking licences - what may be copied, what may only be cited, provenance and src wording, 3D model and KiCad rules, and when an importer module is the right tool. Load before turning any outside document, library or website into catalog data.
---

# Importing from public data

The catalog and its packs are CC0-1.0. That only works if nothing in them is someone else's
protected expression. The store's rule (`docs/catalog-store.md` section 5, "Public data sources and
their licence caveats"; not legal advice): **pin assignments and dimensions are facts and are
cited, not copied; a standard's text, tables and figures are never reproduced; every record names
its source.** Read that section before you start; the table below is its summary.

## Decision procedure for every source

1. **Identify the primary source** for each fact: the standard by number and clause, the
   manufacturer's datasheet by document number and revision, or your own measurement. A pinout
   aggregator or Wikipedia is only a way to find the primary source; do not cite it alone.
2. **Check the licence of what you will take.** A fact (pin 2 of a DE-9 DTE is RxD; a contact
   count; an outer diameter) is free to record. Prose, tables laid out as in the document,
   figures, drawings, 3D files, symbol and footprint files, and a catalogue taken in bulk are not.
3. **Transcribe, do not paste.** Re-enter each value by hand into the record shape (`wirehub-catalog-data`);
   word labels yourself. Never bulk-import a vendor catalogue or a scraped site: manufacturers'
   terms usually forbid it, and in the EU a substantial extraction from a database can infringe
   even when each fact is free. Assemble from primary sources.
4. **Cite precisely in `src`**, and flag inference: `src` says what the value came from (standard
   number and clause; datasheet maker, document, revision; "own measurement of 5 samples with
   calipers") and says `inferred` or `assumed` where you filled a gap. A record with only a secondary
   source says so (`community: secondary source, pin 4 unconfirmed`), and the confidence field
   on interface pins (`documented`, `inferred`, `unknown`) is set to match.
5. **No private data crosses over**: if a value came from a private catalogue, a customer drawing
   or a supplier's quote, it does not go in. Run `bash scripts/privacy-check.sh --tree`.
6. **Say where each record came from, in fields.** A record carries `license` (SPDX) and
   `provenance` (`method`: `transcribed`, `derived`, `measured`, `generated` or `synthetic`;
   `sources`: a `url` and/or a `title` citation, with the `retrieved` date; `reviewed` once someone
   other than the transcriber checked it) beside the mandatory `src` (`docs/catalog-store.md`
   sections 2 and 6; `validateDb` checks the shape). **Records you cannot license CC0 stay
   out**: a record that needs another licence names it in its own `license`, or better goes in a
   separate pack with its own `license` in `wirehub-pack.json`, or it is not contributed. Records
   under a licence that forbids redistribution never enter a pack.

## Source table (summary of `docs/catalog-store.md` section 5)

| Source | You may | You may not |
| --- | --- | --- |
| KiCad libraries (symbols, footprints, 3D models) | record body names, footprint pad counts and geometry facts; **link** to a model at a pinned tag | commit converted models or extracted geometry into a CC0 pack: derived data is CC BY-SA 4.0 and needs attribution. The studio pins the 3D library at one tag and fetches only on demand, none of it committed (`apps/studio/server/models/kicad-library.ts`, `NOTICE`) |
| TIA/EIA, IEC, ISO, IEEE, SAE, AES, VESA, USB-IF standards | cite number and clause; record assignments | reproduce tables or figures; use logos |
| HDMI, DisplayPort | cite a secondary public source and flag the record | use logos; present an unofficial source as the spec; "HDMI" only as a nominative name |
| SAE J1962 / ISO 15031-3 | the mandated pins (4/5 ground, 16 battery, 6/14 CAN) | present manufacturer-discretionary pins as standard |
| Manufacturer datasheets and catalogues | transcribe specifications by hand with the document cited | scrape, bulk import, or include manufacturer CAD/3D (link only) |
| Aggregators (SnapEDA, Ultra Librarian, TraceParts) | nothing beyond finding the maker's own file | redistribute their models |
| Distributor APIs (Digi-Key, Mouser, Octopart) | a module may use them for a deployment's own lookups | use them as the source of a pack |
| Wikipedia / Commons | cross-check | cite alone (mark `community`); copy images or text (CC BY-SA, per-file licences) |
| Own measurements | state method and sample in `src` | omit how it was measured |

Trademarks (USB, HDMI, product names) appear as plain nominative names ("USB Type-C plug"), never
as logos.

## When to write an importer (module code) instead

A one-off transcription is hand-authored JSON. A repeatable conversion of a file format you may use
(your own `.kicad_pcb`, a CSV from your own tools) is an **importer** extension point
(`wirehub-module`): `ImporterContribution { id, label, accepts, import(input, db) }` returns
`{ definitions?, designs?, notes }`, proposes records and never writes; the person reviews and
accepts them in the Library. The example is `importResistors` in `modules/example/src/logic.ts`.
Importers must be deterministic and must set `src` to cite the input file and its revision; a
generated pack built by a converter names the converter version and the pinned upstream commit
(`docs/catalog-store.md` section 4, "Generated packs are reproducible"). An importer tied to one
shop's file share belongs in that shop's private module, not here (`docs/boundaries.md`).

## Checklist before you commit data

- [ ] each value traces to a public primary source or your own measurement, cited in `src`
- [ ] inferred values flagged; secondary-only sources flagged
- [ ] nothing copied verbatim from a standard, datasheet or library beyond bare facts and part names
- [ ] no model files, drawings or logos added; 3D models are linked, not included
- [ ] no private names or paths; privacy check clean
- [ ] validators green (`wirehub-catalog-data`, `wirehub-catalog-pack`)
