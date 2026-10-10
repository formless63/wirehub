/** Part-number health (cs-5k1.3): duplicates, unnumbered parts, disagreements — on the starter fixtures and a pluggable scheme. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesigns } from '@wirehub/catalog';

import { DEFAULT_PART_NUMBER_SCHEME, partNumberReport, validateDb, type Db, type PartNumberScheme } from '../src/index.ts';

const db = loadDb();
const designs = loadDesigns();

const clone = (): Db => structuredClone(db);

describe('part-number health on the starter catalog', () => {
  it('has no duplicates, and the scheme\'s own objections are the only format findings', () => {
    const report = partNumberReport(db, designs, {});
    expect(report.duplicates).toEqual([]);
    expect(report.format.every((f) => f.code === 'pn-wrong-kind')).toBe(true);
    expect(validateDb(db).filter((i) => i.code === 'pn-duplicate')).toEqual([]);
  });

  it('numbers every part and design of the starter', () => {
    expect(partNumberReport(db, designs, {}).unnumbered).toEqual([]);
  });

  it('lists the unnumbered parts and designs, each with a suggestion that does not repeat another', () => {
    // the starter is fully numbered: strip a few numbers to see the report list them
    const copy = clone();
    delete copy.wires[0]!.partNumber;
    delete copy.components[0]!.partNumber;
    const bare = designs.map((d, i) => (i < 2 ? { ...d, productRef: undefined } : d)) as typeof designs;
    const report = partNumberReport(copy, bare, {});
    const unnumbered = report.unnumbered;
    expect(unnumbered.length).toBeGreaterThan(0);
    const designRows = unnumbered.filter((u) => u.kind === 'design');
    expect(designRows.map((u) => u.id).sort()).toEqual(bare.filter((d) => d.productRef === undefined).map((d) => d.id).sort());
    const suggested = unnumbered.map((u) => u.suggestion!.pn);
    expect(new Set(suggested).size).toBe(suggested.length);
    // a part that has a number is not listed
    expect(unnumbered.some((u) => u.where === 'wires/' + copy.wires.find((w) => w.partNumber !== undefined)!.id)).toBe(false);
  });

  it('a drawing number counts for its design', () => {
    const id = designs[0]!.id;
    const report = partNumberReport(db, designs, { [id]: { partNumber: 'CBL-09999' } });
    expect(report.unnumbered.some((u) => u.id === id)).toBe(false);
  });
});

describe('duplicates', () => {
  it('flags the same number on two different parts, in any spelling', () => {
    const copy = clone();
    const a = copy.wires.find((w) => w.partNumber !== undefined)!;
    const b = copy.components.find((c) => c.partNumber !== undefined)!;
    b.partNumber = ` ${a.partNumber!.toLowerCase()} `;
    const issues = validateDb(copy).filter((i) => i.code === 'pn-duplicate');
    expect(issues.map((i) => i.where).sort()).toEqual([`components/${b.id}`, `wires/${a.id}`].sort());
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(partNumberReport(copy, designs, {}).duplicates).toHaveLength(1);
  });

  it('does not flag a connector and the body it is built on, nor a design and its own drawing', () => {
    const copy = clone();
    const connector = copy.connectors.find((c) => c.body !== undefined)!;
    connector.partNumber = 'CON-77777';
    copy.bodies = (copy.bodies ?? []).map((b) => (b.id === connector.body ? { ...b, partNumber: 'CON-77777' } : b));
    expect(validateDb(copy).filter((i) => i.code === 'pn-duplicate')).toEqual([]);
    const d = designs[0]!;
    expect(partNumberReport(copy, [{ ...d, productRef: 'CBL-88888' }], { [d.id]: { partNumber: 'cbl-88888' } }).duplicates).toEqual([]);
  });

  it('distinguishes independently numbered pinouts on one body without flagging physical reuse', () => {
    const copy = clone();
    const first = copy.connectors.find((c) => c.body !== undefined)!;
    const originalPn = copy.bodies!.find((b) => b.id === first.body)!.partNumber!;
    copy.connectors = [first, { ...first, id: 'another-pinout', partNumber: originalPn }];
    expect(partNumberReport(copy).duplicates).toEqual([]);
    copy.connectors = copy.connectors.map((c) => ({ ...c, partNumber: 'CON-77777' }));
    expect(partNumberReport(copy).duplicates.map((d) => d.holders.map((h) => h.where))).toContainEqual([`connectors/${first.id}`, 'connectors/another-pinout']);
    expect(validateDb(copy).some((i) => i.code === 'connector-part-number-mismatch')).toBe(false);
  });

  it('flags two designs sharing a number, and a design sharing a part number', () => {
    const [a, b] = designs;
    const report = partNumberReport(db, [{ ...a!, productRef: 'CBL-00001' }, { ...b!, productRef: 'CBL-00001' }], {});
    expect(report.duplicates.map((d) => d.holders.map((h) => h.where).sort())).toEqual([[`designs/${a!.id}`, `designs/${b!.id}`].sort()]);
  });
});

describe('disagreements', () => {
  it('lists a design whose product reference and drawing number differ, comparing canonical forms', () => {
    const d = designs[0]!;
    const same = partNumberReport(db, [{ ...d, productRef: 'CBL-00005' }], { [d.id]: { partNumber: ' cbl-00005 ' } });
    expect(same.disagreements).toEqual([]);
    const differ = partNumberReport(db, [{ ...d, productRef: 'CBL-00005' }], { [d.id]: { partNumber: 'CBL-00006' } });
    expect(differ.disagreements).toEqual([{ designId: d.id, label: d.label, productRef: 'CBL-00005', drawingPn: 'CBL-00006' }]);
  });
});

describe('a pluggable scheme', () => {
  // numbers are `N<digits>`; numbers wires only; hard-codes nothing the base knows
  const scheme: PartNumberScheme = {
    id: 'plain',
    label: 'N + digits',
    parse: (pn) => (/^\s*n\d+\s*$/i.test(pn) ? pn.trim().toUpperCase() : undefined),
    check: (pn) => (/^n\d+$/i.test(pn.trim()) ? [] : [{ code: 'pn-malformed', severity: 'warning', message: `${pn} is not N+digits` }]),
    suggest: (subject, known) => (subject.kind === 'wire' ? { pn: `N${known.length + 1}`, rule: 'count', explanation: 'one more than the numbers in use' } : undefined),
  };

  it('compares by the scheme\'s canonical form and numbers only the kinds the scheme numbers', () => {
    const copy = clone();
    for (const w of copy.wires) delete w.partNumber;
    for (const c of copy.components) delete c.partNumber;
    copy.wires[0]!.partNumber = 'n7';
    copy.components[0]!.partNumber = 'N7';
    expect(validateDb(copy, { scheme }).filter((i) => i.code === 'pn-duplicate')).toHaveLength(2);
    const report = partNumberReport(copy, designs, {}, scheme);
    expect(report.unnumbered.every((u) => u.kind === 'wire')).toBe(true);
    expect(report.format.some((f) => f.holder.pn === 'CON-00012')).toBe(true); // the scheme's own objection
  });

  it('the default scheme is untouched by it', () => {
    expect(DEFAULT_PART_NUMBER_SCHEME.id).toBe('prefix');
  });
});
