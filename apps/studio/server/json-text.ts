/**
 * Minimal-diff JSON writes.
 *
 * Many catalog files are hand-formatted: a design's joints one per line and
 * grouped by blank lines, a connector's pins as one-line objects. Writing
 * `JSON.stringify(value, null, 2)` reflows the whole file on its first GUI
 * save — a large diff that buries the one field that changed. `patchJsonText`
 * instead edits the file's own text: members and elements whose value did
 * not change keep their bytes (and the whitespace around them), a changed
 * scalar is replaced where it stands, a changed object or array is patched
 * recursively, and only what is new is rendered — in the style of its
 * neighbours (one line when they are one line, 2-space blocks otherwise).
 * The same surgical approach the catalog's migration scripts use
 * (`packages/catalog/scripts/design-rewrite.ts`, `adopt-recipes.ts`), made
 * general.
 *
 * Safety: the result is parsed and compared with the intended value; any
 * mismatch (or a file that does not parse) falls back to the canonical form,
 * so the worst case is the old behaviour, never a wrong file.
 */

import { isDeepStrictEqual } from 'node:util';

/** The canonical form: 2-space JSON with a trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface Node {
  start: number;
  end: number;
  kind: 'object' | 'array' | 'scalar';
  /** arrays: the elements */
  items?: Node[];
  /** objects: the members, in file order; `keyStart` is where the key's quote is */
  members?: { key: string; keyStart: number; value: Node }[];
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/** Parse `text` into value spans. Assumes valid JSON (the caller parsed it first). */
function scan(text: string): Node {
  let i = 0;
  const skip = (): void => {
    while (isWs(text[i])) i += 1;
  };
  const value = (): Node => {
    skip();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i += 1;
      const members: { key: string; keyStart: number; value: Node }[] = [];
      skip();
      while (text[i] !== '}') {
        const keyStart = i;
        const key = str();
        skip();
        i += 1; // ':'
        const v = value();
        members.push({ key, keyStart, value: v });
        skip();
        if (text[i] === ',') i += 1;
        skip();
      }
      i += 1;
      return { start, end: i, kind: 'object', members };
    }
    if (c === '[') {
      i += 1;
      const items: Node[] = [];
      skip();
      while (text[i] !== ']') {
        items.push(value());
        skip();
        if (text[i] === ',') i += 1;
        skip();
      }
      i += 1;
      return { start, end: i, kind: 'array', items };
    }
    if (c === '"') {
      str();
      return { start, end: i, kind: 'scalar' };
    }
    while (i < text.length && !isWs(text[i]) && text[i] !== ',' && text[i] !== ']' && text[i] !== '}') i += 1;
    return { start, end: i, kind: 'scalar' };
  };
  const str = (): string => {
    const start = i;
    i += 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  return value();
}

/** `{ "a": 1, "b": [2, 3] }` — the one-line house style. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

function block(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

const oneLine = (text: string, node: { start: number; end: number }): boolean => !text.slice(node.start, node.end).includes('\n');

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Render a value that has no text yet, beside siblings written in `compact` style. */
function fresh(value: unknown, compact: boolean, indent: string): string {
  return compact ? inline(value) : block(value, indent);
}

/** The new text for `node` (whose current value is `before`) so that it states `after`. */
function patch(text: string, node: Node, before: unknown, after: unknown): string {
  const original = text.slice(node.start, node.end);
  if (isDeepStrictEqual(before, after)) return original;
  if (node.kind === 'object' && isObject(before) && isObject(after)) return patchObject(text, node, after);
  if (node.kind === 'array' && Array.isArray(before) && Array.isArray(after)) return patchArray(text, node, before, after);
  // a scalar, or a change of type: render it where it stands
  return fresh(after, oneLine(text, node) || (!isObject(after) && !Array.isArray(after)), indentAt(text, node.start));
}

