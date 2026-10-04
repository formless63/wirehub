# PC & serial — a WireHub domain module

RS-232, RS-485 and USB for WireHub, as a catalog pack (`pack/`):

- signals: RS-232 data and handshake lines (TXD, RXD, RTS, CTS, DTR, DSR,
  DCD, RI), RS-485 A/B, USB D+/D−, with the words that name them, and the
  RS-232 and RS-485 levels;
- the RS-232 DTE pinout (TIA-574) and the PROFIBUS-style RS-485 pinout on
  the base's DE-9 bodies, and USB 2.0 on a Type-A plug;
- three example cables: a DE-9 null modem with local handshake loopbacks,
  an RS-485 cable to the base's terminated adapter board, and a USB LED
  supply lead with a series resistor.

The pack is laid over the starter catalog: it uses the base's DE-9 bodies,
stocks, components, backshell and board. Enable it at first-run setup
(`/setup`), or list it in
`apps/studio/modules.config.ts` and install its pack. Code: MIT; data:
CC0-1.0; every record cites its source in `src`.
