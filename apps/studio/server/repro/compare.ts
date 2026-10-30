/**
 * Compare two runs of the same tool op (a recorded run and its re-run): which outputs are
 * byte-identical, which differ (by sha256, with sizes, and for text a count of differing lines),
 * which are only on one side, and whether the tool identity or the inputs moved between them.
 * Pure: the bytes of text outputs are handed in by the caller.
 */

import type { ToolRunRecord } from '../tools/outputs.ts';
import type { InsideCompare } from './inside.ts';

export type FileState = 'same' | 'differs' | 'added' | 'removed';

export interface FileSide {
  sha256: string;
  size: number;
  href: string;
}

export interface FileCompare {
  path: string;
  role: string;
  mediaType: string;
  state: FileState;
  a?: FileSide;
  b?: FileSide;
  /** a picture both runs made: the page can lay one over the other */
  visual?: boolean;
  /** text outputs that differ: how many lines, and the first few that differ */
  text?: { lines: number; differing: number; sample: { line: number; a: string; b: string }[]; onlyTimes?: boolean };
  /** a zip or GLB that differs: compared member by member (`inside.ts`) */
  inside?: InsideCompare;
}

export type TextDiff = ReturnType<typeof lineDiff>;

export interface IdentityChange {
  field: 'image' | 'tool' | 'pack' | 'sources' | 'params' | 'status';
  a: string;
  b: string;
}

export interface RunCompare {
  a: string;
  b: string;
  /** `same-but-times`: every difference is a text line carrying a date, time or run duration (inside zips and GLBs too) */
  verdict: 'identical' | 'same-but-times' | 'differs';
  same: number;
  total: number;
  files: FileCompare[];
  /** what was not the same about how the two runs were made (empty for a faithful re-run) */
  changes: IdentityChange[];
}

const href = (sha: string): string => `/api/blobs/${sha}`;
const VISUAL = new Set(['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp']);
/** media types worth a line count (STEP, G-code, Gerber, SVG, JSON …) */
export function isTextual(mediaType: string, path: string): boolean {
  return mediaType.startsWith('text/') || /json|xml|svg|step|gcode/.test(mediaType) || /\.(txt|csv|json|svg|step|stp|gcode|gbr|g[tbm][los]|drl|kicad_\w+|net|xml|ini|scad|gbrjob|model|rels)$/i.test(path);
}
/** the largest text output read for a line count */
export const TEXT_DIFF_MAX = 32 * 1024 * 1024;

const stable = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1))) : v));

/** params minus what is only bookkeeping (the request hash moves when only the bookkeeping does) */
function paramsOf(run: ToolRunRecord): string {
  const { requestSha256: _r, ...rest } = run.params as Record<string, unknown>;
  return stable(rest);
}

/** keys whose values name when or how long (a tool's creation stamp, a run's duration): expected to move between runs */
const TIME_KEYS = /^(seconds|durationMs|duration|elapsed\w*|createdAt|generatedAt|timestamp|time|date)$/;
/** the tokens that name when or how long: a date-time stamp, a clock time, a timed key's JSON value */
const TIME_TOKENS = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
  /("(?:seconds|durationMs|duration|elapsed\w*|createdAt|generatedAt|timestamp)"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
];

/** The line with only its time tokens masked: what must still be equal for a change to be "only times". */
export function maskTimes(line: string): string {
  let out = line;
  for (const re of TIME_TOKENS) out = out.replace(re, (_m, key?: string) => (typeof key === 'string' ? `${key}"<time>"` : '<time>'));
  return out;
}

const ISO_STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}([.,]\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** a parsed JSON value with timed keys and date-time strings masked */
function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (typeof value === 'string') return ISO_STAMP.test(value) ? '<time>' : value;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, TIME_KEYS.test(k) ? '<time>' : maskJson(v)]));
}

/** Whether two JSON texts differ only in their timed values (undefined: not both JSON). */
export function jsonOnlyTimes(a: string, b: string): boolean | undefined {
  try {
    return stable(maskJson(JSON.parse(a))) === stable(maskJson(JSON.parse(b)));
  } catch {
    return undefined;
  }
}

