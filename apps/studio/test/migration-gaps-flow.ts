/**
 * Flows for the gaps a private shop's migration found, one body for both backends
 * (`migration-gaps.server.test.ts`, `pg/migration-gaps.server.test.ts`):
 *
 * - `runSchemeAndSelectorsFlow`: a numbering scheme with exclusions, range unions and multi-segment matches through
 *   Settings' check, and a `cable-end` rule through the rules test;
 * - `runBenchRulesPackFlow`: a data pack's `bench-rules.json` is read at runtime, follows install, update and
 *   disable, and a bad rule refuses the pack;
 * - `runPadMapPreviewFlow`: a pack that ships an auxiliary PCBA pad table is previewed with the
 *   same data the installed catalog will have, so preview validation equals post-install validation.
 */

import { loadDesigns } from '@wirehub/catalog';
import { renderBuildSheet } from '@wirehub/docs';
import { validateDesign, type CableDesign, type Db } from '@wirehub/model';
import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';

export const OWNER: StudioUser = { name: 'Olive Owner', source: 'session', role: 'owner' };

export interface FlowCall {
  (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>): Promise<{ status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array }>;
}

const SRC = 'synthetic example: migration-gap flow';

/** the starter terminal-board design, landing its ground on a named pad, as a pack's design file */
function padDesign(): CableDesign {
  const base = structuredClone(loadDesigns().find((d) => d.id === 'de9-terminal-board') as CableDesign);
  base.id = 'pad-landing';
  base.label = 'Pad landing (synthetic)';
  base.joints = base.joints.map((j) => (j.b.instance === 'u1' && j.b.terminal === 'GND' ? { ...j, b: { ...j.b, pad: 'GND1' } } : j));
  return base;
}

const PAD_TABLE = { src: SRC, boards: { 'pair-terminal-board': { src: SRC, terminals: { GND: [{ ref: 'GND1', side: 'top' }, { ref: 'GND2', side: 'bottom' }] } } } };

