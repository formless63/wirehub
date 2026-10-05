/**
 * Declarative validation rules: a small, safe rule language written as data.
 *
 * A rule says what it is about (`each`: a connector, a conductor, a signal path …),
 * which of those it applies to (`where`), and what must hold of each (`require`).
 * Every one that fails becomes an `Issue` with the rule's severity and a message
 * built from a template. Rules live in the catalog (`validation-rules.json`, an
 * array of records, so a data pack can carry them), reach the validators through
 * `Db.validationRules`, and run inside `validateDesign` and `validateDb`.
 *
 * ```json
 * {
 *   "id": "power-conductor-min-area",
 *   "severity": "error",
 *   "each": "conductor",
 *   "where": { "contains": [{ "path": "signalKinds" }, "power"] },
 *   "require": { "gte": [{ "path": "areaMm2" }, 0.5] },
 *   "message": "{segment}: the {path} conductor carries {signals} and is {areaMm2} mm², under 0.5 mm²",
 *   "src": "shop wiring rule"
 * }
 * ```
 *
 * No code runs: a condition is JSON, a path reads a field of the subject's scope,
 * and evaluation is bounded (depth, node count and a step budget per call). A value
 * that is missing makes a comparison false, so a `require` over an unknown value
 * fails: guard optional values with `exists` in `where`. Complex cases stay code
 * rules (a module's `validate`).
 *
 * Subjects (`each`), and the fields each one's scope offers besides `design`
 * (`id`, `label`, `status`, `tags`, `productRef`):
 *
 * - `design` — the design itself;
 * - `connector` — `id def role label family gender construction sourcing partNumber pinCount`,
 *   `pinsJoined`, `pinsOpen`, `pins` (`id signal joined`), `mechanicals` (`id def kind qty label`),
 *   `mechanicalKinds`, `shells` and `shellCount` (the shells attached to it), `boards` and
 *   `boardCount` (boards its pins are joined to), `ends` (the run ends it is joined to, `w1@a`),
 *   and the other plain fields of the connector definition;
 * - `segment` — `id def role lengthMm label partNumber odMm conductorCount minAreaMm2 maxAreaMm2`;
 * - `conductor` — `segment path def wire areaMm2 material color formation lengthMm signals signalKinds
 *   joinedA joinedB`;
 * - `component` — `id def location label kind category value partNumber`;
 * - `pcba` — `id def label partNumber`, `terminalCount`, `terminalsJoined`, `terminals`
 *   (`id role signal joined`), `connectors` (the connectors joined to it: `id def label family
 *   partNumber`), `connectorFamilies`, `shells` and `shellCount` (shells of those connectors);
 * - `mechanical` — `id def qty attachedTo attachedFamily kind label partNumber`, and the host
 *   connector as `host` (`id def label family partNumber`) with `hostDef`, `hostPartNumber`;
 * - `cable-end` — one per end (`a` or `b`) of each wire run: `id` (`w1@a`), `segment`,
 *   `segmentDef`, `end`, `role`, `label`, `connectors` / `connectorCount` / `connectorFamilies`
 *   (the connectors the end's conductors are joined to: `id def label family gender partNumber
 *   role pinCount`), `shells` / `shellCount` (the shells attached to those connectors),
 *   `mechanicals` / `mechanicalKinds`, `boards` / `boardCount` (boards joined at this end,
 *   directly or through a connector: `id def label partNumber`), `flying` (nothing is joined
 *   but bare conductors); the "for each cable end" selector, with "the end's shell" and "the
 *   board at this end" as its lists;
 * - `signal-path` — one per pair of signal-tagged connector pins or board terminals joined through
 *   copper and parts: `signal signalKind from to` (`instance terminal def family`), `components`
 *   (`instance def kind category value label`), `componentKinds`, `componentCategories`, `hops`;
 * - library subjects, run by `validateDb`: `connector-def`, `wire-def`, `component-def`, `pcba-def`,
 *   `mechanical-def` — the definition's plain fields (`conductorCount`, `minAreaMm2`, `pinCount` added).
 */

import type { CableDesign, ComponentDefinition, ConnectorDefinition, Db, Issue, MechanicalDefinition, PcbaDefinition, TerminalRef, WireDefinition } from './model.ts';
import { findComponent, findConnector, findMechanical, findPcba, findWire } from './model.ts';
import { deriveNets, trace } from './nets.ts';
import { electricalPaths, resolveElementPath } from './paths.ts';
import { signalOf } from './signals.ts';
import { terminalKey } from './validate.ts';
import { vocabEntry, type LaneEntry, type SignalEntry } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * The language
 * ------------------------------------------------------------------ */

export const DESIGN_RULE_SUBJECTS = ['design', 'connector', 'segment', 'conductor', 'component', 'pcba', 'mechanical', 'cable-end', 'signal-path'] as const;
export const LIBRARY_RULE_SUBJECTS = ['connector-def', 'wire-def', 'component-def', 'pcba-def', 'mechanical-def'] as const;
export const RULE_SUBJECTS = [...DESIGN_RULE_SUBJECTS, ...LIBRARY_RULE_SUBJECTS] as const;
export type RuleSubject = (typeof RULE_SUBJECTS)[number];