function patchObject(text: string, node: Node, after: Record<string, unknown>): string {
  const members = node.members ?? [];
  const before = JSON.parse(text.slice(node.start, node.end)) as Record<string, unknown>;
  const compact = oneLine(text, node);
  if (members.length === 0) {
    // `{}` has no style to follow
    return compact && Object.keys(after).length <= 3 ? inline(after) : block(after, indentAt(text, node.start));
  }
  const kept = members.filter((m) => m.key in after && after[m.key] !== undefined);
  const added = Object.keys(after).filter((k) => after[k] !== undefined && !members.some((m) => m.key === k));
  const first = members[0]!;
  const last = members[members.length - 1]!;
  // whitespace between `{` and the first key, and between members
  const lead = text.slice(node.start + 1, first.keyStart);
  const trail = text.slice(last.value.end, node.end - 1);
  const sepBetween = members.length > 1 ? text.slice(members[0]!.value.end, members[1]!.keyStart) : `,${lead}`;
  const memberIndent = compact ? '' : indentAt(text, first.keyStart);

  const pieces: string[] = [];
  const seps: string[] = [];
  for (const m of kept) {
    const index = members.indexOf(m);
    if (pieces.length > 0) {
      // the author's separator before this member (a blank line, say)
      seps.push(index > 0 ? text.slice(members[index - 1]!.value.end, m.keyStart) : sepBetween);
    }
    const keyText = text.slice(m.keyStart, m.value.start);
    pieces.push(`${keyText}${patch(text, m.value, before[m.key], after[m.key])}`);
  }
  for (const key of added) {
    if (pieces.length > 0) seps.push(sepBetween);
    pieces.push(`${JSON.stringify(key)}: ${fresh(after[key], compact, memberIndent)}`);
  }
  if (pieces.length === 0) return '{}';
  let body = pieces[0]!;
  for (let i = 1; i < pieces.length; i += 1) body += seps[i - 1]! + pieces[i]!;
  return `{${lead}${body}${trail}}`;
}

/** Longest common subsequence of two string lists, as index pairs. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [];
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return out;
}

function patchArray(text: string, node: Node, before: unknown[], after: unknown[]): string {
  const items = node.items ?? [];
  if (items.length === 0) {
    return after.length === 0 ? '[]' : block(after, indentAt(text, node.start));
  }
  const compactArray = oneLine(text, node);
  // a new element is written like its neighbours: one line when they all are
  const compactItems = items.every((item) => oneLine(text, item));
  const itemIndent = compactArray ? '' : indentAt(text, items[0]!.start);
  const lead = text.slice(node.start + 1, items[0]!.start);
  const trail = text.slice(items[items.length - 1]!.end, node.end - 1);
  const sepBetween = items.length > 1 ? text.slice(items[0]!.end, items[1]!.start) : compactArray ? ', ' : `,\n${itemIndent}`;

  // match unchanged elements; the gaps between matches pair up positionally
  // (an edited element) and the rest are removals or additions
  const key = (v: unknown): string => JSON.stringify(v);
  const matches = lcs(before.map(key), after.map(key));
  /** for each new element: the original element it keeps or patches, if any */
  const source: (number | undefined)[] = after.map(() => undefined);
  let pi = 0;
  let pj = 0;
  for (const [mi, mj] of [...matches, [before.length, after.length] as [number, number]]) {
    const gap = Math.min(mi - pi, mj - pj);
    for (let g = 0; g < gap; g += 1) source[pj + g] = pi + g;
    if (mj < after.length) source[mj] = mi;
    pi = mi + 1;
    pj = mj + 1;
  }

  const pieces: string[] = [];
  const seps: string[] = [];
  after.forEach((value, j) => {
    const from = source[j];
    if (pieces.length > 0) {
      // the separator that stood before this element in the file (a blank
      // line opening a group survives its neighbour being removed)
      seps.push(from !== undefined && from > 0 ? text.slice(items[from - 1]!.end, items[from]!.start) : sepBetween);
    }
    pieces.push(from === undefined ? fresh(value, compactItems, itemIndent) : patch(text, items[from]!, before[from], value));
  });
  if (pieces.length === 0) return '[]';
  let body = pieces[0]!;
  for (let i = 1; i < pieces.length; i += 1) body += seps[i - 1]! + pieces[i]!;
  return `[${lead}${body}${trail}]`;
}

/**
 * `current` edited so that it states `next`, keeping the text of everything
 * that did not change. Returns `current` itself when nothing did.
 */
export function patchJsonText(current: string, next: unknown): string {
  let before: unknown;
  try {
    before = JSON.parse(current);
  } catch {
    return canonicalJson(next);
  }
  if (isDeepStrictEqual(before, next)) return current;
  try {
    const root = scan(current);
    const lead = current.slice(0, root.start);
    const tail = current.slice(root.end);
    const result = `${lead}${patch(current, root, before, next)}${tail}`;
    // `next` may carry `undefined` members JSON drops; compare as JSON sees it
    if (isDeepStrictEqual(JSON.parse(result), JSON.parse(JSON.stringify(next)))) return result;
  } catch {
    // fall through to the canonical form
  }
  return canonicalJson(next);
}
