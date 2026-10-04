/**
 * The Pro audio domain module.
 *
 * A data module: everything it adds is in its catalog pack (`../pack`) —
 * balanced and unbalanced audio signals with their returns, lanes, line level
 * and colour codes; XLR3, RCA and 3.5 mm TRS connectors; microphone and
 * stereo stocks; an XLR microphone cable and a TRS-to-2×RCA Y lead.
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
export const PRO_AUDIO_PACK = new URL(PACK_DIR, import.meta.url).href;

export const proAudio = defineModule({
  id: 'pro-audio',
  label: 'Pro audio',
  version: '0.1.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'Balanced and unbalanced audio: XLR3, RCA and 3.5 mm TRS connectors, microphone and stereo stocks, an XLR microphone cable and a TRS-to-2×RCA Y lead.',
    suggested: true,
  },
  catalogPacks: [{ id: 'pro-audio', label: 'Pro audio', version: '0.1.0', root: PRO_AUDIO_PACK, license: 'CC0-1.0' }],
});