export type Literal = string | number | boolean | null | (string | number | boolean | null)[];

export type Operand =
  | Literal
  | { path: string }
  | { outer: string }
  | { length: string }
  | { count: Quantified }
  | { sum: Aggregated }
  | { min: Aggregated }
  | { max: Aggregated };

export interface Quantified {
  /** a list in the scope: `components`, `pins` … */
  in: string;
  where?: Condition;
}
export interface Aggregated extends Quantified {
  /** the numeric field of each item */
  field: string;
}

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { eq: [Operand, Operand] }
  | { ne: [Operand, Operand] }
  | { gt: [Operand, Operand] }
  | { gte: [Operand, Operand] }
  | { lt: [Operand, Operand] }
  | { lte: [Operand, Operand] }
  | { in: [Operand, Operand] }
  | { contains: [Operand, Operand] }
  | { startsWith: [Operand, Operand] }
  | { endsWith: [Operand, Operand] }
  | { exists: Operand }
  | { empty: Operand }
  | { some: Quantified }
  | { every: Quantified }
  | { none: Quantified };

export interface ValidationRule {
  /** kebab; the issue code is `rule:<id>` */
  id: string;
  label?: string;
  /** false: kept, not run (a data pack's rule switched off here by a local record of the same id) */
  enabled?: boolean;
  severity: 'error' | 'warning';
  /** `{field}` placeholders read the subject's scope: `{id}`, `{design.id}`, `{signals}` */
  message: string;
  each: RuleSubject;
  /** the design-level gate and the subject filter in one: only subjects it holds for are checked */
  where?: Condition;
  /** what must hold of each selected subject; one issue per subject it fails for */
  require: Condition;
  src: string;
}

export const MAX_RULES = 200;
const MAX_DEPTH = 8;
const MAX_NODES = 100;
const MAX_MESSAGE = 300;
/** one evaluation call (all rules over one design or library) stops here */
const MAX_STEPS = 400_000;
const MAX_SUBJECTS_PER_RULE = 2000;
const MAX_SIGNAL_TERMINALS = 60;
/** a list of related records in a scope (shells, boards …) is cut here */
const MAX_RELATED = 50;

/* ------------------------------------------------------------------ *
 * Checking a rule's shape
 * ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const COMPARE = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'endsWith'] as const;
const QUANTIFIERS = ['some', 'every', 'none'] as const;
const AGGREGATES = ['sum', 'min', 'max'] as const;

function isLiteral(v: unknown): v is Literal {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true;
  return Array.isArray(v) && v.length <= 100 && v.every((x) => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
}

class Counter {
  nodes = 0;
}

function operandProblems(op: unknown, where: string, depth: number, counter: Counter, problems: string[]): void {
  counter.nodes += 1;
  if (isLiteral(op)) return;
  if (!isObject(op) || Object.keys(op).length !== 1) {
    problems.push(`${where}: an operand is a literal, { "path": … }, { "outer": … }, { "length": … }, { "count": … }, { "sum" | "min" | "max": … }`);
    return;
  }
  const [key, value] = Object.entries(op)[0] as [string, unknown];
  if (key === 'path' || key === 'outer' || key === 'length') {
    if (typeof value !== 'string' || !PATH.test(value)) problems.push(`${where}: ${key} names a field such as "pinsJoined" or "design.tags"`);
    return;
  }
  if (key === 'count') return quantifiedProblems(value, `${where}.count`, depth + 1, counter, problems, false);
  if ((AGGREGATES as readonly string[]).includes(key)) return quantifiedProblems(value, `${where}.${key}`, depth + 1, counter, problems, true);
  problems.push(`${where}: '${key}' is not an operand`);
}

function quantifiedProblems(q: unknown, where: string, depth: number, counter: Counter, problems: string[], aggregate: boolean): void {
  if (depth > MAX_DEPTH) return void problems.push(`${where}: nested more than ${MAX_DEPTH} deep`);
  if (!isObject(q) || typeof q['in'] !== 'string' || !PATH.test(q['in'])) return void problems.push(`${where}: needs "in", the list to look through`);
  if (aggregate && (typeof q['field'] !== 'string' || !PATH.test(q['field']))) problems.push(`${where}: needs "field", the number to read of each item`);
  if (q['where'] !== undefined) conditionProblems(q['where'], `${where}.where`, depth + 1, counter, problems);
}

function conditionProblems(c: unknown, where: string, depth: number, counter: Counter, problems: string[]): void {
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES) {
    if (counter.nodes === MAX_NODES + 1) problems.push(`the rule is larger than ${MAX_NODES} conditions`);
    return;
  }
  if (depth > MAX_DEPTH) return void problems.push(`${where}: nested more than ${MAX_DEPTH} deep`);
  if (!isObject(c) || Object.keys(c).length !== 1) return void problems.push(`${where}: a condition has exactly one key: all, any, not, eq, ne, gt, gte, lt, lte, in, contains, startsWith, endsWith, exists, empty, some, every or none`);
  const [key, value] = Object.entries(c)[0] as [string, unknown];
  if (key === 'all' || key === 'any') {
    if (!Array.isArray(value) || value.length === 0) return void problems.push(`${where}: ${key} is a non-empty list of conditions`);
    for (const [i, v] of value.entries()) conditionProblems(v, `${where}.${key}[${i}]`, depth + 1, counter, problems);
  } else if (key === 'not') {
    conditionProblems(value, `${where}.not`, depth + 1, counter, problems);
  } else if ((COMPARE as readonly string[]).includes(key)) {
    if (!Array.isArray(value) || value.length !== 2) return void problems.push(`${where}: ${key} takes two operands`);
    for (const v of value) operandProblems(v, `${where}.${key}`, depth + 1, counter, problems);
  } else if (key === 'exists' || key === 'empty') {
    operandProblems(value, `${where}.${key}`, depth + 1, counter, problems);
  } else if ((QUANTIFIERS as readonly string[]).includes(key)) {
    quantifiedProblems(value, `${where}.${key}`, depth + 1, counter, problems, false);
  } else {
    problems.push(`${where}: '${key}' is not a condition`);
  }
}

/** Why a rule cannot be used, in words; empty when it can. */
export function ruleProblems(rule: unknown): string[] {
  if (!isObject(rule)) return ['a rule is an object'];
  const problems: string[] = [];
  const id = rule['id'];
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) problems.push('id is kebab-case, up to 64 characters');
  if (rule['label'] !== undefined && (typeof rule['label'] !== 'string' || rule['label'].length > 120)) problems.push('label is text, up to 120 characters');
  if (rule['enabled'] !== undefined && typeof rule['enabled'] !== 'boolean') problems.push('enabled is true or false');
  if (rule['severity'] !== 'error' && rule['severity'] !== 'warning') problems.push('severity is error or warning');
  if (typeof rule['message'] !== 'string' || rule['message'].trim() === '') problems.push('message is the sentence an issue shows');
  else if (rule['message'].length > MAX_MESSAGE) problems.push(`message is longer than ${MAX_MESSAGE} characters`);
  if (!(RULE_SUBJECTS as readonly unknown[]).includes(rule['each'])) problems.push(`each is one of ${RULE_SUBJECTS.join(', ')}`);
  if (typeof rule['src'] !== 'string' || rule['src'].trim() === '') problems.push('src says where the rule comes from');
  const counter = new Counter();
  if (rule['where'] !== undefined) conditionProblems(rule['where'], 'where', 0, counter, problems);
  if (rule['require'] === undefined) problems.push('require is the condition each subject must meet');
  else conditionProblems(rule['require'], 'require', 0, counter, problems);
  return problems;
}

