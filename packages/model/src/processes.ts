/**
 * Required manufacturing processes: the steps a build needs beyond plain assembly (overmolding,
 * PCBA assembly, a printed jacket), as a hub vocabulary plus what each design declares.
 *
 * The vocabulary is the catalog's `processes.json` (an array of records; a data pack may ship it,
 * a local record of the same id shadows the pack's, `enabled: false` switches one off; the base
 * ships none). A process may say when a design needs it without being told (`derive`: rule-language
 * selectors, `rules.ts`), and a design may declare one by hand (`CableDesign.processes`).
 * `requiredProcesses` joins the two with where each came from; a saved version captures the entries
 * it needed (`FrozenDefinitions.processes`), so its list never follows later vocabulary changes.
 *
 * ```json
 * { "id": "overmold", "label": "Overmolding",
 *   "derive": [{ "each": "mechanical", "where": { "eq": [{ "path": "kind" }, "boot"] } }],
 *   "src": "synthetic example" }
 * ```
 */

import type { CableDesign, Db, Issue } from './model.ts';
import { recordMetaIssues } from './provenance.ts';
import { matchingSubjects, selectorProblems, type Condition, type DESIGN_RULE_SUBJECTS, type RuleSelector } from './rules.ts';

export type ProcessSubject = (typeof DESIGN_RULE_SUBJECTS)[number];

/** When a design needs the process without declaring it: every subject `each` the `where` holds for. */
export interface ProcessDerive {
  each: ProcessSubject;
  where?: Condition;
  /** why, in a few words ("a boot is moulded on") */
  note?: string;
}

/** One entry of the process vocabulary (`processes.json`). */
export interface ProcessDefinition {
  /** kebab-case, up to 100 characters (the same grammar as a standard-work operation, so a shop can align them) */
  id: string;
  label: string;
  description?: string;
  derive?: ProcessDerive[];
  /** false: kept, not used (a pack's process switched off here by a local record of the same id) */
  enabled?: boolean;
  src: string;
  license?: string;
  provenance?: Record<string, unknown>;
}

/** A process a design declares by hand. */
export interface DeclaredProcess {
  id: string;
  note?: string;
}

export interface ProcessMatch {
  each: string;
  /** the subject's address, as an issue's `where` names it (`j1`, `boot-1`, the design's id) */
  subject: string;
}

export interface RequiredProcess {
  id: string;
  /** the vocabulary's label; the id when the process is unknown */
  label: string;
  /** in the vocabulary in force and switched on */
  known: boolean;
  source: 'declared' | 'derived' | 'both';
  declared?: { note?: string };
  /** the first `MAX_PROCESS_MATCHES` subjects that derived it, and how many more did */
  derived?: { matches: ProcessMatch[]; more: number };
}

