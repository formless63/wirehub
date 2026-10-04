/**
 * The module registry as the browser sees it: built once from the
 * deployment's manifest (`../modules.config.ts`) at bundle time.
 */

import type { PartNumberScheme } from '@wirehub/model';
import { createRegistry, type ModuleRegistry } from '@wirehub/modules';

import { modules } from '../modules.config.ts';

export const registry: ModuleRegistry = createRegistry(modules);

/** A module's part-number scheme, when one registered; else the catalog's configured default applies. */
export function registeredPartNumberScheme(): PartNumberScheme | undefined {
  return registry.partNumberScheme();
}
