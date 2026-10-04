/**
 * The design store — the workbench API's only door to the filesystem.
 *
 * Two rules live here, and nowhere else:
 *
 * 1. **An id is a slug, never a path.** Every function takes the id through
 *    `designPath`, which refuses anything that is not a kebab-case slug. A
 *    caller cannot reach outside `data/designs/` even by mistake, and the API
 *    layer's own id check is therefore a second lock on the same door rather
 *    than the only one.
 * 2. **Writes are plain JSON files**, 2-space indented with a trailing
 *    newline, so a saved design diffs like the hand-authored ones next to it.
 *
 * Splitting the store out from the handlers is what makes the handlers
 * testable: `api.ts` never imports `node:fs`, it takes a `DesignStore`.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { patchJsonText } from './json-text.ts';

import {
  dataPath,
  isDesignId,
  listDesignIds,
  loadDesign,
  type DesignId,
} from '@cable-studio/catalog';
import type { CableDesign } from '@cable-studio/model';
import { writeFileAtomic } from './atomic-write.ts';
import { recordWrite } from './write-journal.ts';
import type { Awaitable } from './storage/change-set.ts';

/** What a design picker needs: the id and the human name. */
export interface DesignSummary {
  id: DesignId;
  label: string;
}

/**
 * The persistence the API handlers are written against. The dev server binds
 * the filesystem implementation below; the tests bind an in-memory one; a
 * future ERP host binds its own database without touching `api.ts`.
 */
export interface DesignStore {
  /** every design, sorted by id */
  list(): Awaitable<DesignSummary[]>;
  has(id: DesignId): Awaitable<boolean>;
  /** the stored design, or `undefined` when nothing is stored under `id` */
  read(id: DesignId): Awaitable<CableDesign | undefined>;
  /** stores `design` under `id`; `changed` is false when the bytes already said this */
  write(id: DesignId, design: CableDesign): Awaitable<{ changed: boolean }>;
  remove(id: DesignId): Awaitable<void>;
}

/**
 * The canonical on-disk form of a design: 2-space JSON, trailing newline.
 *
 * Key order comes from the document itself, which for a design read off disk
 * and edited is the order the file already had — the studio's edits rebuild
 * lists, never the top-level object.
 */
/** Every stored design, in id order — for the handlers that sweep the catalog. */
export async function readAllDesigns(store: DesignStore): Promise<CableDesign[]> {
  const out: CableDesign[] = [];
  for (const summary of await store.list()) {
    const design = await store.read(summary.id);
    if (design !== undefined) out.push(design);
  }
  return out;
}

export function formatDesignJson(design: CableDesign): string {
  return `${JSON.stringify(design, null, 2)}\n`;
}

/**
 * Absolute path of a design file. **The only place an id becomes a path.**
 * Throws rather than returning something a caller might use anyway.
 */
export function designPath(id: string): string {
  if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
  return dataPath(`designs/${id}.json`);
}

/**
 * The catalog directory, as a store.
 *
 * `write` is deliberately a no-op when the file already states these exact
 * facts. Several catalog designs are hand-formatted (joints on one line,
 * blank lines grouping them) — semantically identical to their canonical form
 * but not byte-identical. Re-saving a design nobody edited must not reflow
 * someone's careful file; only a real change is worth a diff.
 */
export function fileDesignStore(): DesignStore {
  return {
    list(): DesignSummary[] {
      return listDesignIds().map((id) => ({ id, label: loadDesign(id).label }));
    },

    has(id: DesignId): boolean {
      return isDesignId(id) && existsSync(designPath(id));
    },

    read(id: DesignId): CableDesign | undefined {
      const path = designPath(id);
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, 'utf8')) as CableDesign;
    },

    write(id: DesignId, design: CableDesign): { changed: boolean } {
      const path = designPath(id);
      let next = formatDesignJson(design);
      if (existsSync(path)) {
        const current = readFileSync(path, 'utf8');
        if (current === next) return { changed: false };
        try {
          // same facts, different whitespace — leave the author's file alone
          if (isDeepStrictEqual(JSON.parse(current), design)) return { changed: false };
        } catch {
          // a file that will not parse is not worth preserving; the candidate
          // that got here is validated, so overwriting it is an improvement
        }
        // a real change: edit the file's own text, so a hand-formatted design
        // diffs as the change and not as a reflow (50a.12)
        next = patchJsonText(current, design);
      }
      writeFileAtomic(path, next, 'utf8');
      return { changed: true };
    },

    remove(id: DesignId): void {
      const path = designPath(id);
      if (existsSync(path)) unlinkSync(path);
      recordWrite(path);
    },
  };
}
