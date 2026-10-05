/** Documents of a design built from sub-assemblies: one BOM line each (or exploded), a referenced build sheet, a flattened continuity spec. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign, loadDesigns } from '@wirehub/catalog';
import { createVersion, withAssemblies, type CableDesign, type Db } from '@wirehub/model';

import {
  baseExport,
  buildSheetMarkdown,
  deriveBom,
  deriveBomSheet,
  deriveContinuityExport,
  deriveTestSpec,
  renderBuildSheet,
  unaccountedInstances,
} from '../src/index.ts';

/** Plain rows of a CSV with no quoted commas in the columns read here. */
const parseCsv = (text: string): string[][] => text.trim().split('\n').map((line) => line.split(','));

const live = loadDb();
const db: Db = withAssemblies(live, { working: loadDesigns() });
const y = (): CableDesign => structuredClone(loadDesign('dc-y-from-leads'));

describe('the BOM', () => {
  it('lists each sub-assembly as one line, by the placed design', () => {
    const bom = deriveBom(y(), db);
    const subs = bom.lines.filter((l) => l.category === 'subassembly');
    expect(subs.map((l) => [l.provenance, l.ref, l.value, l.location])).toEqual([
      [['lead-1'], 'dc-pigtail-lead', 'working copy (not frozen)', 'first output'],
      [['lead-2'], 'dc-pigtail-lead', 'working copy (not frozen)', 'second output'],
    ]);
    expect(subs[0]!.subassembly).toEqual({ design: 'dc-pigtail-lead' });
    // the lead's own parts are its own BOM's, not this one's
    expect(bom.lines.map((l) => l.ref)).not.toContain('jst-xh-2-dc');
    expect(bom.lines.find((l) => l.ref === 'terminal-block-4')?.detail).toContain('attaches: sub-assemblies lead-1, lead-2');
    expect(unaccountedInstances(y(), bom)).toEqual([]);
  });

  it('carries the placed design\'s part number and the pinned revision, folding equal references', () => {
    const lead = { ...loadDesign('dc-pigtail-lead'), productRef: 'CBL-00042' };
    const file = createVersion({ design: lead, db: live, rev: 3, at: '2026-10-05T00:00:00.000Z', by: 'tester', note: 'released' });
    const on = withAssemblies(live, {
      working: [...loadDesigns().filter((d) => d.id !== lead.id), lead],
      versions: [{ designId: lead.id, rev: 3, released: true, design: file.design, definitions: file.definitions }],
    });
    const d = y();
    for (const s of d.instances.subassemblies!) {
      s.rev = 3;
      delete s.role;
    }
    const lines = deriveBom(d, on).lines.filter((l) => l.category === 'subassembly');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ qty: 2, partNumber: 'CBL-00042', value: 'Rev 3', provenance: ['lead-1', 'lead-2'], subassembly: { design: 'dc-pigtail-lead', rev: 3 } });
    const sheet = deriveBomSheet(d, on);
    expect(sheet.lines[0]).toMatchObject({ section: 'subassemblies', sku: 'CBL-00042', quantity: '2', subassembly: { design: 'dc-pigtail-lead', rev: 3 } });
  });

  it('explodes into the placed designs\' parts on request', () => {
    const bom = deriveBom(y(), db, { explode: true });
    expect(bom.lines.some((l) => l.category === 'subassembly')).toBe(false);
    const jst = bom.lines.find((l) => l.ref === 'jst-xh-2-dc')!;
    expect(jst.qty).toBe(2);
    expect(jst.provenance).toEqual(['lead-1/j1', 'lead-2/j1']);
    expect(bom.lines.find((l) => l.ref === 'xh-contact-socket')?.qty).toBe(4);
    expect(bom.lines.find((l) => l.category === 'wire')).toMatchObject({ ref: 'dc-2core-24awg', qty: 2 });
    expect(bom.lines.find((l) => l.ref === 'terminal-block-4')?.qty).toBe(1);
    // the sheet and the CSV follow the option
    expect(deriveBomSheet(y(), db, { explode: true }).lines.some((l) => l.section === 'subassemblies')).toBe(false);
    const rows = parseCsv(baseExport('bom.csv')!.render(y(), db, { explode: true }).body as string).slice(1);
    expect(rows.map((r) => r[0])).not.toContain('Sub-assemblies');
    expect(parseCsv(baseExport('bom.csv')!.render(y(), db).body as string).slice(1).filter((r) => r[0] === 'Sub-assemblies')).toHaveLength(2);
  });

  it('stays one line each without a design library', () => {
    const lines = deriveBom(y(), live, { explode: true }).lines.filter((l) => l.category === 'subassembly');
    expect(lines.map((l) => l.label)).toEqual(['dc-pigtail-lead', 'dc-pigtail-lead']);
  });
});

describe('the build sheet', () => {
  it('references each sub-assembly\'s own build sheet and lists what lands on its ports', () => {
    const html = renderBuildSheet(y(), db, { depictions: false });
    expect(html).toContain('Sub-assemblies — build each to its own sheet first');
    expect(html).toContain('build to the build sheet of dc-pigtail-lead (working copy — not frozen)');
    expect(html).toContain('w1@b:red · w1 end b (flying) +V → j1:1');
    // the lead is not inlined: none of its own landings are bench steps here
    expect(html).not.toContain('lead-1/w1');
    const md = buildSheetMarkdown(y(), db);
    expect(md).toContain('### Sub-assemblies — build each to its own sheet first');
    expect(md).toContain('build sheet of dc-pigtail-lead, working copy (not frozen)');
  });
});

describe('the continuity spec', () => {
  it('covers the flattened nets: the leads\' plugs are probe points of the finished Y', () => {
    const spec = deriveTestSpec(y(), db);
    const supply = spec.netChecks.find((c) => c.ports.some((p) => p.key === 'j1:1'))!;
    expect(supply.ports.map((p) => p.key)).toEqual(['j1:1', 'lead-1/j1:1', 'lead-2/j1:1']);
    expect(spec.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const data = deriveContinuityExport(y(), db);
    expect(data.points.map((p) => p.id)).toEqual(expect.arrayContaining(['lead-1/j1.1', 'lead-2/j1.2']));
    // the 0 V and +V nets of the two leads stay isolated from each other
    expect(spec.isolationChecks.length).toBeGreaterThan(0);
  });

  it('tests a flying lead on its own: its free ends are probe points', () => {
    const spec = deriveTestSpec(loadDesign('dc-pigtail-lead'), db);
    expect(spec.ports.filter((p) => p.role === 'flying lead').map((p) => p.key)).toEqual(['w1:black@b', 'w1:red@b']);
    expect(spec.netChecks).toHaveLength(2);
    expect(spec.openChecks).toEqual([]);
  });
});
