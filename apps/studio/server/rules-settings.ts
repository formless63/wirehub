/**
 * Declarative validation rules as a setting (`@wirehub/model` `rules.ts`):
 *
 *   GET  /api/rules             the rules in force (local ones and those a pack ships), the language's subjects
 *   PUT  /api/rules             { rules: [...] } — replace this hub's own rules (If-Match); owner or editor
 *   POST /api/rules/preview     { rule } — run one rule over every design and the library, writing nothing
 *
 * The hub's own rules are `data/validation-rules.json` (an array of rule records, written through
 * the unit of work like every other document, so both backends keep it with the catalog). A data
 * pack ships the same file (merged into it, or layered under it); a rule with the same id as the
 * pack's, saved here, replaces it (switch one off, or tighten it). They run inside `validateDesign` and
 * `validateDb` (`Db.validationRules`), so they appear in the issues panel and block a save when
 * their severity is `error`.
 */

import {
  DESIGN_RULE_SUBJECTS,
  LIBRARY_RULE_SUBJECTS,
  MAX_RULES,
  ruleIssuesForDesign,
  ruleIssuesForLibrary,
  ruleListProblems,
  ruleProblems,
  type CableDesign,
  type Db,
  type ValidationRule,
} from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { withDesignLibrary } from './assemblies.ts';
import { readAllDesigns } from './designs.ts';
import { checkIfMatch, contentETag } from './etag.ts';

export const RULES_PATH = 'data/validation-rules.json';
const RULES_FILE = 'validation-rules.json';

export const RULES_ROUTES = ['GET    /api/rules', 'PUT    /api/rules', 'POST   /api/rules/preview'] as const;

export const isRulesPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'rules';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

async function localRules(deps: WorkbenchDeps): Promise<ValidationRule[]> {
  const stored = await deps.docs?.read(RULES_PATH);
  return Array.isArray(stored) ? (stored as ValidationRule[]) : [];
}

/** Which pack ships which rule id (the install record). */
async function packOwners(deps: WorkbenchDeps): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const pack of (await deps.installedPacks?.())?.packs ?? []) for (const id of pack.added[RULES_FILE] ?? []) if (!owners.has(id)) owners.set(id, pack.id);
  return owners;
}

async function view(deps: WorkbenchDeps, local: ValidationRule[]): Promise<Record<string, unknown>> {
  const db = await deps.loadDb();
  const inForce = db.validationRules ?? [];
  const owners = await packOwners(deps);
  const rules = inForce.map((r) => {
    // a rule a pack's install record lists is the pack's, whether the pack is a layer or merged into the catalog; a local record of the same id shadows (or, merged, edits) it
    const fromPack = owners.get(r.id);
    return { ...r, origin: fromPack === undefined ? 'local' : 'pack', ...(fromPack === undefined ? {} : { pack: fromPack }), problems: ruleProblems(r) };
  });
  return {
    rules,
    local,
    limits: { rules: MAX_RULES },
    subjects: { design: DESIGN_RULE_SUBJECTS, library: LIBRARY_RULE_SUBJECTS },
  };
}

async function runOver(deps: WorkbenchDeps, db: Db, designs: CableDesign[], id: string): Promise<{ designs: { id: string; issues: number; examples: { severity: string; message: string; where?: string }[] }[]; library: { issues: number; examples: { severity: string; message: string; where?: string }[] }; errors: number; warnings: number }> {
  const mine = (code: string): boolean => code === `rule:${id}` || code === 'rule-budget';
  let errors = 0;
  let warnings = 0;
  const out = [];
  for (const design of designs) {
    const library = await withDesignLibrary(deps, design, db);
    const issues = ruleIssuesForDesign(design, library).filter((i) => mine(i.code));
    for (const i of issues) i.severity === 'error' ? (errors += 1) : (warnings += 1);
    if (issues.length > 0) out.push({ id: design.id, issues: issues.length, examples: issues.slice(0, 3).map((i) => ({ severity: i.severity, message: i.message, ...(i.where === undefined ? {} : { where: i.where }) })) });
  }
  const lib = ruleIssuesForLibrary(db).filter((i) => mine(i.code) || (i.code === 'rule-invalid' && i.message.includes(`'${id}'`)));
  for (const i of lib) i.severity === 'error' ? (errors += 1) : (warnings += 1);
  return { designs: out, library: { issues: lib.length, examples: lib.slice(0, 3).map((i) => ({ severity: i.severity, message: i.message, ...(i.where === undefined ? {} : { where: i.where }) })) }, errors, warnings };
}

async function preview(body: unknown, deps: WorkbenchDeps): Promise<ApiResponse> {
  const rule = (typeof body === 'object' && body !== null ? (body as { rule?: unknown }).rule : undefined) as ValidationRule | undefined;
  const problems = ruleProblems(rule);
  if (problems.length > 0) return { status: 200, body: { ok: false, problems } };
  const base = await deps.loadDb();
  // the candidate replaces a rule of the same id, else joins the others
  const db: Db = { ...base, validationRules: [...(base.validationRules ?? []).filter((r) => r.id !== (rule as ValidationRule).id), rule as ValidationRule] };
  const designs = await readAllDesigns(deps.designs);
  return { status: 200, body: { ok: true, ...(await runOver(deps, db, designs, (rule as ValidationRule).id)) } };
}

export async function handleRulesRequest(method: string, parts: string[], body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.', 'Validation rules are stored with the catalog.');
  if (parts.length === 3 && parts[2] === 'preview') {
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    return preview(body, deps);
  }
  if (parts.length !== 2) return fail(404, `${parts.join('/')} is not part of the workbench API.`, `Try ${RULES_ROUTES.join('; ')}.`);
  const local = await localRules(deps);
  const etag = contentETag(local.length === 0 ? null : local);
  if (method === 'GET') return { status: 200, body: await view(deps, local), headers: { ETag: etag } };
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  const guard = checkIfMatch(ifMatch, etag, 'rules', 'validation-rules');
  if (guard !== undefined) return guard;
  const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(list)) return fail(400, 'Send { "rules": [ … ] }: this hub\'s own rules, replacing the ones it has.', 'An empty list removes them all.');
  const problems = ruleListProblems(list);
  if (problems.length > 0) return fail(422, `Those rules cannot be used: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}.`, 'Nothing was saved.', { problems });
  const next = list as ValidationRule[];
  if (next.length === 0) await deps.docs.remove(RULES_PATH);
  else await deps.docs.write(RULES_PATH, next);
  const saved = next.length === 0 ? [] : ((await deps.docs.read(RULES_PATH)) as ValidationRule[] | undefined) ?? next;
  return { status: 200, body: await view({ ...deps, loadDb: async () => ({ ...(await deps.loadDb()), validationRules: mergeWithPack(await deps.loadDb(), local, saved) }) }, saved), headers: { ETag: contentETag(saved.length === 0 ? null : saved) } };
}

/** The rules in force after `saved` replaces `before` locally: the pack's rules stay (unless shadowed), the local ones lead. */
function mergeWithPack(db: Db, before: ValidationRule[], saved: ValidationRule[]): ValidationRule[] {
  const beforeIds = new Set(before.map((r) => r.id));
  const fromPacks = (db.validationRules ?? []).filter((r) => !beforeIds.has(r.id));
  const savedIds = new Set(saved.map((r) => r.id));
  return [...saved, ...fromPacks.filter((r) => !savedIds.has(r.id))];
}