const padPack = (withPads: boolean, version: string) => ({
  format: 1,
  manifest: { format: 1, id: 'pad-pack', name: 'Pad pack', version, license: 'CC0-1.0' },
  files: {
    'components.json': [{ id: 'pad-pack-r', label: '2 ohm resistor', kind: 'resistor', value: '2', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
    'designs/pad-landing.json': padDesign(),
    ...(withPads ? { 'pcba-pads.json': PAD_TABLE } : {}),
  },
});

export async function runPadMapPreviewFlow(call: FlowCall): Promise<void> {
  // without the pad table the design names a pad nobody declared: the preview says so and refuses
  const bare = await call('POST', '/api/packs/install', { bundle: padPack(false, '1.0.0') }, OWNER);
  expect(bare.status, JSON.stringify(bare.body)).toBe(200);
  expect(bare.body.applicable).toBe(false);
  expect(JSON.stringify(bare.body.plan.issues)).toContain('pad-unknown');

  // with it, the preview loads the pack's pad table: no errors, the same as after the install
  const preview = await call('POST', '/api/packs/install', { bundle: padPack(true, '1.0.0') }, OWNER);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.plan.issues).toEqual([]);
  expect(preview.body.applicable).toBe(true);

  const done = await call('POST', '/api/packs/install', { bundle: padPack(true, '1.0.0'), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.installed).toBe(true);
  const db = (await call('GET', '/api/db')).body as Db;
  expect(db.pcbas.find((p) => p.id === 'pair-terminal-board')?.terminals.find((t) => t.id === 'GND')?.pads?.map((p) => p.ref)).toEqual(['GND1', 'GND2']);
  const design = (await call('GET', '/api/designs/pad-landing')).body as CableDesign;
  expect(validateDesign(design, db).filter((i) => i.severity === 'error')).toEqual([]);

  // an update that drops the pad table is previewed with the table gone: the pack's own design now fails, and the plan says so
  const update = await call('POST', '/api/packs/install', { bundle: padPack(false, '1.0.1') }, OWNER);
  expect(update.status, JSON.stringify(update.body)).toBe(200);
  expect(update.body.kind).toBe('update');
  expect(update.body.applicable).toBe(false);
  expect(JSON.stringify(update.body.plan.issues)).toContain('pad-unknown');
  expect(update.body.plan.diff.removed.map((r: any) => [r.file, r.id])).toEqual([['pcba-pads.json', 'pair-terminal-board']]);
  // keeping the table (a patch version) is fine
  const keep = await call('POST', '/api/packs/install', { bundle: padPack(true, '1.0.1') }, OWNER);
  expect(keep.body.plan.issues).toEqual([]);
  expect(keep.body.applicable).toBe(true);

  // disabling the pack takes its pad table with it
  const gone = await call('DELETE', '/api/packs/pad-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const after = (await call('GET', '/api/db')).body as Db;
  expect(after.pcbas.find((p) => p.id === 'pair-terminal-board')?.terminals.find((t) => t.id === 'GND')?.pads).toBeUndefined();
}

const benchRule = (text: string) => ({ id: 'pack-prep', phase: 'prep', src: SRC, steps: [{ text, src: 'synthetic example: a pack work instruction' }] });
const benchPack = (version: string, rules: unknown[]) => ({
  format: 1,
  manifest: { format: 1, id: 'bench-pack', name: 'Bench pack', version, license: 'CC0-1.0' },
  files: {
    'components.json': [{ id: 'bench-pack-r', label: '3 ohm resistor', kind: 'resistor', value: '3', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
    'bench-rules.json': rules,
  },
});

export async function runBenchRulesPackFlow(call: FlowCall): Promise<void> {
  const sheet = async (): Promise<string> => {
    const db = (await call('GET', '/api/db')).body as Db;
    const design = (await call('GET', '/api/designs/de9-crossover')).body as CableDesign;
    return renderBuildSheet(design, db);
  };
  const generic = await sheet();
  expect(generic).toContain('Cut to length');

  // a pack whose bench rule cannot be printed is refused whole, the problem named
  const bad = await call('POST', '/api/packs/install', { bundle: benchPack('1.0.0', [{ ...benchRule('x'), id: 'Bad Id' }]), apply: true }, OWNER);
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toMatch(/bench-rules\.json.*kebab-case/);
  expect(await sheet()).toBe(generic);

  // install: the sheet prints the pack's steps at once, with no restart and no module code
  const done = await call('POST', '/api/packs/install', { bundle: benchPack('1.0.0', [benchRule('Strip per PACK-WI-1.')]), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.installed).toBe(true);
  expect(((await call('GET', '/api/db')).body as Db).benchRules?.map((r) => r.id)).toEqual(['pack-prep']);
  const installed = await sheet();
  expect(installed).toContain('Strip per PACK-WI-1.');
  expect(installed).not.toContain('Cut to length');

  // update: the changed rule replaces the old one
  const update = await call('POST', '/api/packs/install', { bundle: benchPack('1.0.1', [benchRule('Strip per PACK-WI-2.')]), apply: true }, OWNER);
  expect(update.status, JSON.stringify(update.body)).toBe(200);
  expect(update.body.kind).toBe('update');
  const updated = await sheet();
  expect(updated).toContain('Strip per PACK-WI-2.');
  expect(updated).not.toContain('PACK-WI-1');

  // disable: the pack's rules go with it and the generic steps are back
  const gone = await call('DELETE', '/api/packs/bench-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  expect(((await call('GET', '/api/db')).body as Db).benchRules).toBeUndefined();
  expect(await sheet()).toBe(generic);
}

const GAP_SCHEME = {
  type: 'declarative',
  id: 'gap-scheme',
  template: '{level}{type}-{seq}',
  segments: [
    { id: 'level', type: 'choice', values: [{ value: '1', kinds: ['connector', 'wire'] }, { value: '2', kinds: ['design'] }] },
    { id: 'type', type: 'choice', values: [{ value: 'C', kinds: ['connector'] }, { value: 'W', kinds: ['wire'] }, { value: 'A', kinds: ['design'] }] },
    {
      id: 'seq',
      type: 'counter',
      width: 4,
      per: ['level', 'type'],
      exclude: [13],
      ranges: [
        { match: [{ level: '1', type: 'C' }, { level: '2', type: 'A' }], spans: [{ from: 10, to: 14 }, { from: 100, to: 101 }], exclude: [{ from: 11, to: 12 }] },
        { from: 1, to: 99 },
      ],
    },
  ],
  src: SRC,
};

export async function runSchemeAndSelectorsFlow(call: FlowCall): Promise<void> {
  // the scheme: spans hop over the gap, exclusions are skipped, a combination that matches no list keeps its own range
  const preview = await call('POST', '/api/settings/part-numbers/preview', { scheme: GAP_SCHEME, samples: ['1C-0012', '1C-0013', '1C-0050', '1C-0014'], suggest: [{ kind: 'connector' }, { kind: 'wire' }, { kind: 'design' }] }, OWNER);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.suggestions.map((x: any) => x.suggestion?.pn)).toEqual(['1C-0010', '1W-0001', '2A-0010']);
  const text = JSON.stringify(preview.body);
  expect(text).toContain('pn-excluded');
  expect(text).toContain('pn-out-of-range');
  // refused with the problem named, nothing saved
  const bad = await call('POST', '/api/settings/part-numbers/preview', { scheme: { ...GAP_SCHEME, segments: GAP_SCHEME.segments.map((x: any) => (x.id === 'seq' ? { ...x, exclude: [{ from: 9, to: 1 }] } : x)) } }, OWNER);
  expect(JSON.stringify(bad.body)).toMatch(/from <= to/);

  // the selectors: each cable end of the starter's DE-9 to terminal board design, tested over every design
  const rule = {
    id: 'end-needs-board-pn',
    severity: 'warning',
    each: 'cable-end',
    where: { gt: [{ path: 'boardCount' }, 0] },
    require: { some: { in: 'boards', where: { startsWith: [{ path: 'partNumber' }, 'ZZZ'] } } },
    message: '{id}: the board here has no ZZZ part number',
    src: SRC,
  };
  const run = await call('POST', '/api/rules/preview', { rule }, OWNER);
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  expect(run.body.ok, JSON.stringify(run.body)).toBe(true);
  expect(run.body.designs.map((d: any) => [d.id, d.issues, d.examples[0].where])).toEqual([['de9-terminal-board', 1, 'w1@b']]);
  const view = await call('GET', '/api/rules', undefined, OWNER);
  expect(view.body.subjects.design).toContain('cable-end');
}