/** Problems of a whole rule list: each rule's, duplicate ids, and the count. */
export function ruleListProblems(list: unknown): string[] {
  if (!Array.isArray(list)) return ['the rules are a list'];
  const problems: string[] = [];
  if (list.length > MAX_RULES) problems.push(`at most ${MAX_RULES} rules`);
  const seen = new Set<string>();
  for (const [i, rule] of list.entries()) {
    const id = isObject(rule) && typeof rule['id'] === 'string' ? rule['id'] : `#${i + 1}`;
    for (const p of ruleProblems(rule)) problems.push(`${id}: ${p}`);
    if (seen.has(id)) problems.push(`${id}: the id is used twice`);
    seen.add(id);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

type Scope = Record<string, unknown>;

interface Budget {
  steps: number;
  exceeded: boolean;
}

function lookup(scope: Scope | undefined, path: string): unknown {
  let cur: unknown = scope;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);
const same = (a: unknown, b: unknown): boolean => lower(a) === lower(b);

function readOperand(op: Operand, scope: Scope, outer: Scope | undefined, budget: Budget): unknown {
  budget.steps += 1;
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return op;
  if ('path' in op) return lookup(scope, op.path);
  if ('outer' in op) return lookup(outer, op.outer);
  if ('length' in op) {
    const v = lookup(scope, op.length);
    return Array.isArray(v) || typeof v === 'string' ? v.length : undefined;
  }
  if ('count' in op) return items(op.count, scope, budget).length;
  for (const agg of AGGREGATES) {
    if (agg in op) {
      const q = (op as Record<string, Aggregated>)[agg] as Aggregated;
      const nums = items(q, scope, budget).flatMap((item) => {
        const v = lookup(item, q.field);
        return typeof v === 'number' && Number.isFinite(v) ? [v] : [];
      });
      if (nums.length === 0) return agg === 'sum' ? 0 : undefined;
      return agg === 'sum' ? nums.reduce((a, b) => a + b, 0) : agg === 'min' ? Math.min(...nums) : Math.max(...nums);
    }
  }
  return undefined;
}

/** The items of a list in `scope` that pass the quantifier's `where` (evaluated with the item as scope, `outer` reaching back to `scope`). */
function items(q: Quantified, scope: Scope, budget: Budget): Scope[] {
  const list = lookup(scope, q.in);
  if (!Array.isArray(list)) return [];
  const out: Scope[] = [];
  for (const raw of list.slice(0, 1000)) {
    const item: Scope = isObject(raw) ? raw : { value: raw };
    if (q.where === undefined || holds(q.where, item, scope, budget)) out.push(item);
    if (budget.exceeded) break;
  }
  return out;
}

function compare(op: 'gt' | 'gte' | 'lt' | 'lte', a: unknown, b: unknown): boolean {
  if (typeof a !== 'number' || typeof b !== 'number' || Number.isNaN(a) || Number.isNaN(b)) return false;
  return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
}

function holds(cond: Condition, scope: Scope, outer: Scope | undefined, budget: Budget): boolean {
  budget.steps += 1;
  if (budget.steps > MAX_STEPS) {
    budget.exceeded = true;
    return false;
  }
  const [key, value] = Object.entries(cond)[0] as [string, unknown];
  const read = (op: Operand): unknown => readOperand(op, scope, outer, budget);
  switch (key) {
    case 'all':
      return (value as Condition[]).every((c) => holds(c, scope, outer, budget));
    case 'any':
      return (value as Condition[]).some((c) => holds(c, scope, outer, budget));
    case 'not':
      return !holds(value as Condition, scope, outer, budget);
    case 'eq': {
      const [a, b] = (value as [Operand, Operand]).map(read) as [unknown, unknown];
      return a !== undefined && same(a, b);
    }
    case 'ne': {
      const [a, b] = (value as [Operand, Operand]).map(read) as [unknown, unknown];
      return !same(a, b);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = (value as [Operand, Operand]).map(read) as [unknown, unknown];
      return compare(key, a, b);
    }
    case 'in': {
      const [a, b] = (value as [Operand, Operand]).map(read) as [unknown, unknown];
      return Array.isArray(b) && a !== undefined && b.some((x) => same(x, a));
    }
    case 'contains': {
      const [a, b] = (value as [Operand, Operand]).map(read) as [unknown, unknown];
      if (Array.isArray(a)) return b !== undefined && a.some((x) => same(x, b));
      return typeof a === 'string' && typeof b === 'string' && a.toLowerCase().includes(b.toLowerCase());
    }
    case 'startsWith':
    case 'endsWith': {
      const [a, b] = (value as [Operand, Operand]).map(read) as [unknown, unknown];
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      return key === 'startsWith' ? a.toLowerCase().startsWith(b.toLowerCase()) : a.toLowerCase().endsWith(b.toLowerCase());
    }
    case 'exists': {
      const v = read(value as Operand);
      return v !== undefined && v !== null;
    }
    case 'empty': {
      const v = read(value as Operand);
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    }
    case 'some':
      return items(value as Quantified, scope, budget).length > 0;
    case 'none':
      return items(value as Quantified, scope, budget).length === 0;
    case 'every': {
      const q = value as Quantified;
      const list = lookup(scope, q.in);
      if (!Array.isArray(list)) return true;
      if (q.where === undefined) return true;
      return list.slice(0, 1000).every((raw) => holds(q.where as Condition, isObject(raw) ? raw : { value: raw }, scope, budget));
    }
    default:
      return false;
  }
}

/** `{a.b}` placeholders of a template filled from a scope; a missing value shows as `?`. */
export function fillTemplate(template: string, scope: Scope): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_, path: string) => {
    const v = lookup(scope, path);
    if (v === undefined || v === null) return '?';
    if (Array.isArray(v)) return v.map(String).join(', ') || '(none)';
    return typeof v === 'object' ? '?' : String(v);
  });
}

