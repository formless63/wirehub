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

// exporters render drawings on the server too
installModuleArt(registry);
