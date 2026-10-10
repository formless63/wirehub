/**
 * The automotive domain module: vehicle diagnostic and bus signals (CAN,
 * K/L-line, J1850, battery positive) and the OBD-II connector (SAE J1962)
 * with its mandated pins, as a catalog pack (`../pack`). A data module, like
 * `@wirehub/module-av-video`; code MIT, data CC0-1.0.
 */

import { defineModule } from '@wirehub/modules';

/** The pack directory, as a `file:` URL (resolved on the server). */
/** relative to this file; a variable, so bundlers leave it alone instead of copying the directory as an asset */
const PACK_DIR = '../pack/';
export const AUTOMOTIVE_PACK = new URL(PACK_DIR, import.meta.url).href;

export const automotive = defineModule({
  id: 'automotive',
  label: 'Automotive',
  version: '0.5.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'OBD-II diagnostic plug and receptacle, DEUTSCH DT 2- and 6-way harness housings and contacts, generic sealed sensor connectors, CAN and vehicle diagnostic signals. Generated 3D envelopes and example cables included.',
  },
  catalogPacks: [{ id: 'automotive', label: 'Automotive', version: '0.5.0', root: AUTOMOTIVE_PACK, license: 'CC0-1.0' }],
});
