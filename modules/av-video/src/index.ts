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

/** The pack directory, as a `file:` URL (resolved on the server; the browser never reads it). */
export const AV_VIDEO_PACK = new URL('../pack/', import.meta.url).href;

export const avVideo = defineModule({
  id: 'av-video',
  label: 'AV / video',
  version: '0.1.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'Video signals (RGB, sync, composite, S-Video, component), VGA and SCART connectors, and a VGA example cable.',
  },
  catalogPacks: [{ id: 'av-video', label: 'AV / video', version: '0.1.0', root: AV_VIDEO_PACK, license: 'CC0-1.0' }],
});
