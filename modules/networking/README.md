# Networking — a WireHub domain module

Ethernet for WireHub, as a catalog pack (`pack/`):

- signals: the four Ethernet MDI pairs (IEEE 802.3, BI_DA± … BI_DD±), with
  the words that name them;
- the RJ45 (8P8C) plug body and the RJ45 family, terminated T568B or T568A
  (TIA-568) — the MDI pin functions are the same; the pair colours on pins
  1/2 and 3/6 differ, and the designs' joints carry them;
- a strain-relief boot, a T568B straight-through patch cable and a
  T568A-to-T568B crossover, both on the base's Cat 5e stock.

Enable it at first-run setup (`/setup`, where it is suggested), or list it in
`apps/studio/modules.config.ts` and install its pack. Code: MIT; data:
CC0-1.0; every record cites its source in `src`.
