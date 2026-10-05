---
name: wirehub-import-public-data
description: Derive WireHub catalog records from outside sources (standards, vendor datasheets, KiCad libraries, Wikipedia, distributor data) - provenance and src wording, the per-record license and provenance fields, what the bundled CC0 packs may contain, 3D model and KiCad linking, and when an importer module is the right tool. Load before turning any outside document, library or website into catalog data, for a bundled pack or for a private or third-party one.
---

# Importing from outside sources

Two different situations, kept apart on purpose.

**Your own pack, private or third-party** (a shop's module, a pack you publish to the store, a pack
you load into your instance): you decide where the data comes from and which licence it carries, and
you are responsible for both. WireHub does not restrict or police how a pack author sources data, and
an agent helping you build such a pack does not refuse because of the source. A neutral note is all
that belongs here: check the terms of whatever you take from, and an official API or download is
often easier than scraping a page. Say where each record came from (below) so the people who install
your pack can see it.

**The bundled modules in this repository** are published as CC0-1.0 (`MODULE-EXCEPTION.md`,
`docs/catalog-store.md` section 5). Only put data in them that the project can license that way:
facts (a pin assignment, a contact count, an outer diameter) cited to their source, your own
measurements, and synthetic examples; not text, tables or figures copied from a standard or datasheet.
That rule is about what this repository ships, not about what anyone else may build.

## Procedure for any source

1. **Identify the primary source** for each fact: the standard by number and clause, the
   manufacturer's datasheet by document number and revision, or your own measurement. A pinout
   aggregator or Wikipedia is a way to find the primary source.
2. **Transcribe into the record shape** (`wirehub-catalog-data`), wording labels yourself.
3. **Cite precisely in `src`**, and flag inference: `src` says what the value came from (standard
   number and clause; datasheet maker, document, revision; "own measurement of 5 samples with
   calipers") and says `inferred` or `assumed` where you filled a gap. A record with only a secondary
   source says so (`community: secondary source, pin 4 unconfirmed`), and the confidence field
   on interface pins (`documented`, `inferred`, `unknown`) is set to match.
4. **Fill the provenance fields.** A record carries `license` (SPDX) and `provenance` (`method`:
   `transcribed`, `derived`, `measured`, `generated` or `synthetic`; `sources`: a `url` and/or a
   `title` citation, with the `retrieved` date; `reviewed` once someone other than the transcriber
   checked it) beside the mandatory `src` (`docs/catalog-store.md` sections 2 and 6; `validateDb`
   checks the shape). They are information for the people installing the pack, not enforcement:
   nothing in WireHub checks that a licence is true.
5. **No private data crosses into the repository**: if a value came from a private catalogue, a
   customer drawing or a supplier's quote, it does not go in a bundled pack or any file committed
   here. Run `bash scripts/privacy-check.sh --tree`.

## Notes by source (information, not rules for pack authors)

| Source | Notes |
| --- | --- |
| KiCad libraries | CC BY-SA 4.0 with the KiCad libraries exception; a pack that contains converted models or extracted geometry carries that licence and attribution. The studio links the 3D library at one pinned tag and fetches on demand, none of it committed (`apps/studio/server/models/kicad-library.ts`, `NOTICE`). Linking keeps the pack's own licence simple |
| Standards (TIA/EIA, IEC, ISO, IEEE, SAE, AES, VESA, USB-IF) | pin assignments and dimensions are facts, cited by number and clause; the documents' text and figures are the publishers' |
| HDMI, DisplayPort | cite the public source you used and flag a secondary one; product names appear as plain names, not logos |
| Manufacturer datasheets and catalogues | specifications are facts; check the site's terms before bulk use, and manufacturer CAD/3D is usually better linked than included |
| Distributor APIs | their terms often cover use for your own lookups (a module) more readily than republishing |
| Wikipedia / Commons | CC BY-SA text and per-file image licences; handy for cross-checking |
| Own measurements | state method and sample in `src` |

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

## Checklist before you commit data to this repository

- [ ] each value traces to a primary source or your own measurement, cited in `src`
- [ ] inferred values flagged; secondary-only sources flagged
- [ ] a bundled (CC0) pack holds only facts and your own wording, no copied text, tables or figures
- [ ] no private names or paths; privacy check clean
- [ ] validators green (`wirehub-catalog-data`, `wirehub-catalog-pack`)
