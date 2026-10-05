/**
 * Declarative part-number schemes.
 *
 * A numbering scheme written as data, not code: a template that lays out
 * segments (`{level}{type}-{seq}-{variant}`), and for each segment what it may
 * hold. It compiles to a `PartNumberScheme` (`part-numbers.ts`), so proposals,
 * the part-number health report and the duplicate checks work with it exactly
 * as with the built-in prefix scheme. Settings edits it, a data pack ships it
 * (`wirehub-pack.json` `partNumberScheme`), and `part-numbers.json` stores it.
 *
 * ```json
 * {
 *   "type": "declarative",
 *   "id": "level-type-seq",
 *   "label": "Level + type, sequence, variant",
 *   "template": "{level}{type}-{seq}-{variant}",
 *   "segments": [
 *     { "id": "level", "type": "choice", "values": [{ "value": "1", "label": "Part", "kinds": ["connector", "wire"] }, { "value": "2", "label": "Assembly", "kinds": ["design"] }] },
 *     { "id": "type", "type": "choice", "values": [{ "value": "C", "kinds": ["connector"] }, { "value": "W", "kinds": ["wire"] }, { "value": "A", "kinds": ["design"] }] },
 *     { "id": "seq", "type": "counter", "width": 6, "per": ["level", "type"], "ranges": [{ "from": 1, "to": 999999 }] },
 *     { "id": "variant", "type": "variant", "width": 2, "style": "numeric", "first": "00" }
 *   ],
 *   "validation": { "regex": "^[12][A-Z]-\\d{6}-\\d{2}$" },
 *   "immutable": true
 * }
 * ```
 *
 * Bounded and safe: a template of at most 200 characters, 12 segments, no
 * code, and a validation regex that is length-limited, refused when it has
 * nested quantifiers, backreferences or lookbehind, and only ever run against
 * strings of at most 64 characters. Pure and deterministic.
 */

import { PN_KINDS, type KnownPartNumber, type PartNumberScheme, type PnIssue, type PnKind, type PnSubject, type PnSuggestion } from './part-numbers.ts';

/* ------------------------------------------------------------------ *
 * The definition
 * ------------------------------------------------------------------ */

export interface ChoiceValue {
  value: string;
  label?: string;
  /** the record kinds that may carry this value; absent: any kind */
  kinds?: PnKind[];
}

export interface ChoiceSegment {
  id: string;
  type: 'choice';
  label?: string;
  values: ChoiceValue[];
  /** the value proposed for a kind no value names (absent: such a kind is not numbered) */
  default?: string;
}

/** One span of numbers, both ends included. */
export interface CounterSpan {
  from: number;
  to: number;
}

/** A number or a span of numbers a counter never issues. */
export type CounterExclusion = number | CounterSpan;

/** One combination (or set of combinations) of segment values: segment id → one value or several. */
export type CounterMatch = Record<string, string | string[]>;

/**
 * The range one combination of segment values counts in.
 *
 * `from`/`to` give one span; `spans` give several disjoint ones (a union: the
 * counter may use any of them). `match` is one set of combinations, or a list
 * of them (any one matching counts), so `(level 1, type C)` and `(level 2,
 * type A)` can share a range without also matching `(1, A)`.
 */
export interface CounterRange {
  /** which combinations; absent matches every combination */
  match?: CounterMatch | CounterMatch[];
  from?: number;
  to?: number;
  /** several disjoint spans instead of from/to */
  spans?: CounterSpan[];
  /** numbers never issued in this range */
  exclude?: CounterExclusion[];
}

/** The numbers one combination may use: spans (a union, sorted) minus exclusions. */
interface Allowed {
  spans: CounterSpan[];
  exclude: CounterSpan[];
}

export interface CounterSegment {
  id: string;
  type: 'counter';
  label?: string;
  /** zero-padded digits */
  width: number;
  /** the choice segments one counter runs per; absent: every choice segment */
  per?: string[];
  /** the first match sets the combination's range; none matching: 1 to the largest `width` digits hold */
  ranges?: CounterRange[];
  /** numbers never issued by this counter, in any combination (a reserved block, an unlucky number) */
  exclude?: CounterExclusion[];
}