/* ------------------------------------------------------------------ *
 * Scopes
 * ------------------------------------------------------------------ */

/** The plain fields of a record (strings, numbers, booleans, lists of those), for a rule to read. */
function plain(record: object): Scope {
  const out: Scope = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' || typeof x === 'number')) out[k] = v;
  }
  return out;
}

function designScope(design: CableDesign): Scope {
  return {
    ...plain({ id: design.id, label: design.label, ...(design.productRef === undefined ? {} : { productRef: design.productRef }), status: design.status ?? 'active', ...(design.labourMinutes === undefined ? {} : { labourMinutes: design.labourMinutes }), ...(design.route === undefined ? {} : { route: design.route }), ...(design.maker === undefined ? {} : { maker: design.maker }) }),
    tags: Array.isArray((design as { tags?: unknown }).tags) ? ((design as { tags: unknown[] }).tags.filter((t) => typeof t === 'string') as string[]) : [],
  };
}

interface DesignFacts {
  design: CableDesign;
  db: Db;
  scope: Scope;
  jointed: Set<string>;
  nets?: ReturnType<typeof deriveNets>;
  /** instance id -> the other end of each joint it is on (built once per design) */
  links?: Map<string, TerminalRef[]>;
  /** segment end (`w1@a`) -> the other end of each joint on that run end */
  endLinks?: Map<string, TerminalRef[]>;
}

const capped = <T>(list: T[]): T[] => (list.length > MAX_RELATED ? list.slice(0, MAX_RELATED) : list);

function linksOf(facts: DesignFacts): { links: Map<string, TerminalRef[]>; endLinks: Map<string, TerminalRef[]> } {
  if (facts.links === undefined || facts.endLinks === undefined) {
    const links = new Map<string, TerminalRef[]>();
    const endLinks = new Map<string, TerminalRef[]>();
    const push = (map: Map<string, TerminalRef[]>, key: string, other: TerminalRef): void => {
      const list = map.get(key);
      if (list === undefined) map.set(key, [other]);
      else list.push(other);
    };
    for (const joint of facts.design.joints) {
      for (const [x, y] of [[joint.a, joint.b], [joint.b, joint.a]] as const) {
        push(links, x.instance, y);
        if (x.end !== undefined) push(endLinks, `${x.instance}@${x.end}`, y);
      }
    }
    facts.links = links;
    facts.endLinks = endLinks;
  }
  return { links: facts.links, endLinks: facts.endLinks };
}

