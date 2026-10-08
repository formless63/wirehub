/**
 * The PC & serial domain module.
 *
 * A data module: everything it adds is in its catalog pack (`../pack`) —
 * RS-232 and RS-485 signals and levels, the RS-232 DTE and the PROFIBUS-style
 * RS-485 pinouts on DE-9, USB 2.0 on a Type-A plug, and three example cables
 * (a null modem, an RS-485 cable to a terminated adapter board, a USB LED
 * supply lead).
 * The pack is laid over the base starter catalog (it uses the base's
 * generic bodies, stocks and parts); nothing in the base knows these signals
 * until the pack is installed.
 *
 * Licensed MIT (the pack's data CC0-1.0), like the other bundled domain modules
 * (`docs/modules.md`).
 */

import { defineModule } from '@wirehub/modules';

/** The pack directory, as a `file:` URL (resolved on the server; the browser never reads it). */
/** relative to this file; a variable, so bundlers leave it alone instead of copying the directory as an asset */
const PACK_DIR = '../pack/';
export const PC_SERIAL_PACK = new URL(PACK_DIR, import.meta.url).href;

export const pcSerial = defineModule({
  id: 'pc-serial',
  label: 'PC & serial',
  version: '0.3.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'RS-232, RS-485 and USB: signals, DE-9 pinouts and the USB-A plug, with a null modem, an RS-485 terminal-board cable and a USB LED lead.',
  },
  catalogPacks: [{ id: 'pc-serial', label: 'PC & serial', version: '0.3.0', root: PC_SERIAL_PACK, license: 'CC0-1.0' }],
});
