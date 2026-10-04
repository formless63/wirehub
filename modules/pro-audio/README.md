# Pro audio — a WireHub domain module

Balanced and unbalanced audio for WireHub, as a catalog pack (`pack/`):

- signals: audio L/R/mono and hot/cold with the audio return
  (`returnFor`), their lanes, line level, the RCA and microphone colour
  codes and the audio pad roles;
- XLR3 (AES14 / IEC 61076-2-103), RCA and 3.5 mm TRS bodies, pinouts and
  connectors;
- microphone (2-core + braid) and stereo (2-core + spiral) stocks;
- an XLR microphone cable and a 3.5 mm TRS to 2 × RCA Y lead whose moulded
  breakout uses the base's Y body.

The AV / video pack carries identical copies of the audio signal entries
(SCART has audio pins), so the two install side by side. Enable it at
first-run setup (`/setup`, where it is suggested), or list it in
`apps/studio/modules.config.ts` and install its pack. Code: MIT; data:
CC0-1.0; every record cites its source in `src`.
