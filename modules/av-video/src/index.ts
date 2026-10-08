/**
 * The AV / video domain module.
 *
 * A data module: everything it adds is in its catalog pack (`../pack`) —
 * the video signals (RGB, sync, composite, S-Video, component) with the words
 * that name them and the returns that go with them, the VGA (DE-15) and
 * SCART connectors, levels, and a VGA monitor cable. Nothing in the WireHub
 * base knows a video signal; once the pack is installed, the wizard, the
 * compatibility rules, the continuity spec and the tag proposals read these
 * entries like any other vocabulary.
 *
 * Licensed MIT (the pack's data CC0-1.0): it is also a template for modules
 * of your own (`docs/modules.md`).
 */

import { defineModule } from '@wirehub/modules';

// the pack's art files, imported as data so the browser bundle carries them too
import bodyLayouts from '../pack/art/body-layouts.json' with { type: 'json' };
import bncArt from '../pack/art/connectors/bnc.json' with { type: 'json' };
import jp21Art from '../pack/art/connectors/jp21-21.json' with { type: 'json' };
import scartArt from '../pack/art/connectors/scart-21.json' with { type: 'json' };

/** The pack directory, as a `file:` URL (resolved on the server; the browser never reads it). */
/** relative to this file; a variable, so bundlers leave it alone instead of copying the directory as an asset */
const PACK_DIR = '../pack/';
export const AV_VIDEO_PACK = new URL(PACK_DIR, import.meta.url).href;

export const avVideo = defineModule({
  id: 'av-video',
  label: 'AV / video',
  version: '0.2.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'Video signals (RGB, sync, composite, S-Video, component), VGA and SCART connectors, and a VGA example cable.',
  },
  // the SCART and JP21 faces and their body layouts (the 21-pin Peritel shell is this module's to draw), and the BNC side view
  art: { connectors: [scartArt, jp21Art, bncArt], bodyLayouts },
  catalogPacks: [{ id: 'av-video', label: 'AV / video', version: '0.2.0', root: AV_VIDEO_PACK, license: 'CC0-1.0' }],
});
