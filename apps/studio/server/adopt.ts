/**
 * Adopt a newer revision of a part across designs (`@wirehub/model` `revision-adopt.ts`,
 * `docs/revisions.md`):
 *
 *   GET  /api/adopt/:kind/:id   the part's revisions, the one designs should move to, and per design
 *                               that places an older one what moving changes (with its ETag)
 *   POST /api/adopt/:kind/:id   { to, designs: [{ id, from, etag }] } — switch those designs' working
 *                               copies, one change set; a design refused (stale, a pack's) is reported
 *                               and the others are still adopted
 *
 * On the record of an older revision the list is the designs that place it; on the newest, the
 * designs that place any older one. No review record: the change set's history entry says what
 * moved, and each design's next saved version captures it.
 *
 * `:kind` `designs` is a design placed as a sub-assembly (`subassembly-adopt.ts`): the parents
 * pinned to an older saved version than its newest released one, with the free ends that change;
 * POST `{ to: <rev>, designs: [{ id, from: <rev>, etag }] }` re-pins them.
 */

import {
  adoptImpact,
  adoptRevision,
  adoptSubassemblyRevision,
  isAdoptKind,
  newerReleasedRevision,
  newestRevision,
  olderRevisions,
  placesRecord,
  releasedRevisions,
  revisionFamily,
  subassembliesOf,
  subassemblyAdoptImpact,
  withAssemblies,
  type AdoptImpact,
  type AdoptKind,
  type SubassemblyAdoptImpact,
} from '@wirehub/model';

import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { assemblyLibrary } from './assemblies.ts';
import { readAllDesigns } from './designs.ts';
import { contentETag } from './etag.ts';

export const ADOPT_ROUTES = ['GET    /api/adopt/:kind/:id', 'POST   /api/adopt/:kind/:id'] as const;

export const isAdoptPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'adopt';

type Route = (request: ApiRequest, deps: WorkbenchDeps) => Promise<ApiResponse>;

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });

async function view(deps: WorkbenchDeps, kind: AdoptKind, id: string, to?: string): Promise<ApiResponse> {
  const db = await deps.loadDb();
  const family = revisionFamily(db, kind, id);
  const target = to === undefined ? newestRevision(family) : family.find((s) => s.id === to);
  const self = family.find((s) => s.id === id);
  if (target === undefined || self === undefined) return { status: 200, body: { kind, id, family, impacts: [] } };
  const older = olderRevisions(family, target);
  // an older revision's page: the designs that place it; the newest's: every older one's
  const sources = target.id === id ? older : older.filter((s) => s.id === id);
  const impacts: (AdoptImpact & { etag: string })[] = [];
  for (const design of await readAllDesigns(deps.designs)) {
    for (const from of sources) {
      if (!placesRecord(design, kind, from.id)) continue;
      const impact = adoptImpact(db, design, kind, from.id, target.id);
      if (impact !== undefined) impacts.push({ ...impact, etag: contentETag(design) });
    }
  }
  impacts.sort((a, b) => a.label.localeCompare(b.label) || a.design.localeCompare(b.design));
  return { status: 200, body: { kind, id, family, target, impacts } };
}

interface AdoptBody {
  to: string;
  designs: { id: string; from: string; etag?: string }[];
}

function readBody(body: unknown): AdoptBody | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { to?: unknown; designs?: unknown };
  if (typeof b.to !== 'string' || !Array.isArray(b.designs) || b.designs.length === 0 || b.designs.length > 500) return undefined;
  const designs: AdoptBody['designs'] = [];
  for (const d of b.designs) {
    const e = (typeof d === 'object' && d !== null ? d : {}) as { id?: unknown; from?: unknown; etag?: unknown };
    if (typeof e.id !== 'string' || typeof e.from !== 'string') return undefined;
    designs.push({ id: e.id, from: e.from, ...(typeof e.etag === 'string' ? { etag: e.etag } : {}) });
  }
  return { to: b.to, designs };
}

async function adopt(deps: WorkbenchDeps, kind: AdoptKind, id: string, body: unknown, route: Route, as: Pick<ApiRequest, 'user'>): Promise<ApiResponse> {
  const req = readBody(body);
  if (req === undefined) return fail(400, 'Send { to, designs: [{ id, from, etag }] }.', 'Nothing was written.');
  const db = await deps.loadDb();
  const family = revisionFamily(db, kind, id);
  const to = family.find((s) => s.id === req.to);
  if (to === undefined) return fail(400, `'${req.to}' is not a revision of this part.`, 'Nothing was written.');
  const adopted: string[] = [];
  const refused: { id: string; error: string }[] = [];
  const events: NonNullable<ApiResponse['events']> = [];
  for (const entry of req.designs) {
    const from = family.find((s) => s.id === entry.from);
    if (from === undefined || from.id === to.id) {
      refused.push({ id: entry.id, error: `'${entry.from}' is not another revision of this part.` });
      continue;
    }
    const design = await deps.designs.read(entry.id);
    if (design === undefined) {
      refused.push({ id: entry.id, error: 'No such design.' });
      continue;
    }
    const next = adoptRevision(db, design, kind, from.id, to.id);
    if (next === design) {
      refused.push({ id: entry.id, error: `It no longer places ${from.name}.` });
      continue;
    }
    const answer = await route({ method: 'PUT', path: `/api/designs/${encodeURIComponent(entry.id)}`, body: next, headers: { 'if-match': entry.etag ?? contentETag(design) }, ...as }, deps);
    if (answer.status >= 400) {
      const error = (answer.body as { error?: unknown } | null)?.error;
      refused.push({ id: entry.id, error: typeof error === 'string' ? error : `Refused (${answer.status}).` });
      continue;
    }
    adopted.push(entry.id);
    events.push(...(answer.events ?? []));
  }
  if (adopted.length === 0) return { status: 409, body: { error: 'No design was switched.', adopted, refused } };
  return { status: 200, body: { adopted, refused, to }, ...(events.length === 0 ? {} : { events }) };
}

