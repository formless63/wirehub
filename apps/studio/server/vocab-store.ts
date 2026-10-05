/**
 * The vocab and tag stores — the workbench API's door to `data/vocab/*.json`
 * and `data/tags/*` (data model v2 §5).
 *
 * The same split `definition-store.ts` makes: this file is the only one that
 * opens those files, and `vocab.ts` — which holds every rule about what may be
 * written — never imports `node:fs`, so the whole surface is testable with
 * objects in memory.
 *
 * **The tag table is generated.** `data/tags/signal-tags.json`,
 * `instance-slots.json` and `report.md` are what `scripts/tag-signals.ts`
 * makes of the catalog plus the owner's corrections in `review.json`, and
 * `test/tags.test.ts` holds the committed files to exactly that. So a tag set
 * in the Library is written where the generator reads corrections —
 * `review.json` — and the three outputs are rebuilt from it, never patched by
 * hand. `regenerate` is also run after every definition write, because a new
 * pin or a changed label changes what the generator proposes.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  dataPath,
  listVocabIds,
  loadConnectors,
  loadDesigns,
  loadPcbas,
  loadSignalTags,
  loadVocab,
  loadVocabList,
  loadWires,
} from '@wirehub/catalog';
import { buildTags, type TagReview } from '@wirehub/catalog/src/tags/build.ts';
import type { SignalTags, VocabList } from '@wirehub/model';
import { writeFileAtomic } from './atomic-write.ts';
import { derivedPath, localValueFor, readCatalogJson } from './catalog-files.ts';
import type { Awaitable } from './storage/change-set.ts';

const LIST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface VocabStore {
  /** every list id, sorted */
  ids(): Awaitable<string[]>;
  read(list: string): Awaitable<VocabList | undefined>;
  /** replaces the list's file */
  write(list: VocabList): Awaitable<void>;
}

export interface TagStore {
  /** the generated table, as `Db.tags` holds it */
  tags(): Awaitable<SignalTags>;
  review(): Awaitable<TagReview>;
  writeReview(review: TagReview): Awaitable<void>;
  /** rebuild the generated files from the catalog and `review.json`; true when any changed */
  regenerate(): Awaitable<boolean>;
  /**
   * The table `regenerate` would write if `review` were the review file — the
   * derivation run on the stored catalog without writing anything (the unit
   * of work answers a tag PUT with it; the commit then regenerates for real).
   */
  preview?(review: TagReview): Awaitable<SignalTags>;
}

/** 2-space JSON with a trailing newline — the form every catalog file is in. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeIfChanged(relative: string, text: string, path = dataPath(relative)): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  writeFileAtomic(path, text, 'utf8');
  return true;
}

/** A derived file: beside the packs once one is installed (`catalog-files.ts`), else in the catalog. */
function writeDerivedIfChanged(relative: string, text: string): boolean {
  const path = derivedPath(relative);
  mkdirSync(dirname(path), { recursive: true });
  return writeIfChanged(relative, text, path);
}

export function fileVocabStore(): VocabStore {
  return {
    ids: () => listVocabIds(),
    read(list) {
      if (!LIST_ID.test(list) || !listVocabIds().includes(list)) return undefined;
      return loadVocabList(list);
    },
    write(list) {
      // the list id is a file name here: only an existing list can be written
      if (!LIST_ID.test(list.id) || !listVocabIds().includes(list.id)) {
        throw new Error(`'${list.id}' is not a vocab list`);
      }
      // entries a pack supplies unchanged stay in the pack, not in the catalog's list
      const local = localValueFor(`vocab/${list.id}.json`, list);
      if (local !== undefined) writeIfChanged(`vocab/${list.id}.json`, formatJson(local));
    },
  };
}

/** The review decisions: the catalog's own `tags/review.json` with the installed packs' under it (as on pg). */
function reviewOf(): TagReview {
  const review = readCatalogJson<TagReview>('tags/review.json');
  if (review === undefined) throw new Error('the catalog has no tags/review.json');
  return review;
}

export function fileTagStore(): TagStore {
  const build = (review: TagReview): ReturnType<typeof buildTags> =>
    buildTags({
      vocab: loadVocab(),
      connectors: loadConnectors(),
      pcbas: loadPcbas(),
      wires: loadWires(),
      designs: loadDesigns(),
      review,
    });
  return {
    tags: () => loadSignalTags(),
    review: () => reviewOf(),
    writeReview(review) {
      writeIfChanged('tags/review.json', formatJson(review));
    },
    preview(review) {
      return build(review).tags;
    },
    regenerate() {
      const review = reviewOf();
      const out = build(review);
      const a = writeDerivedIfChanged('tags/signal-tags.json', formatJson(out.tags));
      const b = writeDerivedIfChanged('tags/instance-slots.json', formatJson(out.slots));
      const c = writeDerivedIfChanged('tags/report.md', out.report);
      return a || b || c;
    },
  };
}