export interface VariantSegment {
  id: string;
  type: 'variant';
  label?: string;
  /** `numeric` 00, 01 … or `alpha` A, B … AA */
  style: 'numeric' | 'alpha';
  /** digits (numeric) or letters (alpha) at most */
  width: number;
  /** the variant a brand-new part gets (default: the first of the style: 00 or A) */
  first?: string;
  /** the highest variant a part may reach (default: the largest `width` holds) */
  max?: string;
  /** the template may leave this segment (and the group around it) out */
  optional?: boolean;
  /** the kinds that carry variants; absent: all */
  kinds?: PnKind[];
}

export type SchemeSegment = ChoiceSegment | CounterSegment | VariantSegment;

export interface DeclarativeSchemeConfig {
  type: 'declarative';
  id?: string;
  label?: string;
  /** `{id}` places a segment, `[ … ]` an optional group, anything else is a literal separator */
  template: string;
  segments: SchemeSegment[];
  validation?: { regex?: string; message?: string };
  /** existing numbers never change: a saved number cannot be edited to another, and switching schemes never rewrites one */
  immutable?: boolean;
  src?: string;
}

export const MAX_SEGMENTS = 12;
export const MAX_TEMPLATE_LENGTH = 200;
const MAX_CHOICE_VALUES = 200;
const MAX_RANGES = 100;
const MAX_SPANS = 100;
const MAX_MATCHES = 50;
const MAX_REGEX_LENGTH = 200;
/** a number longer than this is never matched (bounds every regex run) */
const MAX_PN_LENGTH = 64;
const ID = /^[a-z][a-z0-9-]{0,31}$/;

export function isDeclarativeSchemeConfig(json: unknown): json is DeclarativeSchemeConfig {
  return typeof json === 'object' && json !== null && !Array.isArray(json) && ((json as Record<string, unknown>)['type'] === 'declarative' || 'template' in (json as object));
}

/* ------------------------------------------------------------------ *
 * Template
 * ------------------------------------------------------------------ */

type Token = { literal: string } | { field: string } | { group: Token[] };

function parseTemplate(template: string, problems: string[]): Token[] {
  let i = 0;
  const read = (inGroup: boolean): Token[] => {
    const out: Token[] = [];
    let literal = '';
    const flush = (): void => {
      if (literal !== '') out.push({ literal });
      literal = '';
    };
    while (i < template.length) {
      const c = template[i] as string;
      if (c === '{') {
        const end = template.indexOf('}', i);
        if (end === -1) {
          problems.push('template: a { has no closing }');
          i = template.length;
          break;
        }
        flush();
        out.push({ field: template.slice(i + 1, end) });
        i = end + 1;
      } else if (c === '[') {
        if (inGroup) problems.push('template: optional groups [ ] cannot nest');
        i += 1;
        flush();
        out.push({ group: read(true) });
      } else if (c === ']') {
        if (!inGroup) problems.push('template: a ] has no opening [');
        i += 1;
        flush();
        return out;
      } else {
        literal += c;
        i += 1;
      }
    }
    if (inGroup) problems.push('template: a [ has no closing ]');
    flush();
    return out;
  };
  return read(false);
}

function fieldsOf(tokens: readonly Token[]): string[] {
  return tokens.flatMap((t) => ('field' in t ? [t.field] : 'group' in t ? fieldsOf(t.group) : []));
}

/* ------------------------------------------------------------------ *
 * Validation of a definition
 * ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A regex a person wrote, refused when it could run away. */
export function regexProblem(source: string): string | undefined {
  if (source.length > MAX_REGEX_LENGTH) return `the regex is longer than ${MAX_REGEX_LENGTH} characters`;
  if (/\\[1-9]|\\k</.test(source)) return 'backreferences are not allowed';
  if (/\(\?<[=!]/.test(source)) return 'lookbehind is not allowed';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(source)) return 'nested quantifiers are not allowed';
  try {
    new RegExp(source, 'i');
  } catch (error) {
    return error instanceof Error ? error.message : 'the regex does not compile';
  }
  return undefined;
}