/* ------------------------------------------------------------------ *
 * Sub-assemblies: parents pinned to an older saved version
 * ------------------------------------------------------------------ */

async function designView(deps: WorkbenchDeps, id: string): Promise<ApiResponse> {
  const db = withAssemblies(await deps.loadDb(), await assemblyLibrary(deps, [id]));
  const released = releasedRevisions(db.assemblies, id);
  const to = released[released.length - 1];
  const impacts: (SubassemblyAdoptImpact & { etag: string })[] = [];
  if (to !== undefined) {
    for (const design of await readAllDesigns(deps.designs)) {
      const pins = new Set(subassembliesOf(design).filter((s) => s.def === id && newerReleasedRevision(db, id, s.rev) !== undefined).map((s) => s.rev!));
      for (const from of [...pins].sort((a, b) => a - b)) {
        const impact = subassemblyAdoptImpact(db, design, id, from, to);
        if (impact !== undefined) impacts.push({ ...impact, etag: contentETag(design) });
      }
    }
  }
  impacts.sort((a, b) => a.label.localeCompare(b.label) || a.design.localeCompare(b.design));
  return { status: 200, body: { kind: 'designs', id, ...(to === undefined ? {} : { to }), impacts } };
}

async function adoptDesign(deps: WorkbenchDeps, id: string, body: unknown, route: Route, as: Pick<ApiRequest, 'user'>): Promise<ApiResponse> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { to?: unknown; designs?: unknown };
  const designs = Array.isArray(b.designs) ? (b.designs as { id?: unknown; from?: unknown; etag?: unknown }[]) : [];
  if (typeof b.to !== 'number' || designs.length === 0 || designs.length > 500 || designs.some((d) => typeof d?.id !== 'string' || typeof d.from !== 'number')) {
    return fail(400, 'Send { to: <rev>, designs: [{ id, from: <rev>, etag }] }.', 'Nothing was written.');
  }
  const to = b.to;
  const db = withAssemblies(await deps.loadDb(), await assemblyLibrary(deps, [id]));
  if (!releasedRevisions(db.assemblies, id).includes(to)) return fail(400, `Rev ${to} of '${id}' is not a released version.`, 'Nothing was written.');
  const adopted: string[] = [];
  const refused: { id: string; error: string }[] = [];
  const events: NonNullable<ApiResponse['events']> = [];
  for (const entry of designs as { id: string; from: number; etag?: unknown }[]) {
    const design = await deps.designs.read(entry.id);
    if (design === undefined) {
      refused.push({ id: entry.id, error: 'No such design.' });
      continue;
    }
    const next = adoptSubassemblyRevision(db, design, id, entry.from, to);
    if (next === design) {
      refused.push({ id: entry.id, error: `It is no longer pinned to Rev ${entry.from}.` });
      continue;
    }
    const answer = await route({ method: 'PUT', path: `/api/designs/${encodeURIComponent(entry.id)}`, body: next, headers: { 'if-match': typeof entry.etag === 'string' ? entry.etag : contentETag(design) }, ...as }, deps);
    if (answer.status >= 400) {
      const error = (answer.body as { error?: unknown } | null)?.error;
      refused.push({ id: entry.id, error: typeof error === 'string' ? error : `Refused (${answer.status}).` });
      continue;
    }
    adopted.push(entry.id);
    events.push(...(answer.events ?? []));
  }
  if (adopted.length === 0) return { status: 409, body: { error: 'No design was re-pinned.', adopted, refused } };
  return { status: 200, body: { adopted, refused, to }, ...(events.length === 0 ? {} : { events }) };
}

export async function handleAdoptRequest(request: ApiRequest, parts: string[], deps: WorkbenchDeps, route: Route): Promise<ApiResponse> {
  const [, , kind, id, extra] = parts;
  if (kind === undefined || id === undefined || extra !== undefined) return fail(404, 'Use /api/adopt/:kind/:id.');
  if (kind === 'designs') {
    const m = request.method.toUpperCase();
    if (m === 'GET') return designView(deps, id);
    if (m === 'POST') return adoptDesign(deps, id, request.body, route, request.user === undefined ? {} : { user: request.user });
    return { status: 405, headers: { Allow: 'GET, POST' }, body: { error: `${m} is not allowed here.` } };
  }
  if (!isAdoptKind(kind)) return fail(404, `Only boards and mechanical parts carry revisions of their own (not ${kind}).`);
  const method = request.method.toUpperCase();
  if (method === 'GET') {
    const to = new URLSearchParams(request.path.split('?')[1] ?? '').get('to') ?? undefined;
    return view(deps, kind, id, to);
  }
  if (method === 'POST') return adopt(deps, kind, id, request.body, route, request.user === undefined ? {} : { user: request.user });
  return { status: 405, headers: { Allow: 'GET, POST' }, body: { error: `${method} is not allowed here.` } };
}
