/**
 * Where a tool-pack run is registered: the run (exact sources, pack, image,
 * tool version, params, findings, log) and its verified output bytes by
 * content address. Outputs are derived data — rebuildable from the source and
 * the pinned pack — so they are not catalog records and write no change set.
 * The database backend keeps them in `studio.tool_run` / `tool_output` with
 * the bytes as derived blobs (`pg/tool-outputs.ts`).
 */

import type { Awaitable } from '../storage/change-set.ts';
import type { ToolFinding } from './runner.ts';

export interface ToolRunSource {
  role: string;
  path: string;
  sha256: string;
  /** the file's own name, when the stored path does not carry it (a schematic sheet) */
  fileName?: string;
}

export interface ToolOutputFile {
  path: string;
  role: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface ToolRunRecord {
  id: string;
  jobId?: string;
  /** `<definition kind>/<id>`, e.g. `pcbas/synthetic-adapter` */
  record: string;
  /** the record's revision/build when the run was asked for */
  identity: { revision?: string; build?: string };
  sources: ToolRunSource[];
  pack: string;
  packVersion: string;
  image: string;
  imageId: string;
  tool: { name: string; version: string };
  op: string;
  params: Record<string, unknown>;
  status: 'ok' | 'failed';
  findings: ToolFinding[];
  outputs: ToolOutputFile[];
  durationMs?: number;
  createdAt: string;
}

export interface ToolOutputStore {
  /** register a finished run and its output bytes (each verified against its sha256 by the runner) */
  register(run: Omit<ToolRunRecord, 'id' | 'createdAt'> & { log: string }, bytes: ReadonlyMap<string, Uint8Array>): Promise<ToolRunRecord>;
  /** a record's runs, newest first */
  runs(record: string, options?: { limit?: number }): Promise<ToolRunRecord[]>;
  /** one run by id (re-run and compare, packages); optional so a store may leave it out */
  run?(runId: string): Promise<ToolRunRecord | undefined>;
  log(runId: string): Promise<string | undefined>;
  /** an output's bytes by content address, when a run still names it */
  file(sha256: string): Awaitable<{ bytes: Uint8Array; mediaType: string; filename: string } | undefined>;
}

/** The newest ok run of each op: what a record's views and downloads show. */
export function latestByOp(runs: readonly ToolRunRecord[]): ToolRunRecord[] {
  const seen = new Set<string>();
  const out: ToolRunRecord[] = [];
  for (const run of runs) {
    if (run.status !== 'ok' || seen.has(run.op)) continue;
    seen.add(run.op);
    out.push(run);
  }
  return out;
}
