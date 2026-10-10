/**
 * The Networking domain module.
 *
 * A data module: everything it adds is in its catalog pack (`../pack`) —
 * the Ethernet MDI pair signals, the RJ45 (8P8C) plug terminated T568A or
 * T568B and an unshielded PCB jack, a strain-relief boot, and a straight patch cable and a crossover.
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
export const NETWORKING_PACK = new URL(PACK_DIR, import.meta.url).href;

export const networking = defineModule({
  id: 'networking',
  label: 'Networking',
  version: '0.1.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'Ethernet: RJ45 T568A/B plugs and an unshielded PCB jack, detailed generic artwork, MDI pair signals, patch and crossover examples.',
  },
  catalogPacks: [{ id: 'networking', label: 'Networking', version: '0.3.0', root: NETWORKING_PACK, license: 'CC0-1.0' }],
});
