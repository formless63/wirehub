# AV / video — a WireHub domain module

Analog and digital video for WireHub, as a catalog pack (`pack/`):

- signals: video R/G/B, H/V and composite sync, composite video, S-Video
  luma/chroma, component Y/Pb/Pr, DDC, SCART blanking and function switching,
  and the returns that go with them (`returnFor`), with the words that name
  them (labels, short names, aliases) so the wizard and the tag proposals
  read pin labels like "Red GND" or "CSync";
- lanes, levels and connector families (HD15, SCART, BNC);
- the VGA (DE-15) and SCART connectors, and a VGA monitor cable on a
  three-coax multicore;
- identical copies of the audio L/R/mono signals and their return, which
  SCART's audio pins need: the pack installs with or without the pro-audio
  module, and beside it without a conflict.

Enable it at first-run setup (`/setup`), or list it in
`apps/studio/modules.config.ts` and install its pack. Code: MIT; data:
CC0-1.0; every record cites its source in `src`.