export function lineDiff(a: string, b: string, sampleMax = 3): { lines: number; differing: number; sample: { line: number; a: string; b: string }[]; onlyTimes: boolean } {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  const n = Math.max(la.length, lb.length);
  let differing = 0;
  let onlyTimes = true;
  const sample: { line: number; a: string; b: string }[] = [];
  const cut = (s: string | undefined): string => (s === undefined ? '' : s.length > 160 ? `${s.slice(0, 160)}…` : s);
  for (let i = 0; i < n; i++) {
    if (la[i] === lb[i]) continue;
    differing += 1;
    // a stamp on the line moves; everything else on it must not
    if (onlyTimes && (la[i] === undefined || lb[i] === undefined || maskTimes(la[i]!) !== maskTimes(lb[i]!))) onlyTimes = false;
    if (sample.length < sampleMax) sample.push({ line: i + 1, a: cut(la[i]), b: cut(lb[i]) });
  }
  // a JSON file is judged on its parsed values with the timed ones masked (a compact file is one line)
  if (differing > 0 && /^\s*[[{]/.test(a) && /^\s*[[{]/.test(b)) onlyTimes = jsonOnlyTimes(a, b) ?? onlyTimes;
  return { lines: n, differing, sample, onlyTimes: differing > 0 && onlyTimes };
}

export function compareRuns(a: ToolRunRecord, b: ToolRunRecord, texts?: (sha: string) => string | undefined, inside?: (a: string, b: string) => InsideCompare | undefined): RunCompare {
  const byPath = (run: ToolRunRecord) => new Map(run.outputs.map((o) => [o.path, o]));
  const left = byPath(a);
  const right = byPath(b);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const files: FileCompare[] = paths.map((path) => {
    const x = left.get(path);
    const y = right.get(path);
    const meta = (y ?? x)!;
    const side = (o: typeof x): FileSide | undefined => (o === undefined ? undefined : { sha256: o.sha256, size: o.size, href: href(o.sha256) });
    const state: FileState = x === undefined ? 'added' : y === undefined ? 'removed' : x.sha256 === y.sha256 ? 'same' : 'differs';
    const out: FileCompare = { path, role: meta.role, mediaType: meta.mediaType, state, ...(x === undefined ? {} : { a: side(x)! }), ...(y === undefined ? {} : { b: side(y)! }) };
    if (state === 'differs' && VISUAL.has(meta.mediaType)) out.visual = true;
    if (state === 'differs' && texts !== undefined && isTextual(meta.mediaType, path)) {
      const ta = texts(x!.sha256);
      const tb = texts(y!.sha256);
      if (ta !== undefined && tb !== undefined) out.text = lineDiff(ta, tb);
    }
    if (state === 'differs' && inside !== undefined) {
      const found = inside(x!.sha256, y!.sha256);
      if (found !== undefined) out.inside = found;
    }
    return out;
  });
  const changes: IdentityChange[] = [];
  const note = (field: IdentityChange['field'], x: string, y: string): void => {
    if (x !== y) changes.push({ field, a: x, b: y });
  };
  note('image', a.imageId, b.imageId);
  note('tool', `${a.tool.name} ${a.tool.version}`, `${b.tool.name} ${b.tool.version}`);
  note('pack', `${a.pack} ${a.packVersion}`, `${b.pack} ${b.packVersion}`);
  note('sources', a.sources.map((s) => s.sha256).sort().join(','), b.sources.map((s) => s.sha256).sort().join(','));
  note('params', paramsOf(a), paramsOf(b));
  note('status', a.status, b.status);
  const same = files.filter((f) => f.state === 'same').length;
  const verdict = same === files.length && a.status === b.status ? 'identical'
    : a.status === b.status && changes.length === 0 && files.every((f) => f.state === 'same' || (f.state === 'differs' && (f.text?.onlyTimes === true || f.inside?.onlyTimes === true))) ? 'same-but-times' : 'differs';
  return { a: a.id, b: b.id, verdict, same, total: files.length, files, changes };
}