export const MAX_PROCESSES = 200;
export const MAX_DERIVE_PER_PROCESS = 10;
export const MAX_DECLARED_PROCESSES = 100;
export const MAX_PROCESS_MATCHES = 20;
export const MAX_PROCESS_NOTE = 500;
export const PROCESS_LIMITS = { processes: MAX_PROCESSES, derivePerProcess: MAX_DERIVE_PER_PROCESS, declaredPerDesign: MAX_DECLARED_PROCESSES } as const;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && ID.test(v);
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Why one vocabulary entry cannot be used, in words; empty when it can. */
export function processProblems(entry: unknown): string[] {
  if (!isObject(entry)) return ['a process is an object'];
  const problems: string[] = [];
  if (!isId(entry['id'])) problems.push('id is kebab-case, up to 100 characters');
  if (!text(entry['label'], 200)) problems.push('label is text, up to 200 characters');
  if (entry['description'] !== undefined && !(typeof entry['description'] === 'string' && entry['description'].length <= 2000)) problems.push('description is text, up to 2000 characters');
  if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') problems.push('enabled is true or false');
  if (!text(entry['src'], 2000)) problems.push('src says where the process comes from, up to 2000 characters');
  const derive = entry['derive'];
  if (derive !== undefined) {
    if (!Array.isArray(derive)) problems.push('derive is a list of { each, where?, note? }');
    else {
      if (derive.length > MAX_DERIVE_PER_PROCESS) problems.push(`at most ${MAX_DERIVE_PER_PROCESS} derive entries`);
      for (const [i, d] of derive.slice(0, MAX_DERIVE_PER_PROCESS).entries()) {
        problems.push(...selectorProblems(d, `derive[${i}]`));
        if (isObject(d) && d['note'] !== undefined && !text(d['note'], MAX_PROCESS_NOTE)) problems.push(`derive[${i}]: note is text, up to ${MAX_PROCESS_NOTE} characters`);
      }
    }
  }
  for (const issue of recordMetaIssues(entry, 'process')) problems.push(issue.message.replace(/^record '[^']*': /, ''));
  return problems;
}

/** Problems of a whole vocabulary: each entry's, duplicate ids, and the count. */
export function processListProblems(list: unknown): string[] {
  if (!Array.isArray(list)) return ['the processes are a list'];
  const problems: string[] = [];
  if (list.length > MAX_PROCESSES) problems.push(`at most ${MAX_PROCESSES} processes`);
  const seen = new Set<string>();
  for (const [i, entry] of list.entries()) {
    const id = isObject(entry) && typeof entry['id'] === 'string' ? entry['id'] : `#${i + 1}`;
    for (const p of processProblems(entry)) problems.push(`${id}: ${p}`);
    if (seen.has(id)) problems.push(`${id}: the id is used twice`);
    seen.add(id);
  }
  return problems;
}

/** The usable vocabulary: entries without problems and switched on, the first of an id winning (a local record before a pack's). */
export function processesInForce(db: Pick<Db, 'processes'>): Map<string, ProcessDefinition> {
  const out = new Map<string, ProcessDefinition>();
  const shadowed = new Set<string>();
  for (const entry of (Array.isArray(db.processes) ? db.processes : []).slice(0, MAX_PROCESSES)) {
    const id = isObject(entry) && typeof entry['id'] === 'string' ? entry['id'] : undefined;
    if (id === undefined || shadowed.has(id)) continue;
    shadowed.add(id);
    if (entry.enabled === false || processProblems(entry).length > 0) continue;
    out.set(id, entry);
  }
  return out;
}

/** Why a design's `processes` field cannot be stored; empty when it can (or is absent). */
export function declaredProcessProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['processes must be a list of { id, note? }'];
  const problems: string[] = [];
  if (value.length > MAX_DECLARED_PROCESSES) problems.push(`a design declares at most ${MAX_DECLARED_PROCESSES} processes`);
  const seen = new Set<string>();
  for (const [i, entry] of value.entries()) {
    if (!isObject(entry) || !isId(entry['id'])) {
      problems.push(`processes[${i}] needs a kebab-case id, up to 100 characters`);
      continue;
    }
    if (seen.has(entry['id'])) problems.push(`process '${entry['id']}' is declared twice`);
    seen.add(entry['id']);
    if (entry['note'] !== undefined && !(typeof entry['note'] === 'string' && entry['note'].length <= MAX_PROCESS_NOTE)) problems.push(`the note on process '${entry['id']}' is text, up to ${MAX_PROCESS_NOTE} characters`);
  }
  return problems;
}

/** The well-formed declarations of a design (the first of an id), whatever else the field holds. */
function declaredOf(design: CableDesign): DeclaredProcess[] {
  const raw: unknown = (design as { processes?: unknown }).processes;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DeclaredProcess[] = [];
  for (const entry of raw.slice(0, MAX_DECLARED_PROCESSES)) {
    if (!isObject(entry) || !isId(entry['id']) || seen.has(entry['id'])) continue;
    seen.add(entry['id']);
    out.push({ id: entry['id'], ...(typeof entry['note'] === 'string' && entry['note'] !== '' ? { note: entry['note'] } : {}) });
  }
  return out;
}

function unknownIssues(declared: readonly DeclaredProcess[], inForce: ReadonlyMap<string, ProcessDefinition>, db: Pick<Db, 'processes'>): Issue[] {
  const off = new Set((db.processes ?? []).filter((p) => isObject(p) && p.enabled === false).map((p) => p.id));
  return declared
    .filter((d) => !inForce.has(d.id))
    .map((d) => ({
      code: 'process-unknown',
      severity: 'warning' as const,
      message: off.has(d.id) ? `process '${d.id}' is switched off in this hub's processes` : `process '${d.id}' is not in this hub's processes`,
      where: 'processes',
    }));
}

