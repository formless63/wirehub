/**
 * The module registry for the components that mount module contributions.
 * Defaults to the build's own registry (`modules.browser.ts`); `<App modules>`
 * replaces it, which is how the tests run a registry of their own.
 */

import type { ModuleRegistry } from '@wirehub/modules';
import { createContext, useContext } from 'react';

import { registry as buildRegistry } from '../modules.browser.ts';

export const ModulesContext = createContext<ModuleRegistry>(buildRegistry);

export function useModules(): ModuleRegistry {
  return useContext(ModulesContext);
}
