/**
 * A saved design version's package carries the enclosure generation the version
 * pinned and the device export made from that version; a working-copy export is never used, and
 * what is not there is listed under `missing`. Synthetic data, memory stores.
 */

import { createHash } from 'node:crypto';

import type { DesignVersionFile } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { handleReproRequest } from '../server/repro/api.ts';
import { zipEntries } from '../server/repro/inside.ts';
import type { ToolOutputStore, ToolRunRecord } from '../server/tools/outputs.ts';

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const DESIGN = 'synthetic-device';
const SHELL = 'synthetic-shell';
const STL = 'solid rev0 shell';

const version = {
  format: 'wirehub/design-version@2', designId: DESIGN, rev: 0, savedAt: '2026-10-01T00:00:00Z', savedBy: 'tester', note: '',
  design: { id: DESIGN, label: 'Synthetic device', instances: { connectors: [], segments: [], pcbas: [], mechanical: [{ id: 'm1', def: SHELL }] }, device: { parts: [] } },
  definitions: { connectors: [], bodies: [], interfaces: [], wires: [], components: [], pcbas: [], mechanicals: [{ id: SHELL, label: 'Synthetic shell', enclosure: {} }] },
  depictions: {}, history: [],
  inputs: { format: 'wirehub/effective-inputs@1', capturedAt: '2026-10-01T00:00:00Z', source: 'version-save', inputs: [] },
  device: {
    enclosures: { [SHELL]: { generatedAt: '2026-10-01T00:00:00Z', pack: 'enclosure', packVersion: '1', requestSha256: hex('req'), result: {}, outputs: [{ role: 'shell-stl', path: 'shell.stl', mediaType: 'model/stl', sha256: hex(STL), asset: hex(STL), bytes: STL.length }] } },
    boards: {},
  },
} as unknown as DesignVersionFile;

// a working-copy export made after Rev 0, from changed inputs
const workingExport: ToolRunRecord = {
  id: '33333333-3333-4333-8333-333333333333', record: `designs/${DESIGN}`, identity: {}, sources: [], pack: 'enclosure', packVersion: '1', image: 'wirehub-tool-enclosure:1',
  imageId: `sha256:${'0'.repeat(64)}`, tool: { name: 'enclosure', version: '1' }, op: 'device-assemble', params: { design: { id: DESIGN } }, status: 'ok', findings: [],
  createdAt: '2026-10-05T00:00:00Z', outputs: [],
};

describe('saved-version package device', () => {
  it('carries the pinned enclosure outputs and lists the missing Rev export instead of a working-copy one', async () => {
    const outputs: ToolOutputStore = {
      register: () => Promise.reject(new Error('read only')),
      runs: (record) => Promise.resolve(record === `designs/${DESIGN}` ? [workingExport] : []),
      run: () => Promise.resolve(undefined),
      log: () => Promise.resolve(''),
      file: () => undefined,
    };
    const assets = { get: (id: string) => (id === hex(STL) ? { record: {}, bytes: Buffer.from(STL) } : undefined) };
    const deps = { versions: { read: (id: string, rev: number) => (id === DESIGN && rev === 0 ? version : undefined) }, toolOutputs: outputs, assets } as unknown as WorkbenchDeps;
    const answer = await handleReproRequest({ method: 'GET', path: `/api/repro/designs/${DESIGN}/0/package` } as Parameters<typeof handleReproRequest>[0], deps);
    expect(answer.status).toBe(200);
    const zip = zipEntries(new Uint8Array(answer.bytes!))!;
    const manifest = JSON.parse(new TextDecoder().decode(zip.get([...zip.keys()].find((k) => k.endsWith('/manifest.json'))!))) as { runs: { id: string }[]; missing?: { what: string }[]; files: { path: string; sha256: string }[] };
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: `outputs/enclosure-${SHELL}/shell.stl`, sha256: hex(STL) }));
    expect(manifest.runs.map((r) => r.id)).not.toContain(workingExport.id);
    expect(manifest.missing?.map((m) => m.what)).toEqual([`designs/${DESIGN} device-assemble`]);
  });
});
