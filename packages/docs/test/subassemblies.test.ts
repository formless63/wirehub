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
    expect(html).toContain('w1@b:red · w1 destination end (flying) +V → j1:1');
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

describe('the cost roll-up', () => {
  /** prices on everything the pigtail lead and the Y use, in USD, and 6 minutes to build a lead */
  const priced = (): Db => {
    const lead = { ...loadDesign('dc-pigtail-lead'), labourMinutes: 6 };
    return withAssemblies(
      {
        ...live,
        rules: { costing: { currency: 'USD', labourRatePerHour: 60 } },
        connectors: live.connectors.map((c) => (c.id === 'jst-xh-2-dc' ? { ...c, cost: { unit: 0.5 } } : c.id === 'terminal-block-4' ? { ...c, cost: { unit: 2 } } : c)),
        mechanicals: (live.mechanicals ?? []).map((m) => (m.id === 'xh-contact-socket' ? { ...m, cost: { unit: 0.05, breaks: [{ minQty: 4, unit: 0.04 }] } } : m)),
        wires: live.wires.map((w) => (w.id === 'dc-2core-24awg' ? { ...w, cost: { unit: 1, per: 'm' as const } } : w)),
      },
      { working: [...loadDesigns().filter((d) => d.id !== lead.id), lead] },
    );
  };

  it('prices a sub-assembly at its own roll-up: its parts and its labour, at the quantity the build takes', () => {
    const on = priced();
    const own = deriveBomSheet({ ...loadDesign('dc-pigtail-lead'), labourMinutes: 6 }, on).cost!;
    // 0.5 housing + 2 × 0.05 contacts + 0.3 m × 1 wire + 6 min at 60/h
    expect(own.total).toBeCloseTo(0.5 + 0.1 + 0.3 + 6, 6);
    const cost = deriveBomSheet(y(), on).cost!;
    const leads = cost.lines.filter((l) => l.ref === 'dc-pigtail-lead');
    expect(leads.map((l) => l.unitPrice)).toEqual([own.total, own.total]);
    expect(cost.materials).toBeCloseTo(2 + 2 * own.total, 6);
    expect(cost.unpriced).toEqual([]);
    // one line of two (no roles): the lead is costed at two-off, where the contacts' 4-off break applies
    const folded = y();
    for (const s of folded.instances.subassemblies!) delete s.role;
    const line = deriveBomSheet(folded, on).cost!.lines.find((l) => l.ref === 'dc-pigtail-lead')!;
    expect(line.quantity).toBe(2);
    expect(line.unitPrice).toBeCloseTo(0.5 + 2 * 0.04 + 0.3 + 6, 6);
  });

  it('leaves a sub-assembly with nothing priced unpriced, and says when its price is a floor', () => {
    const bare = deriveBomSheet(y(), withAssemblies({ ...live, connectors: live.connectors.map((c) => (c.id === 'terminal-block-4' ? { ...c, cost: { unit: 2, currency: 'USD' } } : c)) }, { working: loadDesigns() })).cost!;
    expect(bare.unpriced.map((u) => u.ref)).toEqual(['dc-pigtail-lead', 'dc-pigtail-lead']);
    const on = priced();
    const partly: Db = { ...on, wires: live.wires };
    const cost = deriveBomSheet(y(), partly).cost!;
    expect(cost.notes.join(' ')).toContain('has parts without a price of its own');
  });
});

describe('the formboard', () => {
  it('lays the sub-assemblies\' runs out with the design\'s own', async () => {
    const { deriveFormboard } = await import('../src/formboard.ts');
    const board = deriveFormboard(y(), db);
    expect(board.runs.map((r) => (r as { segment?: string }).segment)).toEqual(['lead-1/w1', 'lead-2/w1']);
  });
});
