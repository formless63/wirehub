/**
 * Which board runs a saved design version's package may carry: only runs made from
 * the board as the version froze it — its native KiCad source (the sha256 its frozen artwork names)
 * or, when the version kept no source, its revision and build. A newer run is never substituted:
 * an op with runs but none of the frozen board is listed under `missing` with the reason.
 */

import { artworkBlobName, type DesignVersionFile } from '@wirehub/model';

import type { ToolRunRecord } from '../tools/outputs.ts';
import type { PackageMissing } from './package.ts';

/** A board as a saved version froze it. */
export interface FrozenBoard {
  id: string;
  /** sha256 of the native `kicad-pcb` source its frozen artwork was made from */
  source?: string;
  revision?: string;
  build?: string;
}

const kicadSource = (run: ToolRunRecord): string | undefined => run.sources.find((s) => s.role === 'kicad-pcb')?.sha256;

/** The newest ok run of each op made from `board` as frozen, and the ops that have none. */
export function boardRunsAsSaved(board: FrozenBoard, runs: readonly ToolRunRecord[]): { runs: ToolRunRecord[]; missing: PackageMissing[] } {
  const hasIdentity = board.revision !== undefined || board.build !== undefined;
  const matches = (run: ToolRunRecord): boolean =>
    board.source !== undefined ? kicadSource(run) === board.source
      : hasIdentity && run.identity.revision === board.revision && run.identity.build === board.build;
  const why = board.source !== undefined ? `no run of the board source this version saved (${board.source.slice(0, 19)}…) is kept; newer runs are not used`
    : hasIdentity ? `no run of ${[board.revision, board.build].filter((x) => x !== undefined).join(' · ')} as saved is kept; newer runs are not used`
      : 'this version kept no board source or revision to match a run to';
  const picked = new Map<string, ToolRunRecord>();
  const ops: string[] = [];
  for (const run of runs) {
    if (run.status !== 'ok') continue;
    if (!ops.includes(run.op)) ops.push(run.op);
    if (!picked.has(run.op) && matches(run)) picked.set(run.op, run);
  }
  return {
    runs: ops.flatMap((op) => (picked.has(op) ? [picked.get(op)!] : [])),
    missing: ops.filter((op) => !picked.has(op)).map((op) => ({ what: `pcbas/${board.id} ${op}`, why })),
  };
}

/** The frozen identity of each board a version used: its definition's revision/build and its artwork's KiCad source. */
export async function frozenBoards(
  file: DesignVersionFile,
  ids: readonly string[],
  readBlob: ((designId: string, blob: string) => Promise<Uint8Array | undefined> | Uint8Array | undefined) | undefined,
): Promise<FrozenBoard[]> {
  const out: FrozenBoard[] = [];
  for (const id of ids) {
    const def = file.definitions.pcbas.find((p) => p.id === id);
    let source: string | undefined;
    const art = file.depictions[id];
    const metaHash = art !== undefined && typeof art === 'object' ? art['meta.json'] : undefined;
    const blob = metaHash === undefined ? undefined : artworkBlobName('meta.json', metaHash);
    const bytes = blob === undefined ? undefined : await readBlob?.(file.designId, blob);
    if (bytes !== undefined) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(bytes)) as { sources?: { role?: unknown; sha256?: unknown }[] };
        const sha = meta.sources?.find((s) => s.role === 'kicad-pcb')?.sha256;
        if (typeof sha === 'string') source = sha;
      } catch {
        // unreadable artwork: match by revision
      }
    }
    out.push({
      id,
      ...(source === undefined ? {} : { source }),
      ...(def?.revision === undefined ? {} : { revision: def.revision }),
      ...(def?.build === undefined ? {} : { build: def.build }),
    });
  }
  return out;
}
