/**
 * Records an installed pack owns are read-only where they are edited
 * (`docs/catalog-store.md` §3): the definition routes already refuse them
 * (`definitions.ts`), and this answers the same 409 for the two other kinds
 * of pack record — a vocabulary entry and a design — with the ways out:
 * an owner releases the pack to the hub, or "fork to edit" copies it under an
 * id of your own. A released pack is no longer in `packs`, so nothing here
 * guards its records.
 */

import type { InstalledPacks } from '@wirehub/catalog';

import type { ApiResponse } from './api.ts';
import type { Awaitable } from './storage/change-set.ts';

export interface PackGuardDeps {
  installedPacks?: () => Awaitable<InstalledPacks>;
}

/** The pack that added `id` to the catalog file `file` (`vocab/signals.json`), or, for a design (`designs/<id>.json`), that ships it. */
export async function packOwnerOf(deps: PackGuardDeps, file: string, id: string): Promise<{ pack: string; version: string } | undefined> {
  const installed = await deps.installedPacks?.();
  const pack = installed?.packs.find((p) => (file.startsWith('designs/') ? Object.hasOwn(p.added, file) : p.added[file]?.includes(id) === true));
  return pack === undefined ? undefined : { pack: pack.id, version: pack.version };
}

export function packRecordRefusal(noun: string, id: string, origin: { pack: string; version: string }, how: string): ApiResponse {
  return {
    status: 409,
    body: {
      error: `The ${noun} '${id}' comes from the ${origin.pack} pack (${origin.version}) and is read-only here.`,
      hint: `Nothing was changed. An owner can release the ${origin.pack} pack to this hub (Extensions, Installed, Release to this hub) to edit its records in place. Fork it to edit instead: ${how} While the pack is installed it updates and disables the records it ships, so a changed copy of your own is the way to keep an edit.`,
    },
  };
}
