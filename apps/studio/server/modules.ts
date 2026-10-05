/**
 * The module registry as the server sees it: the deployment's manifest
 * (`../modules.config.ts`, the modules built into the image) in a **live**
 * registry, so runtime code modules an owner installs (`code-modules/`,
 * `specs/runtime-modules.md`) are swapped in and out without a restart. Every
 * holder of `registry` sees the current set.
 */

import { createLiveRegistry, createRegistry, type LiveModuleRegistry, type WireHubModule } from '@wirehub/modules';

import { modules } from '../modules.config.ts';
import { installModuleArt } from '../module-art.ts';

/** The modules built into this image: they always load, and win an id clash with a runtime module. */
export const builtinModules: readonly WireHubModule[] = modules;

export const registry: LiveModuleRegistry = createLiveRegistry(createRegistry(modules));

// exporters render drawings on the server too; a runtime module's art and bench steps come and go with it
let uninstallArt = installModuleArt(registry);
registry.subscribe(() => {
  uninstallArt();
  try {
    uninstallArt = installModuleArt(registry);
  } catch (error) {
    // a runtime module's art that does not validate: the built-ins' art stays, the module's is left out
    console.warn(`[modules] ${error instanceof Error ? error.message : String(error)}; only the built-in modules' art is used`);
    uninstallArt = installModuleArt(createRegistry(modules));
  }
});