/** `validateDesign`'s part: a malformed declaration (refuses a save) and declared processes the hub does not know. */
export function declaredProcessIssues(design: CableDesign, db: Pick<Db, 'processes'>): Issue[] {
  const raw: unknown = (design as { processes?: unknown }).processes;
  const problems = declaredProcessProblems(raw);
  const issues: Issue[] = problems.map((message) => ({ code: 'invalid-processes', severity: 'error', message, where: 'processes' }));
  return [...issues, ...unknownIssues(declaredOf(design), processesInForce(db), db)];
}

/** `validateDb`'s part: every vocabulary problem, as a warning (an unusable process is skipped, never an error). */
export function processLibraryIssues(db: Pick<Db, 'processes'>): Issue[] {
  if (db.processes === undefined) return [];
  return processListProblems(db.processes).map((message) => ({ code: 'process-invalid', severity: 'warning', message: `processes.json: ${message}`, where: 'processes' }));
}

/**
 * The processes a design needs, in its own scope (a sub-assembly's processes are its own): each
 * declared one, and each process in force whose `derive` picks a subject of the design. Sorted by id.
 */
export function requiredProcesses(design: CableDesign, db: Db): { processes: RequiredProcess[]; issues: Issue[] } {
  const inForce = processesInForce(db);
  const declared = declaredOf(design);
  const derivable = [...inForce.values()].filter((p) => (p.derive ?? []).length > 0);
  const selectors: RuleSelector[] = [];
  const owners: string[] = [];
  for (const p of derivable) {
    for (const d of p.derive ?? []) {
      selectors.push({ each: d.each, ...(d.where === undefined ? {} : { where: d.where }) });
      owners.push(p.id);
    }
  }
  const { subjects, exceeded } = selectors.length === 0 ? { subjects: [] as string[][], exceeded: false } : matchingSubjects(design, db, selectors);
  const matches = new Map<string, ProcessMatch[]>();
  for (const [i, found] of subjects.entries()) {
    const id = owners[i] as string;
    const list = matches.get(id) ?? [];
    const each = (selectors[i] as RuleSelector).each;
    for (const subject of found) if (!list.some((m) => m.each === each && m.subject === subject)) list.push({ each, subject });
    if (list.length > 0) matches.set(id, list);
  }
  const ids = [...new Set([...declared.map((d) => d.id), ...matches.keys()])].sort();
  const processes: RequiredProcess[] = ids.map((id) => {
    const def = inForce.get(id);
    const mine = declared.find((d) => d.id === id);
    const found = matches.get(id);
    return {
      id,
      label: def?.label ?? id,
      known: def !== undefined,
      source: mine !== undefined && found !== undefined ? 'both' : mine !== undefined ? 'declared' : 'derived',
      ...(mine === undefined ? {} : { declared: mine.note === undefined ? {} : { note: mine.note } }),
      ...(found === undefined ? {} : { derived: { matches: found.slice(0, MAX_PROCESS_MATCHES), more: Math.max(0, found.length - MAX_PROCESS_MATCHES) } }),
    };
  });
  const issues = unknownIssues(declared, inForce, db);
  if (exceeded) issues.push({ code: 'process-budget', severity: 'warning', message: 'the processes were too much to evaluate: some derived processes may be missing (simplify their derive conditions)', where: 'processes' });
  return { processes, issues };
}

/** The vocabulary entries a saved version keeps: the known processes `design` declares or matches, deep copies, by id. */
export function captureProcesses(design: CableDesign, db: Db): ProcessDefinition[] {
  const inForce = processesInForce(db);
  const out = requiredProcesses(design, db)
    .processes.filter((p) => p.known)
    .map((p) => inForce.get(p.id) as ProcessDefinition)
    .sort(byId);
  return JSON.parse(JSON.stringify(out)) as ProcessDefinition[];
}
