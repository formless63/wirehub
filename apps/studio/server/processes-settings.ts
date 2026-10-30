/**
 * The required-manufacturing-process vocabulary as a setting (`@wirehub/model` `processes.ts`):
 *
 *   GET  /api/processes   the processes in force (local ones and those a pack ships), the limits, the subjects `derive` may name
 *   PUT  /api/processes   { processes: [...] } — replace this hub's own processes (If-Match); owner or editor (token: catalog:write)
 *
 * The hub's own processes are `data/processes.json` (an array of records written through the unit of
 * work like every catalog document, so both backends keep it with the catalog and a save raises
 * `catalog.changed`). A data pack ships the same file; a local record with a pack's id shadows it
 * (switch one off with `enabled: false`, or change its label or derive). Designs read them through
 * `Db.processes`: declared ids are checked against them, `derive` entries pick the designs that need
 * one, and a saved version captures the entries it needed (`docs/processes.md`).
 */

import { DESIGN_RULE_SUBJECTS, PROCESS_LIMITS, processListProblems, processProblems, type Db, type ProcessDefinition } from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { checkIfMatch, contentETag } from './etag.ts';

export const PROCESSES_PATH = 'data/processes.json';
const PROCESSES_FILE = 'processes.json';

export const PROCESSES_ROUTES = ['GET    /api/processes', 'PUT    /api/processes'] as const;

export const isProcessesPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'processes';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

async function localProcesses(deps: WorkbenchDeps): Promise<ProcessDefinition[]> {
  const stored = await deps.docs?.read(PROCESSES_PATH);
  return Array.isArray(stored) ? (stored as ProcessDefinition[]) : [];
}

/** Which pack ships which process id (the install record). */
async function packOwners(deps: WorkbenchDeps): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const pack of (await deps.installedPacks?.())?.packs ?? []) for (const id of pack.added[PROCESSES_FILE] ?? []) if (!owners.has(id)) owners.set(id, pack.id);
  return owners;
}

async function view(deps: WorkbenchDeps, local: ProcessDefinition[], db?: Db): Promise<Record<string, unknown>> {
  const inForce = (db ?? (await deps.loadDb())).processes ?? [];
  const owners = await packOwners(deps);
  const processes = inForce.map((p) => {
    // a process a pack's install record lists is the pack's, layered or merged; a local record of the same id shadows (or, merged, edits) it
    const fromPack = owners.get(p.id);
    return { ...p, origin: fromPack === undefined ? 'local' : 'pack', ...(fromPack === undefined ? {} : { pack: fromPack }), problems: processProblems(p) };
  });
  return { processes, local, limits: PROCESS_LIMITS, subjects: DESIGN_RULE_SUBJECTS };
}

/** The processes in force after `saved` replaces `before` locally: the packs' stay (unless shadowed), the local ones lead. */
function mergeWithPacks(db: Db, before: ProcessDefinition[], saved: ProcessDefinition[]): ProcessDefinition[] {
  const beforeIds = new Set(before.map((p) => p.id));
  const savedIds = new Set(saved.map((p) => p.id));
  return [...saved, ...(db.processes ?? []).filter((p) => !beforeIds.has(p.id) && !savedIds.has(p.id))];
}

export async function handleProcessesRequest(method: string, parts: string[], body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This hub does not keep catalog documents by path.', 'Processes are stored with the catalog.');
  if (parts.length !== 2) return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${PROCESSES_ROUTES.join('; ')}.`);
  const local = await localProcesses(deps);
  const etag = contentETag(local.length === 0 ? null : local);
  if (method === 'GET') return { status: 200, body: await view(deps, local), headers: { ETag: etag } };
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  const guard = checkIfMatch(ifMatch, etag, 'process list', 'processes');
  if (guard !== undefined) return guard;
  const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { processes?: unknown }).processes : undefined;
  if (!Array.isArray(list)) return fail(400, 'Send { "processes": [ … ] }: this hub\'s own processes, replacing the ones it has.', 'An empty list removes them all.');
  const problems = processListProblems(list);
  if (problems.length > 0) return fail(422, `Those processes cannot be used: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}.`, 'Nothing was saved.', { problems });
  const next = list as ProcessDefinition[];
  const before = await deps.loadDb();
  if (next.length === 0) await deps.docs.remove(PROCESSES_PATH);
  else await deps.docs.write(PROCESSES_PATH, next);
  const saved = next.length === 0 ? [] : ((await deps.docs.read(PROCESSES_PATH)) as ProcessDefinition[] | undefined) ?? next;
  return { status: 200, body: await view(deps, saved, { ...before, processes: mergeWithPacks(before, local, saved) }), headers: { ETag: contentETag(saved.length === 0 ? null : saved) } };
}
