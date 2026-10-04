/**
 * The module registry as the server sees it: built once from the
 * deployment's manifest (`../modules.config.ts`).
 */

import { createRegistry, type ModuleRegistry } from '@wirehub/modules';

import { modules } from '../modules.config.ts';

export const registry: ModuleRegistry = createRegistry(modules);
