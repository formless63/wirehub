# Resin printing (2026-10)

Status: **offered for Elegoo `.goo`**, files only, not yet confirmed on a printer.

## Pipeline

    STL / 3MF ──PrusaSlicer 2.9.2 (SLA mode)──▶ .sl1 ──UVtoolsCmd 7.0.2 convert──▶ .goo
                 supports, pad, layers                  printer header, RLE layers

Both tools are AGPL-3.0, pinned in one pack image (`tools/slicer-resin/`): PrusaSlicer as
Debian trixie packages it, UVtools as its linux-x64 release zip with the SHA-256 checked at
build time. Nothing in the chain needs a network, a GPU or a vendor slicer.

Why this pairing: UVtools is not a geometry slicer (it cannot make layers or supports from a
mesh), and PrusaSlicer's SLA mode only writes Prusa's `.sl1`. Together they cover it, and
UVtools ships its own PrusaSlicer printer profiles for this purpose (the Mars 5 Ultra values
here follow its profile: 8520 × 4320 px, 153.36 × 77.76 mm, 165 mm Z, display mirrored in X).

## What is checked

Every run reads the `.goo` back twice before it counts:

- UVtools' `print-properties` (machine name, resolution, layer count, exposures, …);
- the pack's own reader of Elegoo's published GOO layout: header fields, every layer's
  checksum, Z order and end marker, and a sample of layers decoded pixel by pixel.

During development the output was also read by an unrelated implementation, mslicer's
`goo_format` (GPL-3.0, v0.9.2), which parsed the header and decoded and checksummed every
layer without error.

## What is not known yet

- **No `.goo` from this pipeline has been printed by WireHub.** Print a small asymmetric test
  part first: check that it is not mirrored, that it sticks, and that supports hold.
- The Mars 5 Ultra has a tilting vat. UVtools writes its lift and retract fields as fixed
  0.05 placeholders for this printer (its own handling, selected by the machine name); the
  printer is expected to use its own tilt release.
- Exposure values in the starter material are a generic starting point for a standard resin.
  Run an exposure test for your resin and save the values in a material profile.
- Hollowing: PrusaSlicer can hollow (`hollowing_enable`), but the command line cannot place
  drain holes, so it is off; hollow in a desktop slicer when you need it.

Preparation stays files-only, as for FDM: WireHub never sends a job to a printer.