/** The boards, connectors and shells related to a connector instance, from the design's joints and attachments. */
function connectorRelations(facts: DesignFacts, connectorId: string): { shells: Scope[]; boards: Scope[] } {
  const { design, db } = facts;
  const { links } = linksOf(facts);
  const shells = (design.instances.mechanical ?? []).filter((m) => m.attachedTo === connectorId).flatMap((m) => {
    const md = findMechanical(db, m.def);
    return md?.kind === 'shell' ? [{ id: m.id, def: m.def, label: md.label, partNumber: md.partNumber ?? '', attachedTo: connectorId }] : [];
  });
  const boardIds = [...new Set((links.get(connectorId) ?? []).map((o) => o.instance))].filter((id) => design.instances.pcbas.some((p) => p.id === id));
  return { shells: capped(shells), boards: capped(boardIds.map((id) => boardScope(facts, id))) };
}

function boardScope(facts: DesignFacts, id: string): Scope {
  const inst = facts.design.instances.pcbas.find((p) => p.id === id);
  const def = inst === undefined ? undefined : findPcba(facts.db, inst.def);
  return { id, def: inst?.def ?? '', label: def?.label ?? inst?.def ?? id, partNumber: def?.partNumber ?? '' };
}

function connectorScope(facts: DesignFacts, id: string): Scope {
  const inst = facts.design.instances.connectors.find((c) => c.id === id);
  const def = inst === undefined ? undefined : findConnector(facts.db, inst.def);
  return { id, def: inst?.def ?? '', label: inst?.label ?? def?.label ?? id, family: def?.family ?? '', gender: def?.gender ?? '', partNumber: def?.partNumber ?? '', role: inst?.role ?? '', pinCount: def?.pins.length ?? 0 };
}

function signalsOfTag(ref: unknown): string[] {
  if (typeof ref === 'string') return [ref];
  if (isObject(ref) && Array.isArray(ref['oneOf'])) return ref['oneOf'].filter((s): s is string => typeof s === 'string');
  return [];
}

function signalKindOf(db: Db, id: string): string | undefined {
  return vocabEntry<SignalEntry>(db.vocab, 'signals', id)?.kind;
}

function netSignals(facts: DesignFacts, key: string): string[] {
  facts.nets ??= deriveNets(facts.design, facts.db);
  const net = facts.nets.find((n) => n.terminals.some((t) => t.key === key));
  const found = new Set<string>();
  for (const t of net?.terminals ?? []) {
    const tags = signalOf(facts.db, t.instanceKind, t.def, t.terminal);
    for (const s of signalsOfTag(tags?.signal)) found.add(s);
    if (tags?.lane !== undefined) {
      const lane = vocabEntry<LaneEntry>(facts.db.vocab, 'lanes', tags.lane);
      if (lane?.signal !== undefined) found.add(lane.signal);
    }
  }
  return [...found].filter((id) => signalKindOf(facts.db, id) !== 'none').sort();
}

