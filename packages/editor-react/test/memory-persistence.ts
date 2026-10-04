/**
 * A `PersistenceAdapter` with a `Map` behind it.
 *
 * It keeps the host's rules, not just its shape — validate before write, refuse
 * an id already in use, insist on the confirm token — because a test adapter
 * that always said yes would prove only that the buttons are wired, not that
 * the lifecycle handles being told no. The messages are phrased the way the
 * workbench API phrases them, so the plain-language rendering is exercised too.
 *
 * This is also the third implementation of the interface, which is the point of
 * having one: browser `fetch`, filesystem, and `Map` all satisfy it, and the
 * editor cannot tell them apart.
 */

import { errors, validateDesign, type CableDesign, type Db } from '@wirehub/model';

import type { DesignSummary, Outcome, PersistenceAdapter } from '../src/persistence.ts';

export interface MemoryPersistence extends PersistenceAdapter {
  /** what is "on disk" */
  stored: Map<string, CableDesign>;
  /** every call made, in order — `save:rs485-de9-terminal-board` */
  calls: string[];
}

function refuse<T>(message: string, hint: string): Outcome<T> {
  return { ok: false, message, hint };
}

export function memoryPersistence(db: Db, seed: CableDesign[] = []): MemoryPersistence {
  const stored = new Map<string, CableDesign>(
    seed.map((design) => [design.id, structuredClone(design)]),
  );
  const calls: string[] = [];

  const copy = (design: CableDesign): CableDesign => structuredClone(design);

  const checked = (design: CableDesign): Outcome<CableDesign> => {
    const issues = validateDesign(design, db);
    if (errors(issues).length > 0) {
      return {
        ok: false,
        message: `'${design.id}' has problems that have to be fixed before it can be saved.`,
        hint: 'Nothing was written — the stored design is untouched.',
        issues,
      };
    }
    stored.set(design.id, copy(design));
    return { ok: true, value: copy(design) };
  };

  const missing = (id: string): Outcome<never> =>
    refuse(`There is no design called '${id}'.`, 'Pick one from the design list.');

  const taken = (id: string): Outcome<never> =>
    refuse(`A design called '${id}' already exists.`, 'Choose a different id.');

  return {
    stored,
    calls,

    async list(): Promise<Outcome<DesignSummary[]>> {
      calls.push('list');
      return {
        ok: true,
        value: [...stored.values()]
          .map((design) => ({ id: design.id, label: design.label }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      };
    },

    async load(id): Promise<Outcome<CableDesign>> {
      calls.push(`load:${id}`);
      const design = stored.get(id);
      return design === undefined ? missing(id) : { ok: true, value: copy(design) };
    },

    async save(design): Promise<Outcome<CableDesign>> {
      calls.push(`save:${design.id}`);
      if (!stored.has(design.id)) return missing(design.id);
      return checked(design);
    },

    async create(design): Promise<Outcome<CableDesign>> {
      calls.push(`create:${design.id}`);
      if (stored.has(design.id)) return taken(design.id);
      return checked(design);
    },

    async duplicate(id, newId, newLabel): Promise<Outcome<CableDesign>> {
      calls.push(`duplicate:${id}->${newId}`);
      const source = stored.get(id);
      if (source === undefined) return missing(id);
      if (stored.has(newId)) return taken(newId);
      return checked({
        ...copy(source),
        id: newId,
        label: newLabel,
        src: `${source.src} — duplicated from design '${id}' in the studio workbench.`,
      });
    },

    async rename(id, newId, newLabel): Promise<Outcome<CableDesign>> {
      calls.push(`rename:${id}->${newId}`);
      const source = stored.get(id);
      if (source === undefined) return missing(id);
      if (newId !== id && stored.has(newId)) return taken(newId);
      const result = checked({ ...copy(source), id: newId, label: newLabel });
      if (result.ok && newId !== id) stored.delete(id);
      return result;
    },

    async remove(id, confirm): Promise<Outcome<{ id: string }>> {
      calls.push(`remove:${id}`);
      if (!stored.has(id)) return missing(id);
      if (confirm !== id) {
        return refuse(
          `Deleting '${id}' has to be confirmed.`,
          `Nothing was deleted. Confirm with the design's own id ('${id}').`,
        );
      }
      stored.delete(id);
      return { ok: true, value: { id } };
    },
  };
}
