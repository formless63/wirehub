/**
 * Sub-assemblies in the editor: where the designs a cable places come from.
 *
 * The model reads a placed design (and the saved versions a reference may be
 * pinned to) from `Db.assemblies`. The editor never fetches: a host that
 * supports sub-assemblies hands it an `AssembliesAdapter`, the editor asks it
 * for the designs the cable places (and for one about to be placed), and lays
 * what comes back over the library it was given. A host without one can still
 * pass a `db` that already carries `assemblies`.
 */

import { placedDesignIds, withAssemblies, type AssemblyLibrary, type CableDesign, type Db } from '@wirehub/model';

import type { Outcome } from './persistence.ts';

export interface AssembliesAdapter {
  /** the library these designs reach: their working copies and saved versions, and the designs they place, transitively */
  load(ids: readonly string[]): Promise<Outcome<AssemblyLibrary>>;
}

/** Two libraries as one: the later one's copy of a design or version wins. */
export function mergeLibraries(a: AssemblyLibrary | undefined, b: AssemblyLibrary | undefined): AssemblyLibrary | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const working = new Map(a.working.map((d) => [d.id, d]));
  for (const d of b.working) working.set(d.id, d);
  const versions = new Map((a.versions ?? []).map((v) => [`${v.designId}@${v.rev}`, v]));
  for (const v of b.versions ?? []) versions.set(`${v.designId}@${v.rev}`, v);
  return { working: [...working.values()], versions: [...versions.values()] };
}

/** `db` with `library` laid over whatever library it already carries. */
export function dbWithLibrary(db: Db, library: AssemblyLibrary | undefined): Db {
  const merged = mergeLibraries(db.assemblies, library);
  return merged === undefined || merged === db.assemblies ? db : withAssemblies(db, merged);
}

/** The designs `design` places that `library` does not hold yet. */
export function missingDesigns(design: CableDesign, library: AssemblyLibrary | undefined, extra: readonly string[] = []): string[] {
  const held = new Set([...(library?.working ?? []).map((d) => d.id), ...(library?.versions ?? []).map((v) => v.designId)]);
  return [...new Set([...placedDesignIds(design), ...extra])].filter((id) => !held.has(id)).sort();
}

/** The saved versions of a placed design the library knows, newest first. */
export function versionsOf(library: AssemblyLibrary | undefined, designId: string): { rev: number; released: boolean }[] {
  return (library?.versions ?? [])
    .filter((v) => v.designId === designId)
    .map((v) => ({ rev: v.rev, released: v.released }))
    .sort((x, y) => y.rev - x.rev);
}