const maxOfWidth = (segment: { width: number }): number => 10 ** segment.width - 1;

function alphaToNumber(text: string): number {
  let n = 0;
  for (const ch of text.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numberToAlpha(n: number): string {
  let out = '';
  let rest = n;
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

const variantValueOk = (s: VariantSegment, value: string): boolean => (s.style === 'numeric' ? new RegExp(`^\\d{${s.width}}$`).test(value) : new RegExp(`^[A-Za-z]{1,${s.width}}$`).test(value));

/** Every problem with a definition, in words (the Settings editor shows them all); empty means it is usable. */
export function declarativeSchemeProblems(json: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(json)) return ['the scheme must be a JSON object'];
  if (json['type'] !== 'declarative') problems.push('type must be "declarative"');
  for (const key of ['id', 'label', 'src'] as const) {
    if (json[key] !== undefined && typeof json[key] !== 'string') problems.push(`${key} must be text`);
  }
  if (typeof json['id'] === 'string' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(json['id'])) problems.push('id must be kebab-case');
  if (json['immutable'] !== undefined && typeof json['immutable'] !== 'boolean') problems.push('immutable must be true or false');
  const template = json['template'];
  if (typeof template !== 'string' || template.trim() === '') return [...problems, 'template is required, for example {level}{type}-{seq}-{variant}'];
  if (template.length > MAX_TEMPLATE_LENGTH) return [...problems, `template is longer than ${MAX_TEMPLATE_LENGTH} characters`];
  const segments = json['segments'];
  if (!Array.isArray(segments) || segments.length === 0) return [...problems, 'segments must list at least one segment'];
  if (segments.length > MAX_SEGMENTS) return [...problems, `at most ${MAX_SEGMENTS} segments`];

  const byId = new Map<string, Record<string, unknown>>();
  for (const [i, raw] of segments.entries()) {
    const where = `segments[${i}]`;
    if (!isObject(raw)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    const id = raw['id'];
    if (typeof id !== 'string' || !ID.test(id)) {
      problems.push(`${where}: id must be lowercase letters, digits and hyphens, starting with a letter`);
      continue;
    }
    if (byId.has(id)) problems.push(`${where}: the id '${id}' is used twice`);
    byId.set(id, raw);
    const type = raw['type'];
    if (type === 'choice') {
      const values = raw['values'];
      if (!Array.isArray(values) || values.length === 0) problems.push(`${id}: a choice lists its values`);
      else if (values.length > MAX_CHOICE_VALUES) problems.push(`${id}: at most ${MAX_CHOICE_VALUES} values`);
      else {
        const seen = new Set<string>();
        for (const v of values) {
          if (!isObject(v) || typeof v['value'] !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(v['value'])) {
            problems.push(`${id}: each value is 1 to 8 letters or digits`);
            continue;
          }
          const key = v['value'].toUpperCase();
          if (seen.has(key)) problems.push(`${id}: the value '${v['value']}' is listed twice`);
          seen.add(key);
          if (v['kinds'] !== undefined && (!Array.isArray(v['kinds']) || v['kinds'].some((k) => !(PN_KINDS as readonly unknown[]).includes(k)))) {
            problems.push(`${id}: kinds of '${v['value']}' must be among ${PN_KINDS.join(', ')}`);
          }
        }
        if (raw['default'] !== undefined && !seen.has(String(raw['default']).toUpperCase())) problems.push(`${id}: the default '${String(raw['default'])}' is not one of its values`);
      }
    } else if (type === 'counter') {
      const width = raw['width'];
      if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 12) problems.push(`${id}: width must be a whole number from 1 to 12`);
      const ranges = raw['ranges'];
      const maxN = typeof width === 'number' ? maxOfWidth({ width }) : Number.MAX_SAFE_INTEGER;
      const spanProblem = (r: unknown): string | undefined => {
        if (!isObject(r) || !Number.isInteger(r['from']) || !Number.isInteger(r['to']) || (r['from'] as number) < 0 || (r['to'] as number) < (r['from'] as number)) return 'each span has whole numbers from <= to';
        if ((r['to'] as number) > maxN) return `a span reaches ${String(r['to'])}, more than ${String(width)} digits hold`;
        return undefined;
      };
      const excludeProblems = (list: unknown, what: string): void => {
        if (list === undefined) return;
        if (!Array.isArray(list) || list.length > MAX_SPANS) {
          problems.push(`${id}: ${what} is a list of at most ${MAX_SPANS} numbers or spans`);
          return;
        }
        for (const e of list) {
          if (typeof e === 'number' && Number.isInteger(e) && e >= 0) continue;
          const p = spanProblem(e);
          if (p !== undefined) {
            problems.push(`${id}: ${what}: ${p}`);
            break;
          }
        }
      };
      if (ranges !== undefined) {
        if (!Array.isArray(ranges) || ranges.length > MAX_RANGES) problems.push(`${id}: ranges is a list of at most ${MAX_RANGES}`);
        else {
          for (const r of ranges) {
            if (!isObject(r)) {
              problems.push(`${id}: each range is an object`);
              continue;
            }
            if (r['spans'] !== undefined) {
              if (r['from'] !== undefined || r['to'] !== undefined) problems.push(`${id}: a range has from and to, or spans, not both`);
              if (!Array.isArray(r['spans']) || r['spans'].length === 0 || r['spans'].length > MAX_SPANS) problems.push(`${id}: spans is a list of 1 to ${MAX_SPANS} spans`);
              else {
                for (const sp of r['spans']) {
                  const p = spanProblem(sp);
                  if (p !== undefined) {
                    problems.push(`${id}: ${p}`);
                    break;
                  }
                }
              }
            } else {
              const p = spanProblem(r);
              if (p !== undefined) problems.push(`${id}: ${p.replace('each span', 'each range')}`);
            }
            excludeProblems(r['exclude'], "a range's exclude");
            const m = r['match'];
            if (m !== undefined && !isObject(m) && !(Array.isArray(m) && m.length > 0 && m.length <= MAX_MATCHES && m.every(isObject))) problems.push(`${id}: a range's match is an object of segment ids, or a list of them`);
          }
        }
      }
      excludeProblems(raw['exclude'], 'exclude');
      if (raw['per'] !== undefined && (!Array.isArray(raw['per']) || raw['per'].some((p) => typeof p !== 'string'))) problems.push(`${id}: per is a list of segment ids`);
    } else if (type === 'variant') {
      const width = raw['width'];
      if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 4) problems.push(`${id}: width must be a whole number from 1 to 4`);
      if (raw['style'] !== 'numeric' && raw['style'] !== 'alpha') problems.push(`${id}: style is numeric or alpha`);
      else if (typeof width === 'number') {
        const probe = { style: raw['style'], width } as VariantSegment;
        for (const key of ['first', 'max'] as const) {
          if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !variantValueOk(probe, raw[key] as string))) problems.push(`${id}: ${key} '${String(raw[key])}' does not fit a ${String(width)}-wide ${String(raw['style'])} variant`);
        }
      }
      if (raw['optional'] !== undefined && typeof raw['optional'] !== 'boolean') problems.push(`${id}: optional is true or false`);
      if (raw['kinds'] !== undefined && (!Array.isArray(raw['kinds']) || raw['kinds'].some((k) => !(PN_KINDS as readonly unknown[]).includes(k)))) problems.push(`${id}: kinds must be among ${PN_KINDS.join(', ')}`);
    } else {
      problems.push(`${id}: type must be choice, counter or variant`);
    }
  }
  // references between segments
  for (const [id, raw] of byId) {
    if (raw['type'] === 'counter') {
      for (const p of (raw['per'] as string[] | undefined) ?? []) if (byId.get(p)?.['type'] !== 'choice') problems.push(`${id}: per names '${p}', which is not a choice segment`);
      for (const r of (raw['ranges'] as { match?: unknown }[] | undefined) ?? []) {
        const alts = Array.isArray(r?.match) ? (r.match as unknown[]) : r?.match === undefined ? [] : [r.match];
        for (const [k, v] of alts.flatMap((a) => (isObject(a) ? Object.entries(a) : []))) {
          const seg = byId.get(k);
          if (seg?.['type'] !== 'choice') problems.push(`${id}: a range matches '${k}', which is not a choice segment`);
          else {
            const have = new Set((seg['values'] as { value: string }[]).map((x) => String(x.value).toUpperCase()));
            for (const one of Array.isArray(v) ? v : [v]) if (typeof one !== 'string' || !have.has(one.toUpperCase())) problems.push(`${id}: a range matches ${k}='${String(one)}', which is not one of its values`);
          }
        }
      }
    }
  }
  const tokens = parseTemplate(template, problems);
  const used = fieldsOf(tokens);
  const seenField = new Set<string>();
  for (const f of used) {
    if (!byId.has(f)) problems.push(`template: {${f}} is not a segment`);
    if (seenField.has(f)) problems.push(`template: {${f}} is used twice`);
    seenField.add(f);
  }
  for (const id of byId.keys()) if (!seenField.has(id)) problems.push(`segment '${id}' is not placed in the template`);
  // a segment that may be left out must sit in an optional group, and only a variant may
  const inGroup = new Set(tokens.flatMap((t) => ('group' in t ? fieldsOf(t.group) : [])));
  for (const [id, raw] of byId) {
    if (raw['type'] === 'variant' && raw['optional'] === true && !inGroup.has(id)) problems.push(`${id}: an optional variant sits in an optional group, for example [-{${id}}]`);
    if (inGroup.has(id) && !(raw['type'] === 'variant' && raw['optional'] === true)) problems.push(`${id}: only an optional variant can sit in an optional group [ ]`);
  }
  const validation = json['validation'];
  if (validation !== undefined) {
    if (!isObject(validation)) problems.push('validation must be an object');
    else {
      if (validation['regex'] !== undefined) {
        const p = typeof validation['regex'] === 'string' ? regexProblem(validation['regex']) : 'the regex must be text';
        if (p !== undefined) problems.push(`validation.regex: ${p}`);
      }
      if (validation['message'] !== undefined && typeof validation['message'] !== 'string') problems.push('validation.message must be text');
    }
  }
  return problems;
}

