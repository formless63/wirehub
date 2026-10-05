/**
 * A field diff of two catalog records — the base's generic compare
 * (cs-5k1.21). Pure: two JSON-like values in, rows out.
 *
 * Records are flattened to dotted paths; an array of objects that each carry a
 * string `id` is keyed by those ids (`pins[3].label`) so a reordered or
 * inserted pin does not shift every row after it, any other array by index.
 */

import type { Db } from '@wirehub/model';

import type { LibraryKind } from './definitions.ts';

export type DiffStatus = 'same' | 'changed' | 'only-a' | 'only-b';

export interface DiffRow {
  path: string;
  /** the value in the first record, as text; absent when only the second has the field */
  a?: string;
  b?: string;
  status: DiffStatus;
}

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keyedById = (v: Json[]): v is Record<string, Json>[] => v.length > 0 && v.every((x) => isObject(x) && typeof x['id'] === 'string');

function flatten(value: Json, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, '[]');
    else if (keyedById(value)) for (const item of value) flatten(item, `${path}[${String(item['id'])}]`, out);
    else value.forEach((item, i) => flatten(item, `${path}[${i}]`, out));
    return;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(path, '{}');
    for (const key of keys) flatten(value[key], path === '' ? key : `${path}.${key}`, out);
    return;
  }
  out.set(path, typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined');
}

/** Every field of either record, in the first record's order then the second's extras, with whether it differs. */
export function diffRecords(a: Json, b: Json): DiffRow[] {
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  flatten(a, '', left);
  flatten(b, '', right);
  const paths = [...left.keys(), ...[...right.keys()].filter((p) => !left.has(p))];
  return paths.map((path) => {
    const x = left.get(path);
    const y = right.get(path);
    const status: DiffStatus = x === undefined ? 'only-b' : y === undefined ? 'only-a' : x === y ? 'same' : 'changed';
    return { path, ...(x === undefined ? {} : { a: x }), ...(y === undefined ? {} : { b: y }), status };
  });
}

/** The record `kind`/`id` of the library, or `undefined`. */
export function libraryRecord(db: Db, kind: string, id: string): unknown {
  const list: readonly { id?: string; sku?: string }[] | undefined = (
    {
      connectors: db.connectors,
      components: db.components,
      wires: db.wires,
      pcbas: db.pcbas,
      mechanicals: db.mechanicals,
      kits: db.kits,
    } as Record<string, readonly { id?: string; sku?: string }[] | undefined>
  )[kind];
  return list?.find((r) => (r.id ?? r.sku) === id);
}

/** The ids of the records of `kind`, for the second pick. */
export function libraryRecordIds(db: Db, kind: LibraryKind | string): { id: string; label: string }[] {
  const list = (
    {
      connectors: db.connectors,
      components: db.components,
      wires: db.wires,
      pcbas: db.pcbas,
      mechanicals: db.mechanicals,
      kits: db.kits,
    } as Record<string, readonly { id?: string; sku?: string; label: string }[] | undefined>
  )[kind];
  return (list ?? []).map((r) => ({ id: (r.id ?? r.sku) as string, label: r.label }));
}