function subjectsOf(each: RuleSubject, facts: DesignFacts): { scope: Scope; where: string }[] {
  const { design, db } = facts;
  const base = { design: facts.scope };
  const out: { scope: Scope; where: string }[] = [];
  switch (each) {
    case 'design':
      out.push({ scope: { ...base, ...facts.scope }, where: design.id });
      break;
    case 'connector':
      for (const inst of design.instances.connectors) {
        const def: ConnectorDefinition | undefined = findConnector(db, inst.def);
        const joined = (def?.pins ?? []).filter((p) => facts.jointed.has(`${inst.id}:${p.id}`)).map((p) => p.id);
        const mechanicals = (design.instances.mechanical ?? []).filter((m) => m.attachedTo === inst.id).map((m) => {
          const md = findMechanical(db, m.def);
          return { id: m.id, def: m.def, qty: m.qty, kind: md?.kind ?? '', label: md?.label ?? m.def };
        });
        const related = connectorRelations(facts, inst.id);
        const ends = [...new Set((linksOf(facts).links.get(inst.id) ?? []).flatMap((o) => (o.end === undefined ? [] : [`${o.instance}@${o.end}`])))].sort();
        out.push({
          where: inst.id,
          scope: {
            ...base,
            ...(def === undefined ? {} : plain(def)),
            shells: related.shells,
            shellCount: related.shells.length,
            boards: related.boards,
            boardCount: related.boards.length,
            ends: capped(ends),
            kind: 'connector',
            id: inst.id,
            def: inst.def,
            ...(inst.role === undefined ? {} : { role: inst.role }),
            label: inst.label ?? def?.label ?? inst.id,
            pinCount: def?.pins.length ?? 0,
            pinsJoined: joined,
            pinsOpen: (def?.pins ?? []).filter((p) => !joined.includes(p.id)).map((p) => p.id),
            pins: (def?.pins ?? []).map((p) => ({ id: p.id, signal: signalsOfTag(p.signal ?? db.tags?.connectors?.[inst.def]?.[p.id]).join(','), joined: joined.includes(p.id) })),
            mechanicals,
            mechanicalKinds: mechanicals.map((m) => m.kind),
          },
        });
      }
      break;
    case 'segment':
      for (const inst of design.instances.segments) {
        const wire = findWire(db, inst.def);
        const areas = wire === undefined ? [] : conductorAreas(wire);
        out.push({
          where: inst.id,
          scope: {
            ...base,
            ...(wire === undefined ? {} : plain(wire)),
            id: inst.id,
            def: inst.def,
            ...(inst.role === undefined ? {} : { role: inst.role }),
            ...(inst.lengthMm === undefined ? {} : { lengthMm: inst.lengthMm }),
            label: wire?.label ?? inst.def,
            conductorCount: wire === undefined ? 0 : electricalPaths(wire.structure).length,
            ...(areas.length === 0 ? {} : { minAreaMm2: Math.min(...areas), maxAreaMm2: Math.max(...areas) }),
          },
        });
      }
      break;
    case 'conductor':
      for (const inst of design.instances.segments) {
        const wire = findWire(db, inst.def);
        if (wire === undefined) continue;
        for (const path of electricalPaths(wire.structure)) {
          const el = resolveElementPath(wire.structure, path);
          if (el?.kind !== 'conductor') continue;
          const keyA = terminalKey({ instance: inst.id, terminal: path, end: 'a' });
          const keyB = terminalKey({ instance: inst.id, terminal: path, end: 'b' });
          const signals = [...new Set([...netSignals(facts, keyA), ...netSignals(facts, keyB)])].sort();
          out.push({
            where: `${inst.id}:${path}`,
            scope: {
              ...base,
              segment: inst.id,
              path,
              id: `${inst.id}:${path}`,
              def: inst.def,
              wire: wire.label,
              ...(el.areaMm2 === undefined ? {} : { areaMm2: el.areaMm2 }),
              ...(el.material === undefined ? {} : { material: el.material }),
              ...(el.color === undefined ? {} : { color: el.color }),
              ...(el.formation === undefined ? {} : { formation: el.formation }),
              ...(inst.lengthMm === undefined ? {} : { lengthMm: inst.lengthMm }),
              signals,
              signalKinds: [...new Set(signals.map((s) => signalKindOf(db, s)).filter((k): k is string => k !== undefined))].sort(),
              joinedA: facts.jointed.has(keyA),
              joinedB: facts.jointed.has(keyB),
            },
          });
        }
      }
      break;
    case 'component':
      for (const inst of design.instances.components) {
        const def: ComponentDefinition | undefined = findComponent(db, inst.def);
        out.push({ where: inst.id, scope: { ...base, ...(def === undefined ? {} : plain(def)), id: inst.id, def: inst.def, ...(inst.location === undefined ? {} : { location: inst.location }), label: def?.label ?? inst.def } });
      }
      break;
    case 'pcba':
      for (const inst of design.instances.pcbas) {
        const def: PcbaDefinition | undefined = findPcba(db, inst.def);
        const { links } = linksOf(facts);
        const joinedTerminals = new Set([...facts.jointed].filter((k) => k.startsWith(`${inst.id}:`)).map((k) => k.slice(inst.id.length + 1)));
        const connectorIds = [...new Set((links.get(inst.id) ?? []).map((o) => o.instance))].filter((id) => design.instances.connectors.some((c) => c.id === id));
        const connectors = capped(connectorIds.map((id) => connectorScope(facts, id)));
        const shells = capped(connectorIds.flatMap((id) => connectorRelations(facts, id).shells));
        out.push({
          where: inst.id,
          scope: {
            ...base,
            ...(def === undefined ? {} : plain(def)),
            id: inst.id,
            def: inst.def,
            label: def?.label ?? inst.def,
            terminalCount: def?.terminals.length ?? 0,
            terminalsJoined: capped([...joinedTerminals].sort()),
            terminals: capped((def?.terminals ?? []).map((t) => ({ id: t.id, role: t.role ?? '', signal: signalsOfTag(signalOf(db, 'pcba', inst.def, t.id)?.signal).join(','), joined: joinedTerminals.has(t.id) }))),
            connectors,
            connectorFamilies: [...new Set(connectors.map((c) => String(c['family'])))].sort(),
            shells,
            shellCount: shells.length,
          },
        });
      }
      break;
    case 'mechanical':
      for (const inst of design.instances.mechanical ?? []) {
        const def: MechanicalDefinition | undefined = findMechanical(db, inst.def);
        const host = inst.attachedTo === undefined ? undefined : design.instances.connectors.find((c) => c.id === inst.attachedTo);
        const hostDef = host === undefined ? undefined : findConnector(db, host.def);
        out.push({
          where: inst.id,
          scope: {
            ...base,
            ...(def === undefined ? {} : plain(def)),
            id: inst.id,
            def: inst.def,
            qty: inst.qty,
            ...(inst.attachedTo === undefined ? {} : { attachedTo: inst.attachedTo }),
            ...(hostDef === undefined ? {} : { attachedFamily: hostDef.family, hostDef: host?.def ?? '', hostPartNumber: hostDef.partNumber ?? '', host: connectorScope(facts, host?.id ?? '') }),
            label: def?.label ?? inst.def,
          },
        });
      }
      break;
    case 'cable-end':
      out.push(...cableEnds(facts));
      break;
    case 'signal-path':
      out.push(...signalPaths(facts));
      break;
    default:
      break;
  }
  return out;
}