/** Parse a definition from untrusted JSON; throws with every problem listed. */
export function parseDeclarativeSchemeConfig(json: unknown): DeclarativeSchemeConfig {
  const problems = declarativeSchemeProblems(json);
  if (problems.length > 0) throw new Error(`part-numbers.json: ${problems.join('; ')}`);
  return json as DeclarativeSchemeConfig;
}

/* ------------------------------------------------------------------ *
 * The scheme
 * ------------------------------------------------------------------ */

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Parsed {
  /** segment id → its canonical text (an optional variant left out is absent) */
  values: Record<string, string>;
}

/** The scheme a declarative definition describes. Throws when the definition is not valid (`declarativeSchemeProblems`). */
export function declarativePartNumberScheme(config: DeclarativeSchemeConfig): PartNumberScheme {
  parseDeclarativeSchemeConfig(config);
  const problems: string[] = [];
  const tokens = parseTemplate(config.template, problems);
  const segments = new Map(config.segments.map((s) => [s.id, s] as const));
  const choices = config.segments.filter((s): s is ChoiceSegment => s.type === 'choice');

  // compile the template to one anchored regex; `order` maps capture group n to its segment
  const order: string[] = [];
  const build = (list: readonly Token[]): string =>
    list
      .map((t) => {
        if ('literal' in t) return escapeRe(t.literal);
        if ('group' in t) return `(?:${build(t.group)})?`;
        const s = segments.get(t.field) as SchemeSegment;
        order.push(s.id);
        if (s.type === 'choice') return `(${[...s.values].sort((a, b) => b.value.length - a.value.length).map((v) => escapeRe(v.value)).join('|')})`;
        if (s.type === 'counter') return `(\\d{${s.width}})`;
        return s.style === 'numeric' ? `(\\d{${s.width}})` : `([A-Za-z]{1,${s.width}})`;
      })
      .join('');
  const source = `^${build(tokens)}$`;
  const re = new RegExp(source, 'i');
  const extra = config.validation?.regex === undefined ? undefined : new RegExp(config.validation.regex, 'i');

  const canonicalValue = (s: SchemeSegment, text: string): string => {
    if (s.type === 'choice') return s.values.find((v) => v.value.toUpperCase() === text.toUpperCase())?.value ?? text;
    if (s.type === 'variant' && s.style === 'alpha') return text.toUpperCase();
    return text;
  };

  const layout = (values: Record<string, string>): string => {
    const lay = (list: readonly Token[]): string =>
      list
        .map((t) => {
          if ('literal' in t) return t.literal;
          if ('group' in t) return fieldsOf(t.group).every((f) => values[f] !== undefined) ? lay(t.group) : '';
          return values[t.field] ?? '';
        })
        .join('');
    return lay(tokens);
  };

  function split(pn: string): Parsed | undefined {
    const text = pn.trim();
    if (text.length === 0 || text.length > MAX_PN_LENGTH) return undefined;
    const m = re.exec(text);
    if (m === null) return undefined;
    const values: Record<string, string> = {};
    for (const [i, id] of order.entries()) {
      const got = m[i + 1];
      if (got !== undefined) values[id] = canonicalValue(segments.get(id) as SchemeSegment, got);
    }
    if (extra !== undefined && !extra.test(layout(values))) return undefined;
    return { values };
  }

  const shapeText = layout(
    Object.fromEntries(
      config.segments.map((s) => [s.id, s.type === 'choice' ? `<${s.id}>` : s.type === 'counter' ? 'N'.repeat(s.width) : s.style === 'numeric' ? 'V'.repeat(s.width) : 'A'.repeat(s.width)] as const),
    ),
  );

  /** the combination key of a counter: its `per` segments' values */
  const perOf = (c: CounterSegment): string[] => c.per ?? choices.map((s) => s.id);
  const comboOf = (c: CounterSegment, values: Record<string, string>): string => perOf(c).map((id) => `${id}=${(values[id] ?? '').toUpperCase()}`).join('|');
  const asSpan = (e: CounterExclusion): CounterSpan => (typeof e === 'number' ? { from: e, to: e } : e);
  const matches = (m: CounterMatch | CounterMatch[] | undefined, values: Record<string, string>): boolean => {
    if (m === undefined) return true;
    return (Array.isArray(m) ? m : [m]).some((one) => Object.entries(one).every(([id, want]) => (Array.isArray(want) ? want : [want]).some((w) => w.toUpperCase() === (values[id] ?? '').toUpperCase())));
  };
  const rangeOf = (c: CounterSegment, values: Record<string, string>): Allowed => {
    const global = (c.exclude ?? []).map(asSpan);
    for (const r of c.ranges ?? []) {
      if (matches(r.match, values)) {
        const spans = (r.spans ?? [{ from: r.from as number, to: r.to as number }]).map((x) => ({ from: x.from, to: x.to })).sort((a, b) => a.from - b.from);
        return { spans, exclude: [...global, ...(r.exclude ?? []).map(asSpan)] };
      }
    }
    return { spans: [{ from: 1, to: maxOfWidth(c) }], exclude: global };
  };
  const excludedIn = (a: Allowed, n: number): boolean => a.exclude.some((e) => n >= e.from && n <= e.to);
  const allowedIn = (a: Allowed, n: number): boolean => a.spans.some((sp) => n >= sp.from && n <= sp.to) && !excludedIn(a, n);
  const lowest = (a: Allowed): number => (a.spans[0] as CounterSpan).from;
  const describeSpans = (a: Allowed): string => a.spans.map((sp) => `${String(sp.from)}–${String(sp.to)}`).join(', ');
  /** the first number above `after` the combination may issue, if any */
  const nextAllowed = (a: Allowed, after: number): number | undefined => {
    let n = after + 1;
    for (let guard = 0; guard < 1000; guard += 1) {
      const sp = a.spans.find((x) => n <= x.to);
      if (sp === undefined) return undefined;
      if (n < sp.from) n = sp.from;
      const hit = a.exclude.find((e) => n >= e.from && n <= e.to);
      if (hit === undefined) return n;
      n = hit.to + 1;
    }
    return undefined;
  };
  const allowedFor = (s: ChoiceSegment, value: string, kind: PnKind): boolean => {
    const v = s.values.find((x) => x.value.toUpperCase() === value.toUpperCase());
    return v !== undefined && (v.kinds === undefined || v.kinds.includes(kind));
  };

  function variantNext(s: VariantSegment, from: string | undefined): string | undefined {
    if (from === undefined) return s.first ?? (s.style === 'numeric' ? '0'.repeat(s.width) : 'A');
    if (s.style === 'numeric') {
      const n = Number(from) + 1;
      const cap = s.max === undefined ? maxOfWidth(s) : Number(s.max);
      return n > cap ? undefined : String(n).padStart(s.width, '0');
    }
    const n = alphaToNumber(from) + 1;
    const next = numberToAlpha(n);
    const capText = s.max?.toUpperCase();
    if (next.length > s.width || (capText !== undefined && alphaToNumber(next) > alphaToNumber(capText))) return undefined;
    return next;
  }
  const variantOrder = (s: VariantSegment, value: string): number => (s.style === 'numeric' ? Number(value) : alphaToNumber(value));

  const variant = config.segments.find((s): s is VariantSegment => s.type === 'variant');
  const counter = config.segments.find((s): s is CounterSegment => s.type === 'counter');
  /** everything but the variant, as a key */
  const baseKey = (values: Record<string, string>): string => config.segments.filter((s) => s.type !== 'variant').map((s) => `${s.id}=${(values[s.id] ?? '').toUpperCase()}`).join('|');

  return {
    id: config.id ?? 'declarative',
    label: config.label ?? 'Declarative scheme',
    shape: shapeText,
    ...(config.immutable === true ? { immutable: true } : {}),
    parse(pn) {
      const p = split(pn);
      return p === undefined ? undefined : layout(p.values);
    },
    check(pn, kind) {
      const text = pn.trim();
      const p = split(text);
      if (p === undefined) {
        const viaRegex = re.test(text) && text.length <= MAX_PN_LENGTH;
        return [{ code: 'pn-malformed', severity: 'warning', message: viaRegex && config.validation?.message !== undefined ? config.validation.message : viaRegex ? `'${pn}' does not match ${config.validation?.regex ?? shapeText}` : `'${pn}' is not ${shapeText}` }];
      }
      const issues: PnIssue[] = [];
      if (kind !== undefined) {
        for (const s of choices) {
          const value = p.values[s.id] as string;
          if (!allowedFor(s, value, kind)) issues.push({ code: s.values.some((v) => v.kinds !== undefined) ? 'pn-wrong-kind' : 'pn-unknown-prefix', severity: 'warning', message: `${s.label ?? s.id} '${value}' does not number ${kind}` });
        }
        if (variant !== undefined && variant.kinds !== undefined && !variant.kinds.includes(kind) && p.values[variant.id] !== undefined) {
          issues.push({ code: 'pn-wrong-kind', severity: 'warning', message: `${kind} does not carry a ${variant.label ?? variant.id}` });
        }
      }
      if (counter !== undefined) {
        const n = Number(p.values[counter.id]);
        const range = rangeOf(counter, p.values);
        if (excludedIn(range, n)) issues.push({ code: 'pn-excluded', severity: 'warning', message: `${counter.label ?? counter.id} ${p.values[counter.id] as string} is never issued for ${comboOf(counter, p.values).replace(/\|/g, ', ')}` });
        else if (!allowedIn(range, n)) issues.push({ code: 'pn-out-of-range', severity: 'warning', message: `${counter.label ?? counter.id} ${p.values[counter.id] as string} is outside ${describeSpans(range)} for ${comboOf(counter, p.values).replace(/\|/g, ', ')}` });
      }
      if (variant !== undefined && p.values[variant.id] !== undefined && config.segments.length > 0) {
        const cap = variant.max;
        if (cap !== undefined && variantOrder(variant, p.values[variant.id] as string) > variantOrder(variant, cap)) issues.push({ code: 'pn-out-of-range', severity: 'warning', message: `${variant.label ?? variant.id} ${p.values[variant.id] as string} is past the highest allowed, ${cap}` });
      }
      return issues;
    },
    suggest(subject: PnSubject, known: readonly KnownPartNumber[]): PnSuggestion | undefined {
      const parsed = known.flatMap((k) => {
        const p = split(k.pn);
        return p === undefined ? [] : [p];
      });
      // a variant of an existing number: the same number, the next variant
      if (subject.variantOf !== undefined) {
        const base = split(subject.variantOf);
        if (base === undefined || variant === undefined) return undefined;
        if (variant.kinds !== undefined && !variant.kinds.includes(subject.kind)) return undefined;
        const key = baseKey(base.values);
        let top: string | undefined;
        for (const p of parsed) {
          const v = p.values[variant.id];
          if (baseKey(p.values) === key && v !== undefined && (top === undefined || variantOrder(variant, v) > variantOrder(variant, top))) top = v;
        }
        // the number itself, without a variant, counts as the first
        const next = variantNext(variant, top ?? (base.values[variant.id] ?? undefined));
        if (next === undefined) return undefined;
        const values = { ...base.values, [variant.id]: next };
        return { pn: layout(values), rule: 'next-variant', explanation: `the next ${variant.label ?? variant.id} of ${layout(base.values)}, after ${top ?? base.values[variant.id] ?? 'none'}` };
      }
      // a new part: pick each choice from the kind, then the counter's next number in its range
      const values: Record<string, string> = {};
      for (const s of choices) {
        const hit = s.values.find((v) => v.kinds?.includes(subject.kind) === true) ?? (s.values.every((v) => v.kinds === undefined) ? (s.values.find((v) => v.value.toUpperCase() === (s.default ?? s.values[0]?.value ?? '').toUpperCase()) ?? s.values[0]) : s.values.find((v) => v.value.toUpperCase() === (s.default ?? '').toUpperCase()));
        if (hit === undefined) return undefined;
        values[s.id] = hit.value;
      }
      if (counter !== undefined) {
        const range = rangeOf(counter, values);
        const combo = comboOf(counter, values);
        let top = lowest(range) - 1;
        for (const p of parsed) {
          const n = Number(p.values[counter.id]);
          if (comboOf(counter, p.values) === combo && allowedIn(range, n) && n > top) top = n;
        }
        const next = nextAllowed(range, top);
        if (next === undefined) return undefined;
        values[counter.id] = String(next).padStart(counter.width, '0');
      }
      if (variant !== undefined && !(variant.optional === true) && (variant.kinds === undefined || variant.kinds.includes(subject.kind))) {
        const first = variantNext(variant, undefined);
        if (first !== undefined) values[variant.id] = first;
      } else if (variant !== undefined && variant.optional !== true) {
        return undefined;
      }
      const pn = layout(values);
      // never propose a number that is taken
      if (parsed.some((p) => layout(p.values) === pn)) return undefined;
      const where = counter === undefined ? '' : ` in ${comboOf(counter, values).replace(/\|/g, ', ')}`;
      const used = counter === undefined ? [] : parsed.filter((p) => comboOf(counter, p.values) === comboOf(counter, values) && allowedIn(rangeOf(counter, values), Number(p.values[counter.id]))).map((p) => Number(p.values[counter.id]));
      const after = counter === undefined || used.length === 0 ? 'none in use' : String(Math.max(...used)).padStart(counter.width, '0');
      return { pn, rule: 'next-in-sequence', explanation: `the next free number${where}, after ${after}` };
    },
  };
}
