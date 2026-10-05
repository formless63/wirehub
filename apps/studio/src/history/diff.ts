/**
 * A field-level diff of two JSON documents — what the History panel shows
 * for one part of one record (cs-5k1.4). Pure and deterministic; shared by
 * the browser and the server's tests.
 *
 * - Objects compare key by key: `label`, `instances.connectors`.
 * - Arrays of objects that all carry a unique string `id` compare by id:
 *   `instances.connectors[j1].def`, so inserting one part does not show every
 *   later one as changed.
 * - Other arrays (joints, pins by position, notes) compare as multisets: what
 *   is only in the old list is removed, what is only in the new one added
 *   (`joints[−]`, `joints[+]`); the same items in another order is one
 *   `reordered` line.
 */

export interface FieldChange {
  /** dotted path; `[id]` for a keyed array item, `[+]`/`[−]` for an unkeyed one */
  path: string;
  op: 'added' | 'removed' | 'changed' | 'reordered';
  before?: unknown;
  after?: unknown;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Canonical text of a value (object keys sorted), for multiset comparison. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function keyedById(items: readonly unknown[]): Map<string, unknown> | undefined {
  if (items.length === 0) return undefined;
  const out = new Map<string, unknown>();
  for (const item of items) {
    if (!isObject(item) || typeof item['id'] !== 'string' || out.has(item['id'])) return undefined;
    out.set(item['id'], item);
  }
  return out;
}

const join = (base: string, key: string): string => (base === '' ? key : `${base}.${key}`);

function walk(path: string, before: unknown, after: unknown, out: FieldChange[]): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined) {
    out.push({ path, op: 'added', after });
    return;
  }
  if (after === undefined) {
    out.push({ path, op: 'removed', before });
    return;
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) walk(join(path, key), before[key], after[key], out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(path, before, after, out);
    return;
  }
  if (canonical(before) !== canonical(after)) out.push({ path, op: 'changed', before, after });
}

function diffArray(path: string, before: unknown[], after: unknown[], out: FieldChange[]): void {
  const a = keyedById(before);
  const b = keyedById(after);
  // both keyed, or one side empty and the other keyed
  if ((a !== undefined || before.length === 0) && (b !== undefined || after.length === 0) && (a !== undefined || b !== undefined)) {
    const ids = [...new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])])];
    for (const id of ids) walk(`${path}[${id}]`, a?.get(id), b?.get(id), out);
    const order = (m: Map<string, unknown> | undefined): string[] => [...(m?.keys() ?? [])];
    const common = order(a).filter((id) => b?.has(id) === true);
    const commonAfter = order(b).filter((id) => a?.has(id) === true);
    if (common.join('\u0000') !== commonAfter.join('\u0000')) out.push({ path, op: 'reordered' });
    return;
  }
  // unkeyed: a multiset
  const counts = new Map<string, { item: unknown; n: number }>();
  for (const item of before) {
    const k = canonical(item);
    const seen = counts.get(k);
    counts.set(k, { item, n: (seen?.n ?? 0) + 1 });
  }
  const added: unknown[] = [];
  for (const item of after) {
    const k = canonical(item);
    const seen = counts.get(k);
    if (seen !== undefined && seen.n > 0) seen.n -= 1;
    else added.push(item);
  }
  const removed: unknown[] = [];
  for (const { item, n } of counts.values()) for (let i = 0; i < n; i += 1) removed.push(item);
  for (const item of removed) out.push({ path: `${path}[−]`, op: 'removed', before: item });
  for (const item of added) out.push({ path: `${path}[+]`, op: 'added', after: item });
  if (removed.length === 0 && added.length === 0 && before.map(canonical).join('\u0000') !== after.map(canonical).join('\u0000')) {
    out.push({ path, op: 'reordered' });
  }
}

/** Every field that differs between `before` and `after` (either may be `undefined`: added / removed whole). */
export function fieldDiff(before: unknown, after: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  if (before === undefined || after === undefined) {
    walk('', before, after, out);
    return out.map((c) => (c.path === '' ? { ...c, path: '(whole record)' } : c));
  }
  walk('', before as Json, after as Json, out);
  return out;
}

/** A value as one short line, for a diff row. */
export function preview(value: unknown, max = 120): string {
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? JSON.stringify(value) : canonical(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The top-level fields a change touched — the one-line summary of a history row. */
export function changedFields(before: unknown, after: unknown, max = 6): string[] {
  const top = [...new Set(fieldDiff(before, after).map((c) => c.path.split(/[.[]/)[0] ?? c.path))];
  return top.length > max ? [...top.slice(0, max), `+${top.length - max} more`] : top;
}
