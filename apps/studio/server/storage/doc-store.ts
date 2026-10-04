/**
 * Catalog documents by path (`doc` change-set kind): files no dedicated store
 * owns — a module's imported data and reports, the reviewed board maps
 * (`data/kicad-maps/<def>.json`) the artwork editor writes. Paths are
 * relative to the catalog root (`data/…`); JSON is written canonically
 * (`JSON.stringify(v, null, 2) + '\n'`), `.md` / `.txt` as text.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { dataPath } from '@wirehub/catalog';

import { writeFileAtomic } from '../atomic-write.ts';
import { recordWrite } from '../write-journal.ts';
import type { Awaitable } from './change-set.ts';

export interface DocStore {
  /** the document (parsed JSON, or text), or undefined when there is none */
  read(path: string): Awaitable<unknown>;
  write(path: string, value: unknown): Awaitable<void>;
  remove(path: string): Awaitable<void>;
}

const DOC_PATH = /^data\/[A-Za-z0-9._/-]+\.(json|md|txt)$/;

/** A path a doc may live at: under `data/`, no `..`, no dot-files, a JSON / markdown / text name. */
export function isDocPath(path: string): boolean {
  return DOC_PATH.test(path) && !path.split('/').some((s) => s === '..' || s.startsWith('.'));
}

export function formatDoc(path: string, value: unknown): string {
  if (path.endsWith('.json')) return `${JSON.stringify(value, null, 2)}\n`;
  if (typeof value !== 'string') throw new Error(`${path} is a text document; its value must be a string`);
  return value;
}

export function parseDoc(path: string, text: string): unknown {
  return path.endsWith('.json') ? (JSON.parse(text) as unknown) : text;
}

/** The catalog directory as the doc store (`packages/catalog/`, whose `data/` is the live catalog). */
export function fileDocStore(root: string = dataPath('..')): DocStore {
  const base = resolve(root);
  const full = (path: string): string => {
    if (!isDocPath(path)) throw new Error(`'${path}' is not a catalog document path`);
    const out = resolve(join(base, path));
    if (!out.startsWith(base + sep)) throw new Error(`'${path}' escapes the catalog`);
    return out;
  };
  return {
    read(path) {
      const file = full(path);
      return existsSync(file) ? parseDoc(path, readFileSync(file, 'utf8')) : undefined;
    },
    write(path, value) {
      const file = full(path);
      const text = formatDoc(path, value);
      if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, text, 'utf8');
    },
    remove(path) {
      const file = full(path);
      if (existsSync(file)) unlinkSync(file);
      recordWrite(file);
    },
  };
}

/** In memory, for tests. */
export function memoryDocStore(initial: Record<string, unknown> = {}): DocStore & { docs: Map<string, unknown> } {
  const docs = new Map(Object.entries(initial));
  return {
    docs,
    read: (path) => (docs.has(path) ? structuredClone(docs.get(path)) : undefined),
    write: (path, value) => void docs.set(path, structuredClone(value)),
    remove: (path) => void docs.delete(path),
  };
}
