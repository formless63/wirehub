/**
 * A saved design version's package carries the board outputs made from the board as
 * that version froze it, never a newer run. Synthetic data, memory stores.
 */

import { createHash } from 'node:crypto';

import type { DesignVersionFile } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { handleReproRequest } from '../server/repro/api.ts';
import { zipEntries } from '../server/repro/inside.ts';
import { boardRunsAsSaved, frozenBoards } from '../server/repro/frozen-boards.ts';
import type { ToolOutputStore, ToolRunRecord } from '../server/tools/outputs.ts';

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const BOARD = 'synthetic-adapter';
const DESIGN = 'synthetic-device';

function run(id: string, revision: string, source: string, gerber: string, createdAt: string): ToolRunRecord {
  return {
    id, record: `pcbas/${BOARD}`, identity: { revision }, sources: [{ role: 'kicad-pcb', path: `data/sources/${source}.kicad_pcb.txt`, sha256: source }],
    pack: 'kicad', packVersion: '1', image: 'wirehub-tool-kicad:1', imageId: `sha256:${'0'.repeat(64)}`, tool: { name: 'kicad-cli', version: '10' },
    op: 'gerbers', params: {}, status: 'ok', findings: [], createdAt,
    outputs: [{ path: 'board.gbr', role: 'gerber', mediaType: 'application/vnd.gerber', size: gerber.length, sha256: hex(gerber) }],
  };
}

function version(revision: string): DesignVersionFile {
  return {
    format: 'wirehub/design-version@2', designId: DESIGN, rev: 1, savedAt: '2026-10-01T00:00:00Z', savedBy: 'tester', note: '',
    design: { id: DESIGN, label: 'Synthetic device', instances: { connectors: [], segments: [], pcbas: [{ id: 'b1', def: BOARD }] } },
    definitions: { connectors: [], bodies: [], interfaces: [], wires: [], components: [], mechanicals: [], pcbas: [{ id: BOARD, label: 'Synthetic adapter', revision }] },
    depictions: {}, history: [],
    inputs: { format: 'wirehub/effective-inputs@1', capturedAt: '2026-10-01T00:00:00Z', source: 'version-save', inputs: [{ kind: 'pcbas', id: BOARD, revision, hash: 'sha256:x' }] },
  } as unknown as DesignVersionFile;
}

async function manifestOf(file: DesignVersionFile, runs: ToolRunRecord[]): Promise<{ runs: { id: string }[]; missing?: { what: string; why: string }[]; files: { path: string }[] }> {
  const bytes = new Map<string, string>([['rev1 gerber', ''], ['rev2 gerber', '']].map(([t]) => [hex(t!), t!]));
  const outputs: ToolOutputStore = {
    register: () => Promise.reject(new Error('read only')),
    runs: (record) => Promise.resolve(record === `pcbas/${BOARD}` ? runs : []),
    run: (id) => Promise.resolve(runs.find((r) => r.id === id)),
    log: () => Promise.resolve(''),
    file: (sha) => (bytes.has(sha) ? { bytes: new TextEncoder().encode(bytes.get(sha)!), mediaType: 'application/vnd.gerber', filename: 'board.gbr' } : undefined),
  };
  const deps = { versions: { read: (id: string, rev: number) => (id === DESIGN && rev === 1 ? file : undefined) }, toolOutputs: outputs } as unknown as WorkbenchDeps;
  const answer = await handleReproRequest({ method: 'GET', path: `/api/repro/designs/${DESIGN}/1/package` } as Parameters<typeof handleReproRequest>[0], deps);
  expect(answer.status).toBe(200);
  const zip = zipEntries(new Uint8Array(answer.bytes!))!;
  const name = [...zip.keys()].find((k) => k.endsWith('/manifest.json'))!;
  return JSON.parse(new TextDecoder().decode(zip.get(name))) as Awaited<ReturnType<typeof manifestOf>>;
}

describe('saved-version package board outputs', () => {
  const rev1 = run('11111111-1111-4111-8111-111111111111', 'Rev1', 'a'.repeat(64), 'rev1 gerber', '2026-10-01T00:00:00Z');
  const rev2 = run('22222222-2222-4222-8222-222222222222', 'Rev2', 'b'.repeat(64), 'rev2 gerber', '2026-10-05T00:00:00Z');

  it('takes the run of the frozen board, not the newer one', async () => {
    const m = await manifestOf(version('Rev1'), [rev2, rev1]);
    expect(m.runs.map((r) => r.id)).toEqual([rev1.id]);
    expect(m.files.some((f) => f.path.endsWith('board.gbr'))).toBe(true);
    expect((m.missing ?? []).filter((x) => x.what === `pcbas/${BOARD} gerbers`)).toEqual([]);
  });

  it('lists the op as missing when only a newer run is kept', async () => {
    const m = await manifestOf(version('Rev1'), [rev2]);
    expect(m.runs).toEqual([]);
    expect(m.missing?.map((x) => x.what)).toEqual([`pcbas/${BOARD} gerbers`]);
  });

  it('matches the saved native source when a newer board keeps the same revision', async () => {
    const file = version('Rev1');
    file.depictions[BOARD] = { 'meta.json': `sha256:${hex('saved artwork metadata')}` };
    const [board] = await frozenBoards(file, [BOARD], async () => new TextEncoder().encode(JSON.stringify({ sources: [{ role: 'kicad-pcb', sha256: rev1.sources[0]!.sha256 }] })));
    const changed = { ...rev2, identity: { revision: 'Rev1' } };
    expect(board).toMatchObject({ id: BOARD, source: rev1.sources[0]!.sha256, revision: 'Rev1' });
    expect(boardRunsAsSaved(board!, [changed, rev1]).runs.map((r) => r.id)).toEqual([rev1.id]);
    expect(boardRunsAsSaved(board!, [changed])).toMatchObject({ runs: [], missing: [{ what: `pcbas/${BOARD} gerbers` }] });
  });
});
