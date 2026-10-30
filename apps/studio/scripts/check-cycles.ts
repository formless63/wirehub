/**
 * Import-cycle check for server code. Two merges broke vitest's config load with runtime cycles
 * through `server/api.ts` (`init_api is not a function`). Type-only and dynamic imports are
 * ignored (no load-time edge). Cycles that exist today are a baseline in KNOWN: the check fails
 * on any NEW cycle or when a known one grows (a new member joins it). Shrink KNOWN as they are
 * broken. The api.ts cycle is gone: `publishCatalog`/`commitUnit` live in
 * `catalog-commit.ts`, the import job reaches the router lazily, and the tool-stage runners take
 * `cancelSignal`/`toolStageAvailability` from their own files, not the registry that imports them.
 *
 * Run: pnpm --filter studio check:cycles
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../server');
/** cycles not involving api.ts that are tolerated, as sorted member lists joined by ' | ' */
const KNOWN = new Set<string>([
  'documents.ts | effective-inputs.ts | render/depictions.ts | representations.ts | versions.ts',
]);

const files: string[] = [];
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); } else if (/\.tsx?$/.test(name)) files.push(p);
  }
};
walk(ROOT);

const IMPORT = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"](\.[^'"]+)['"]|^\s*import\s*\(\s*['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]/gm;
const graph = new Map<string, string[]>();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(IMPORT)) {
    if (m[2] !== undefined) continue; // import type / export type
    if (m[5] !== undefined) continue; // dynamic import: lazy, not a load-time cycle
    const spec = m[4] ?? m[6];
    if (spec === undefined) continue;
    const clause = m[3] ?? '';
    // `import { type A, type B }` only: erased
    if (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}]/g, '').split(',').every((s) => s.trim() === '' || s.trim().startsWith('type '))) continue;
    const target = resolve(dirname(f), spec);
    const hit = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')].find((c) => graph.has(c) || files.includes(c));
    if (hit !== undefined) out.add(hit);
  }
  graph.set(f, [...out]);
}

// Tarjan SCC
let index = 0;
const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
const sccs: string[][] = [];
const connect = (v: string): void => {
  idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) { connect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
    else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
  }
  if (low.get(v) === idx.get(v)) {
    const c: string[] = [];
    let w: string;
    do { w = stack.pop()!; on.delete(w); c.push(w); } while (w !== v);
    if (c.length > 1 || (graph.get(v) ?? []).includes(v)) sccs.push(c);
  }
};
for (const f of graph.keys()) if (!idx.has(f)) connect(f);

let bad = 0;
for (const c of sccs) {
  const names = c.map((f) => relative(ROOT, f)).sort();
  const key = names.join(' | ');
  if (!KNOWN.has(key)) { bad++; console.error(`${names.includes('api.ts') ? 'new/grown cycle through api.ts' : 'new import cycle'}: ${key}`); }
  else console.log(`known cycle: ${key}`);
}
if (bad > 0) process.exit(1);
console.log(`import cycles: none new (${files.length} server files checked)`);