/** One subject per end of each wire run: what is joined there, and the shells and boards that go with it. */
function cableEnds(facts: DesignFacts): { scope: Scope; where: string }[] {
  const { design, db } = facts;
  const { endLinks, links } = linksOf(facts);
  const out: { scope: Scope; where: string }[] = [];
  for (const seg of design.instances.segments) {
    const wire = findWire(db, seg.def);
    for (const end of ['a', 'b'] as const) {
      const key = `${seg.id}@${end}`;
      const others = endLinks.get(key) ?? [];
      const connectorIds = [...new Set(others.map((o) => o.instance))].filter((id) => design.instances.connectors.some((c) => c.id === id));
      const boardIds = new Set(others.map((o) => o.instance).filter((id) => design.instances.pcbas.some((p) => p.id === id)));
      for (const id of connectorIds) for (const o of links.get(id) ?? []) if (design.instances.pcbas.some((p) => p.id === o.instance)) boardIds.add(o.instance);
      const connectors = capped(connectorIds.map((id) => connectorScope(facts, id)));
      const shells = capped(connectorIds.flatMap((id) => connectorRelations(facts, id).shells));
      const mechanicals = capped(
        (design.instances.mechanical ?? []).filter((m) => m.attachedTo !== undefined && connectorIds.includes(m.attachedTo)).map((m) => {
          const md = findMechanical(db, m.def);
          return { id: m.id, def: m.def, qty: m.qty, kind: md?.kind ?? '', label: md?.label ?? m.def, partNumber: md?.partNumber ?? '', attachedTo: m.attachedTo ?? '' };
        }),
      );
      out.push({
        where: key,
        scope: {
          design: facts.scope,
          id: key,
          segment: seg.id,
          segmentDef: seg.def,
          end,
          ...(seg.role === undefined ? {} : { role: seg.role }),
          label: seg.label ?? wire?.label ?? seg.def,
          connectors,
          connectorCount: connectors.length,
          connectorFamilies: [...new Set(connectors.map((c) => String(c['family'])))].sort(),
          shells,
          shellCount: shells.length,
          mechanicals,
          mechanicalKinds: mechanicals.map((m) => m.kind),
          boards: capped([...boardIds].sort().map((id) => boardScope(facts, id))),
          boardCount: boardIds.size,
          flying: others.length === 0 || (connectorIds.length === 0 && boardIds.size === 0),
        },
      });
    }
  }
  return out;
}

function conductorAreas(wire: WireDefinition): number[] {
  const out: number[] = [];
  for (const path of electricalPaths(wire.structure)) {
    const el = resolveElementPath(wire.structure, path);
    if (el?.kind === 'conductor' && el.bare !== true && el.areaMm2 !== undefined) out.push(el.areaMm2);
  }
  return out;
}

/** Pairs of signal-tagged connector pins and board terminals joined through copper and parts. */
function signalPaths(facts: DesignFacts): { scope: Scope; where: string }[] {
  const { design, db } = facts;
  const ends: { key: string; instance: string; terminal: string; def: string; family: string; signals: string[] }[] = [];
  for (const inst of design.instances.connectors) {
    const def = findConnector(db, inst.def);
    for (const pin of def?.pins ?? []) {
      const signals = signalsOfTag(signalOf(db, 'connector', inst.def, pin.id)?.signal).filter((id) => signalKindOf(db, id) !== 'none');
      if (signals.length > 0) ends.push({ key: `${inst.id}:${pin.id}`, instance: inst.id, terminal: pin.id, def: inst.def, family: def?.family ?? '', signals });
    }
  }
  for (const inst of design.instances.pcbas) {
    const def = findPcba(db, inst.def);
    for (const t of def?.terminals ?? []) {
      const signals = signalsOfTag(signalOf(db, 'pcba', inst.def, t.id)?.signal).filter((id) => signalKindOf(db, id) !== 'none');
      if (signals.length > 0) ends.push({ key: `${inst.id}:${t.id}`, instance: inst.id, terminal: t.id, def: inst.def, family: '', signals });
    }
  }
  if (ends.length > MAX_SIGNAL_TERMINALS) ends.length = MAX_SIGNAL_TERMINALS;
  const out: { scope: Scope; where: string }[] = [];
  for (const a of ends) {
    const reached = trace(design, db, { instance: a.instance, terminal: a.terminal }).reached;
    for (const b of ends) {
      if (b.key <= a.key) continue;
      const step = reached.find((r) => r.terminal.key === b.key);
      if (step === undefined) continue;
      for (const signal of a.signals.filter((s) => b.signals.includes(s))) {
        const components = step.passages.filter((p) => p.kind === 'component').map((p) => {
          const def = p.def === undefined ? undefined : findComponent(db, p.def);
          return { instance: p.instance, def: p.def ?? '', kind: def?.kind ?? '', category: def?.category ?? def?.kind ?? '', value: def?.value ?? '', label: def?.label ?? p.description };
        });
        out.push({
          where: `${a.instance}:${a.terminal} to ${b.instance}:${b.terminal}`,
          scope: {
            design: facts.scope,
            signal,
            signalKind: signalKindOf(db, signal) ?? '',
            from: { instance: a.instance, terminal: a.terminal, def: a.def, family: a.family },
            to: { instance: b.instance, terminal: b.terminal, def: b.def, family: b.family },
            components,
            componentKinds: components.map((c) => c.kind),
            componentCategories: components.map((c) => c.category),
            hops: step.passages.length,
          },
        });
      }
    }
  }
  return out;
}

