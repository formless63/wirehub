/**
 * The module registry as the server sees it: built once from the
 * deployment's manifest (`../modules.config.ts`).
 */

import { createRegistry, type ModuleRegistry } from '@wirehub/modules';

import { modules } from '../modules.config.ts';
import { installModuleArt } from '../module-art.ts';

export const registry: ModuleRegistry = createRegistry(modules);

// exporters render drawings on the server too
installModuleArt(registry);
