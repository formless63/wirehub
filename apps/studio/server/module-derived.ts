/**
 * Modules' derived records (`DerivedContribution`, `docs/modules.md`): the
 * `DerivedStore` the commit runs after a save that changed a design, a
 * definition, a drawing, a vocabulary or a build file.
 *
 * Each declared file is computed by the module's pure `derive` from the
 * designs and the definition db as they are *after* the change, and written as
 * the catalog document `data/derived/<module>/<file>` — byte-for-byte what the
 * file backend leaves on disk and what the database backend keeps in
 * `studio.derived_doc` (derived_kind 'module', module_id = the module), because
 * both go through the same canonical document writer.
 */

import type { CableDesign, Db } from '@wirehub/model';
import type { ModuleRegistry } from '@wirehub/modules';

import type { DerivedStore } from './derived.ts';
import { formatDoc, type DocStore } from './storage/doc-store.ts';
import type { Awaitable, DerivedKind } from './storage/change-set.ts';

export interface ModuleDerivedSource {
  loadDb: () => Awaitable<Db>;
  loadDesigns: () => Awaitable<readonly CableDesign[]>;
  docs: DocStore;
}

/** Where a module's derived file lives in the catalog. */
export function derivedPath(module: string, file: string): string {
  return `data/derived/${module}/${file}`;
}

/** A `DerivedStore` over the registry's derived records; `undefined` when no module declares any. */
export function moduleDerivedStore(registry: ModuleRegistry | undefined, source: ModuleDerivedSource): DerivedStore | undefined {
  const declared = registry?.derived() ?? [];
  if (declared.length === 0) return undefined;
  return {
    async regenerate(): Promise<DerivedKind[]> {
      const db = await source.loadDb();
      const designs = [...(await source.loadDesigns())].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let changed = false;
      for (const record of declared) {
        const out = record.derive({ designs, db });
        for (const file of record.files) {
          const value = out[file];
          if (value === undefined) throw new Error(`module '${record.module}' derived record '${record.id}' did not produce its file '${file}'`);
          const path = derivedPath(record.module, file);
          const text = formatDoc(path, value);
          const before = await source.docs.read(path);
          if (before !== undefined && formatDoc(path, before) === text) continue;
          await source.docs.write(path, value);
          changed = true;
        }
      }
      return changed ? ['module'] : [];
    },
  };
}
