/**
 * The module registry as the browser sees it: the deployment's manifest
 * (`../modules.config.ts`, the modules built into the image) in a **live**
 * registry, which the page's runtime-module loader (`code-modules.browser.ts`)
 * swaps when the server runs code modules an owner installed.
 */

import type { PartNumberScheme } from '@wirehub/model';
import { createLiveRegistry, createRegistry, type LiveModuleRegistry, type WireHubModule } from '@wirehub/modules';

import { modules } from '../modules.config.ts';

/** The modules built into this image. */
export const builtinModules: readonly WireHubModule[] = modules;

export const registry: LiveModuleRegistry = createLiveRegistry(createRegistry(modules));

/** A module's part-number scheme, when one registered; else the catalog's configured default applies. */
export function registeredPartNumberScheme(): PartNumberScheme | undefined {
  return registry.partNumberScheme();
}