function librarySubjects(each: RuleSubject, db: Db): { scope: Scope; where: string }[] {
  switch (each) {
    case 'connector-def':
      return db.connectors.map((d) => ({ where: `connectors/${d.id}`, scope: { ...plain(d), pinCount: d.pins.length } }));
    case 'wire-def':
      return db.wires.map((d) => {
        const areas = conductorAreas(d);
        return { where: `wires/${d.id}`, scope: { ...plain(d), conductorCount: electricalPaths(d.structure).length, ...(areas.length === 0 ? {} : { minAreaMm2: Math.min(...areas), maxAreaMm2: Math.max(...areas) }) } };
      });
    case 'component-def':
      return db.components.map((d) => ({ where: `components/${d.id}`, scope: plain(d) }));
    case 'pcba-def':
      return db.pcbas.map((d) => ({ where: `pcbas/${d.id}`, scope: plain(d) }));
    case 'mechanical-def':
      return (db.mechanicals ?? []).map((d) => ({ where: `mechanicals/${d.id}`, scope: plain(d) }));
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

const isLibrary = (each: string): boolean => (LIBRARY_RULE_SUBJECTS as readonly string[]).includes(each);

function runRules(rules: readonly ValidationRule[], subjectsFor: (each: RuleSubject) => { scope: Scope; where: string }[]): Issue[] {
  const issues: Issue[] = [];
  const budget: Budget = { steps: 0, exceeded: false };
  const cache = new Map<RuleSubject, { scope: Scope; where: string }[]>();
  for (const rule of rules.slice(0, MAX_RULES)) {
    if (rule.enabled === false || ruleProblems(rule).length > 0) continue;
    let subjects = cache.get(rule.each);
    if (subjects === undefined) {
      subjects = subjectsFor(rule.each).slice(0, MAX_SUBJECTS_PER_RULE);
      cache.set(rule.each, subjects);
    }
    for (const subject of subjects) {
      if (rule.where !== undefined && !holds(rule.where, subject.scope, undefined, budget)) continue;
      if (budget.exceeded) break;
      if (holds(rule.require, subject.scope, undefined, budget)) continue;
      if (budget.exceeded) break;
      issues.push({ code: `rule:${rule.id}`, severity: rule.severity, message: fillTemplate(rule.message, subject.scope), where: subject.where });
    }
    if (budget.exceeded) {
      issues.push({ code: 'rule-budget', severity: 'warning', message: `the validation rules were too much to evaluate and stopped at '${rule.id}' (simplify them)`, where: 'validation-rules' });
      break;
    }
  }
  return issues;
}

function indexJoints(design: CableDesign): Set<string> {
  const jointed = new Set<string>();
  for (const joint of design.joints) for (const ref of [joint.a, joint.b, ...(joint.through === undefined ? [] : [joint.through])]) jointed.add(terminalKey(ref));
  return jointed;
}

/** The design-scope rules (`Db.validationRules`) over one design: an issue per subject that fails. */
export function ruleIssuesForDesign(design: CableDesign, db: Db): Issue[] {
  const rules = (db.validationRules ?? []).filter((r) => !isLibrary(String(r?.each)));
  if (rules.length === 0) return [];
  const facts: DesignFacts = { design, db, scope: designScope(design), jointed: indexJoints(design) };
  return runRules(rules, (each) => subjectsOf(each, facts));
}

/** The library-scope rules over the definitions, and a warning for every rule that cannot be used. */
export function ruleIssuesForLibrary(db: Db): Issue[] {
  const all = db.validationRules ?? [];
  if (all.length === 0) return [];
  const issues: Issue[] = [];
  for (const [i, rule] of all.entries()) {
    const problems = ruleProblems(rule);
    if (problems.length > 0) issues.push({ code: 'rule-invalid', severity: 'warning', message: `validation rule ${(rule as { id?: unknown })?.id === undefined ? `#${i + 1}` : `'${String((rule as { id: unknown }).id)}'`} cannot be used: ${problems[0]}`, where: 'validation-rules' });
  }
  const ids = all.map((r) => r?.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) issues.push({ code: 'rule-invalid', severity: 'warning', message: `two validation rules are called '${String(id)}'`, where: 'validation-rules' });
  if (all.length > MAX_RULES) issues.push({ code: 'rule-invalid', severity: 'warning', message: `more than ${MAX_RULES} validation rules: the rest are not run`, where: 'validation-rules' });
  issues.push(...runRules(all.filter((r) => isLibrary(String(r?.each))), (each) => librarySubjects(each, db)));
  return issues;
}
