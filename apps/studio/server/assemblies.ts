/**
 * Sub-assemblies on the server: the design library a design's references
 * reach (`Db.assemblies`), and "where used" for a design.
 *
 *   GET /api/assemblies?designs=a,b      the library starting from these designs (transitively)
 *   GET /api/designs/:id/used-in         the designs that place it, and the saved versions that pin it
 *
 * The model reads sub-assemblies from `Db.assemblies` and checks nothing
 * without it, so every handler that validates, renders or freezes a design
 * placing sub-assemblies goes through `withDesignLibrary`. A design placing
 * none is read exactly as before (no library is loaded for it).
 */

import { isDesignId } from '@wirehub/catalog';
import {
  hasSubassemblies,
  placedDesignIds,
  subassemblyParents,
  versionSummary,
  withAssemblies,
  type AssemblyLibrary,
  type AssemblyVersion,
  type CableDesign,
  type Db,
} from '@wirehub/model';

import type { ApiResponse } from './api.ts';
import { readAllDesigns, type DesignStore } from './designs.ts';
import { approvalPolicy } from './settings.ts';
import type { DocStore } from './storage/doc-store.ts';
import type { VersionStore } from './versions.ts';

export const ASSEMBLY_ROUTES = ['GET    /api/assemblies', 'GET    /api/designs/:id/used-in'] as const;

export interface AssemblyDeps {
  designs: DesignStore;
  versions?: VersionStore;
  /** the engineering settings: whether a version must be approved to count as released */
  docs?: DocStore;
}

/**
 * The library the designs `roots` reach: each one's working copy and saved
 * versions, then the designs those place, and so on. A version is released
 * when it is approved (approvals on) or saved (approvals off).
 */
export async function assemblyLibrary(deps: AssemblyDeps, roots: readonly string[]): Promise<AssemblyLibrary> {
  const approvals = (await approvalPolicy(deps.docs)).enabled;
  const working: CableDesign[] = [];
  const versions: AssemblyVersion[] = [];
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !isDesignId(id)) continue;
    seen.add(id);
    const design = await deps.designs.read(id);
    if (design !== undefined) {
      working.push(design);
      queue.push(...placedDesignIds(design));
    }
    for (const rev of (await deps.versions?.revisions(id)) ?? []) {
      const file = await deps.versions?.read(id, rev);
      if (file === undefined) continue;
      const summary = versionSummary(file);
      versions.push({
        designId: id,
        rev,
        released: approvals ? summary.approval?.state === 'approved' : true,
        design: { ...file.design, id },
        definitions: file.definitions,
      });
      queue.push(...placedDesignIds(file.design));
    }
  }
  return { working, versions };
}

/** `db` with the library `design`'s sub-assemblies reach; `db` itself when it places none. */
export async function withDesignLibrary(deps: AssemblyDeps, design: CableDesign, db: Db): Promise<Db> {
  if (!hasSubassemblies(design)) return db;
  return withAssemblies(db, await assemblyLibrary(deps, placedDesignIds(design)));
}

/** Where a design is placed as a sub-assembly: working copies, and saved versions pinning it. */
export interface DesignUse {
  designs: { id: string; label: string; instances: string[] }[];
  versions: { design: string; rev: number; instances: string[]; pinned?: number }[];
}

export async function designUse(deps: AssemblyDeps, id: string): Promise<DesignUse> {
  const all = await readAllDesigns(deps.designs);
  const designs = subassemblyParents(all, id);
  const versions: DesignUse['versions'] = [];
  for (const parent of all) {
    for (const rev of (await deps.versions?.revisions(parent.id)) ?? []) {
      const file = await deps.versions?.read(parent.id, rev);
      for (const sub of file?.design.instances.subassemblies ?? []) {
        if (sub.def !== id) continue;
        const entry = versions.find((v) => v.design === parent.id && v.rev === rev);
        if (entry === undefined) versions.push({ design: parent.id, rev, instances: [sub.id], ...(sub.rev === undefined ? {} : { pinned: sub.rev }) });
        else entry.instances.push(sub.id);
      }
    }
  }
  return { designs, versions };
}

/** The sentence a refused delete or rename gives, naming the designs that place `id`. */
export function usedAsSubassemblyRefusal(id: string, use: DesignUse, action: 'deleted' | 'renamed'): ApiResponse | undefined {
  if (use.designs.length === 0 && use.versions.length === 0) return undefined;
  const parents = [...new Set([...use.designs.map((d) => d.id), ...use.versions.map((v) => `${v.design} Rev ${v.rev}`)])];
  return {
    status: 409,
    body: {
      error: `'${id}' is placed as a sub-assembly in ${parents.length === 1 ? '' : `${parents.length} designs: `}${parents.join(', ')}, so it cannot be ${action}.`,
      hint: 'Remove it from those designs first (or set its status to Retired and leave it where it is).',
      usedIn: use,
    },
  };
}

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

/** `undefined` when the path is not one of the assembly routes. */
export async function handleAssemblyRequest(method: string, parts: string[], query: URLSearchParams, deps: AssemblyDeps): Promise<ApiResponse | undefined> {
  const [, head, id, action, ...rest] = parts;
  if (head === 'assemblies' && id === undefined) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    const roots = (query.get('designs') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    const bad = roots.find((r) => !isDesignId(r));
    if (bad !== undefined) return fail(400, `${JSON.stringify(bad)} cannot be used as a design id.`);
    return { status: 200, body: await assemblyLibrary(deps, roots) };
  }
  if (head === 'designs' && id !== undefined && action === 'used-in' && rest.length === 0) {
    if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
    if (!isDesignId(id)) return fail(400, `${JSON.stringify(id)} cannot be used as a design id.`);
    if (!(await deps.designs.has(id))) return fail(404, `There is no design called '${id}'.`, 'Pick one from GET /api/designs.');
    return { status: 200, body: await designUse(deps, id) };
  }
  return undefined;
}
