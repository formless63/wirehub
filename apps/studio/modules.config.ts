/**
 * The deployment's module manifest — the one place a deployment says which
 * modules it runs (`docs/modules.md`). Registration happens at build time:
 * each module is a workspace or git dependency imported here and bundled
 * with the app.
 *
 * The base bundles its **domain modules** here. They are optional: each is
 * offered at first-run setup (`/setup`), and only the ones a person picks
 * have their catalog packs installed. A private module is added the same way:
 *
 *   import { erpLink } from '@acme/wirehub-erp-link';
 *   export const modules = [pcSerial, networking, proAudio, avVideo, automotive, erpLink];
 */

import { automotive } from '@wirehub/module-automotive';
import { avVideo } from '@wirehub/module-av-video';
import { example } from '@wirehub/module-example';
import { networking } from '@wirehub/module-networking';
import { pcSerial } from '@wirehub/module-pc-serial';
import { proAudio } from '@wirehub/module-pro-audio';
import type { WireHubModule } from '@wirehub/modules';

/**
 * The dev flag for the example module (`modules/example`): `WIREHUB_EXAMPLE_MODULE=1`
 * at start (the server reads `process.env`) and at bundle time (`vite.config.ts` forwards
 * it to the browser as `VITE_WIREHUB_EXAMPLE_MODULE`). Off, the example is not in the
 * manifest at all: no setup entry, no panels, no routes, no hooks.
 */
function exampleFlag(): boolean {
  const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const vite = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return node?.WIREHUB_EXAMPLE_MODULE === '1' || vite?.VITE_WIREHUB_EXAMPLE_MODULE === '1';
}

export const modules: readonly WireHubModule[] = [pcSerial, networking, proAudio, avVideo, automotive, ...(exampleFlag() ? [example] : [])];
