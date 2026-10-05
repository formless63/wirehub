/**
 * The numbering scheme this hub runs on the server: a module's own when one
 * sets it, else the built-in prefix scheme configured by the catalog's
 * `part-numbers.json`, else the default. The browser resolves it the same way
 * (`src/part-numbers.browser.ts`).
 */

import { DEFAULT_PART_NUMBER_SCHEME, schemeFromConfig, type PartNumberScheme } from '@wirehub/model';
import type { ModuleRegistry } from '@wirehub/modules';

import type { Awaitable } from './storage/change-set.ts';

export interface SchemeDeps {
  loadPartNumberFiles?: () => Awaitable<{ scheme?: unknown }>;
  modules?: Pick<ModuleRegistry, 'partNumberScheme'>;
}

export async function partNumberSchemeOf(deps: SchemeDeps): Promise<PartNumberScheme> {
  const registered = deps.modules?.partNumberScheme();
  if (registered !== undefined) return registered;
  const raw = (await deps.loadPartNumberFiles?.())?.scheme;
  if (raw === undefined || raw === null) return DEFAULT_PART_NUMBER_SCHEME;
  try {
    return schemeFromConfig(raw);
  } catch {
    return DEFAULT_PART_NUMBER_SCHEME;
  }
}
