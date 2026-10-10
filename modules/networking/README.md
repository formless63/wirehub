# Networking — a WireHub domain module

Ethernet for WireHub, as a catalog pack (`pack/`):

- signals: the four Ethernet MDI pairs (IEEE 802.3, BI_DA± … BI_DD±), with
  the words that name them;
- the RJ45 (8P8C) plug body and the RJ45 family, terminated T568B or T568A
  (TIA-568) — the MDI pin functions are the same; the pair colours on pins
  1/2 and 3/6 differ, and the designs' joints carry them;
- an unshielded PCB jack with all eight MDI terminals (no magnetics or PoE rating implied);
- a strain-relief boot, a T568B straight-through patch cable and a
  T568A-to-T568B crossover, both on the base's Cat 5e stock.

Enable it at first-run setup (`/setup`), or list it in
`apps/studio/modules.config.ts` and install its pack. Code: MIT; data:
CC0-1.0; every record cites its source in `src`.

The 3D views are detailed generic approximations, drawn locally: a translucent
plug moulding, individual gold blades, a thin flexible latch and a tapered ribbed
boot; the jack has a recessed mouth, spring contacts and PCB solder tails.
Dimensions cite IEC 60603-7 and Molex SD-95501-001 F1; the inferred details and
illustrative optical properties are marked in each model link. These are neither
manufacturer CAD nor a PCB footprint. Front/rear plug artwork shows mating
contacts and wire entry separately; the jack supplies a mating-face illustration.

For an exact purchased part, attach its manufacturer STEP/GLB in the Library's
3D view. This replaces the generic model for that record without altering its
pinout. Manufacturer CAD and its licence remain separate from this CC0 pack.
