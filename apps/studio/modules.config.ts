/**
 * The deployment's module manifest — the one place a deployment says which
 * modules it runs (`docs/modules.md`). Registration happens at build time:
 * each module is a workspace or git dependency imported here and bundled
 * with the app. The base ships with none.
 *
 *   import { erpLink } from '@acme/cable-studio-erp-link';
 *   export const modules = [erpLink];
 */

import type { CableStudioModule } from '@cable-studio/modules';

export const modules: readonly CableStudioModule[] = [];
