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
 *   export const modules = [avVideo, automotive, erpLink];
 */

import { automotive } from '@wirehub/module-automotive';
import { avVideo } from '@wirehub/module-av-video';
import type { WireHubModule } from '@wirehub/modules';

export const modules: readonly WireHubModule[] = [avVideo, automotive];
