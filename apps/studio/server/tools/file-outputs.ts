/**
 * Tool-pack runs on the file backend (`tools/outputs.ts`): each run a JSON file, each output's bytes
 * a content-addressed file, in a gitignored directory beside the catalog (`data/.tool-outputs/`). Derived data like the model cache: rebuildable, never a catalog
 * record. Keeps the newest few runs of each record, op and pack, as the database backend does;
 * bytes no kept run names go with them.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { dataPath } from '@wirehub/catalog';

import { writeFileAtomic } from '../atomic-write.ts';
import type { ToolOutputStore, ToolRunRecord } from './outputs.ts';

/** runs kept per record, op and pack (the database backend keeps as many) */
const KEEP = 5;
const MAX_LOG = 200_000;
const SHA = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f-]{36}$/;

type Stored = ToolRunRecord & { log: string };

export function fileToolOutputStore(root: string = dataPath('.tool-outputs')): ToolOutputStore {
  const runsDir = join(root, 'runs');
  const filesDir = join(root, 'files');
  const all = (): Stored[] => {
    if (!existsSync(runsDir)) return [];
    const out: Stored[] = [];
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(runsDir, name), 'utf8')) as Stored);
      } catch {
        // a half-written or foreign file is not a run
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  };
  const strip = ({ log: _log, ...run }: Stored): ToolRunRecord => run;
  return {
    async register(run, bytes) {
      mkdirSync(runsDir, { recursive: true });
      mkdirSync(filesDir, { recursive: true });
      // the bytes first (content-addressed: a retry is harmless), then the run that names them
      for (const output of run.outputs) {
        const data = bytes.get(output.path);
        if (data === undefined) throw new Error(`no bytes for output ${output.path}`);
        if (!SHA.test(output.sha256)) throw new Error(`output ${output.path} has no sha256`);
        const path = join(filesDir, output.sha256);
        if (!existsSync(path)) writeFileAtomic(path, data);
      }
      const stored: Stored = { ...run, id: randomUUID(), createdAt: new Date().toISOString(), log: run.log.slice(-MAX_LOG) };
      writeFileAtomic(join(runsDir, `${stored.id}.json`), JSON.stringify(stored));
      // keep the newest few of this record/op/pack; drop the bytes no kept run names
      const runs = all();
      const same = runs.filter((r) => r.record === run.record && r.op === run.op && r.pack === run.pack);
      const dropped = same.slice(KEEP);
      if (dropped.length > 0) {
        for (const r of dropped) rmSync(join(runsDir, `${r.id}.json`), { force: true });
        const named = new Set(runs.filter((r) => !dropped.includes(r)).flatMap((r) => r.outputs.map((o) => o.sha256)));
        for (const sha of new Set(dropped.flatMap((r) => r.outputs.map((o) => o.sha256)))) if (!named.has(sha)) rmSync(join(filesDir, sha), { force: true });
      }
      return strip(stored);
    },
    async runs(record, options = {}) {
      return all().filter((r) => r.record === record).slice(0, options.limit ?? 30).map(strip);
    },
    async log(runId) {
      if (!RUN_ID.test(runId)) return undefined;
      const path = join(runsDir, `${runId}.json`);
      if (!existsSync(path)) return undefined;
      return (JSON.parse(readFileSync(path, 'utf8')) as Stored).log;
    },
    file(sha) {
      if (!SHA.test(sha)) return undefined;
      const path = join(filesDir, sha);
      if (!existsSync(path)) return undefined;
      const output = all().flatMap((r) => r.outputs).find((o) => o.sha256 === sha);
      if (output === undefined) return undefined;
      return { bytes: new Uint8Array(readFileSync(path)), mediaType: output.mediaType, filename: output.path.split('/').pop() ?? output.path };
    },
  };
}
