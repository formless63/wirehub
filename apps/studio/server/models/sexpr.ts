/**
 * A small S-expression reader for KiCad's `.kicad_pcb`
 * — enough for the model import to read footprint placements, the Edge.Cuts
 * outline and embedded model files. Pure: text in, nested lists out.
 *
 * Tokens: `(` `)`, quoted strings (`"…"` with backslash escapes), KiCad's
 * `|…|` blobs (base64 of an embedded file), and bare atoms. Every string and
 * atom comes back as a string; a list is an array whose first item is its
 * head (`footprint`, `at`, `model`, …).
 */

export type SExpr = string | SExpr[];

export function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    // whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i += 1;
      continue;
    }
    if (c === 40 /* ( */) {
      const list: SExpr[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i += 1;
      continue;
    }
    if (c === 41 /* ) */) {
      if (stack.length === 1) throw new Error(`unbalanced ')' at ${i}`);
      stack.pop();
      i += 1;
      continue;
    }
    if (c === 34 /* " */) {
      let out = '';
      let j = i + 1;
      while (j < n && text.charCodeAt(j) !== 34) {
        if (text.charCodeAt(j) === 92 /* \ */ && j + 1 < n) {
          const next = text[j + 1]!;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          out += text[j]!;
          j += 1;
        }
      }
      if (j >= n) throw new Error(`unterminated string at ${i}`);
      stack[stack.length - 1]!.push(out);
      i = j + 1;
      continue;
    }
    if (c === 124 /* | */) {
      const end = text.indexOf('|', i + 1);
      if (end < 0) throw new Error(`unterminated |blob| at ${i}`);
      stack[stack.length - 1]!.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 40 || d === 41) break;
      j += 1;
    }
    stack[stack.length - 1]!.push(text.slice(i, j));
    i = j;
  }
  if (stack.length !== 1) throw new Error('unbalanced: a list is never closed');
  return root;
}

/** The head of a list (`footprint` for `(footprint "…" …)`). */
export function head(expr: SExpr): string | undefined {
  return Array.isArray(expr) && typeof expr[0] === 'string' ? expr[0] : undefined;
}

/** Child lists of `expr` whose head is `name`. */
export function children(expr: SExpr, name: string): SExpr[][] {
  if (!Array.isArray(expr)) return [];
  return expr.filter((child): child is SExpr[] => Array.isArray(child) && child[0] === name);
}

/** The first child list named `name`. */
export function child(expr: SExpr, name: string): SExpr[] | undefined {
  return children(expr, name)[0];
}

/** The numbers after the head: `(at 10 20 90)` → `[10, 20, 90]`. */
export function numbers(expr: SExpr[] | undefined): number[] {
  if (expr === undefined) return [];
  return expr.slice(1).filter((x): x is string => typeof x === 'string' && x !== '' && Number.isFinite(Number(x))).map(Number);
}

/** The first string after the head: `(layer "F.Cu")` → `F.Cu`. */
export function atom(expr: SExpr[] | undefined, index = 1): string | undefined {
  const value = expr?.[index];
  return typeof value === 'string' ? value : undefined;
}
