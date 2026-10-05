import { describe, expect, it } from 'vitest';

import {
  awgOfMm2,
  cavityIssues,
  cavityRows,
  definitionUsage,
  designTools,
  fillCavities,
  fitsHousing,
  setCavity,
  terminationDbIssues,
  validateDb,
  validateDesign,
  wireRangeText,
  withCavities,
  type CableDesign,
  type Db,
  type MechanicalDefinition,
} from '../src/index.ts';

const SYS = 'demo-sealed';

const part = (id: string, kind: MechanicalDefinition['kind'], termination: MechanicalDefinition['termination']): MechanicalDefinition => ({
  id,
  label: id,
  kind,
  ...(termination === undefined ? {} : { termination }),
  src: 'synthetic example',
});

const mechanicals: MechanicalDefinition[] = [
  part('socket-big', 'contact', { systems: [SYS], wireMinMm2: 0.5, wireMaxMm2: 1, insulationMinMm: 1.2, insulationMaxMm: 2.1, gender: 'female', stripMm: 4.5, crimpHeights: [{ wireMm2: 0.5, heightMm: 1.15, widthMm: 1.7 }], tool: 'hand-tool' }),
  part('socket-wide', 'contact', { systems: [SYS], wireMinMm2: 0.2, wireMaxMm2: 1.5, gender: 'female', tool: 'hand-tool' }),
  part('socket-small', 'contact', { systems: [SYS], wireMinMm2: 0.2, wireMaxMm2: 0.35, gender: 'female', tool: 'hand-tool' }),
  part('other-contact', 'contact', { systems: ['another-system'], wireMinMm2: 0.5, wireMaxMm2: 1 }),
  part('seal-thin', 'seal', { systems: [SYS], insulationMinMm: 1.2, insulationMaxMm: 1.6 }),
  part('seal-thick', 'seal', { systems: [SYS], insulationMinMm: 1.7, insulationMaxMm: 2.4 }),
  part('blind-plug', 'plug', { systems: [SYS] }),
  part('hand-tool', 'tool', { systems: [SYS] }),
  { id: 'boot', label: 'boot', kind: 'shell', src: 'synthetic example' },
];

const db: Db = {
  connectors: [
    {
      id: 'sealed-3',
      label: 'Sealed 3-way',
      family: 'sealed',
      gender: 'female',
      construction: 'crimp',
      housing: { systems: [SYS], sealing: 'per-wire', plugUnused: true },
      pins: [
        { id: '1', label: '1' },
        { id: '2', label: '2' },
        { id: '3', label: '3' },
      ],
      src: 'synthetic example',
    },
    {
      id: 'solder-2',
      label: 'Solder-cup 2-way',
      family: 'demo',
      construction: 'solder-cup',
      pins: [
        { id: '1', label: '1' },
        { id: '2', label: '2' },
      ],
      src: 'synthetic example',
    },
  ],
  wires: [
    {
      id: 'two-core',
      label: '2 × 0.5 mm²',
      structure: {
        kind: 'group',
        id: 'two-core',
        role: 'cable',
        children: [
          { kind: 'conductor', id: 'red', color: 'red', areaMm2: 0.5, insulatedOdMm: 1.6 },
          { kind: 'conductor', id: 'black', color: 'black', areaMm2: 0.5, insulatedOdMm: 1.6 },
        ],
      },
      src: 'synthetic example',
    },
  ],
  components: [],
  pcbas: [],
  mechanicals,
};

function design(cavities?: CableDesign['instances']['connectors'][number]['cavities'], def = 'sealed-3'): CableDesign {
  return {
    schemaVersion: 4,
    id: 'demo',
    label: 'demo',
    instances: {
      connectors: [
        { id: 'x1', def, ...(cavities === undefined ? {} : { cavities }) },
        { id: 'x2', def: 'solder-2' },
      ],
      segments: [{ id: 'w1', def: 'two-core', lengthMm: 300 }],
      components: [],
      pcbas: [],
    },
    joints: [
      { a: { instance: 'x1', terminal: '1' }, b: { instance: 'w1', terminal: 'red', end: 'a' } },
      { a: { instance: 'x1', terminal: '2' }, b: { instance: 'w1', terminal: 'black', end: 'a' } },
      { a: { instance: 'w1', terminal: 'red', end: 'b' }, b: { instance: 'x2', terminal: '1' } },
      { a: { instance: 'w1', terminal: 'black', end: 'b' }, b: { instance: 'x2', terminal: '2' } },
    ],
    src: 'synthetic example',
  };
}

const codes = (d: CableDesign): string[] => cavityIssues(d, db).map((i) => i.code).sort();

const full = [
  { pin: '1', contact: 'socket-big', seal: 'seal-thin' },
  { pin: '2', contact: 'socket-big', seal: 'seal-thin' },
  { pin: '3', plug: 'blind-plug' },
];

describe('crimp contacts, seals and plugs per cavity', () => {
  it('a connector with no housing and no cavities raises nothing (solder cup, existing designs)', () => {
    expect(cavityIssues(design(), db).filter((i) => i.where?.startsWith('x2'))).toEqual([]);
    expect(cavityRows(design(), db, 'x2')).toEqual([]);
  });

  it('a fully assigned sealed housing validates clean', () => {
    expect(codes(design(full))).toEqual([]);
    expect(validateDesign(design(full), db).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a crimp housing with nothing assigned asks for contacts, seals and a plug', () => {
    expect(codes(design())).toEqual(['cavity-no-contact', 'cavity-no-contact', 'cavity-no-seal', 'cavity-no-seal', 'cavity-unplugged']);
    expect(cavityIssues(design(), db).every((i) => i.severity === 'warning')).toBe(true);
  });

  it('warns when the wire is outside the contact range', () => {
    const d = design([{ ...full[0]!, contact: 'socket-small' }, full[1]!, full[2]!]);
    const range = cavityIssues(d, db).find((i) => i.code === 'contact-wire-range');
    expect(range?.severity).toBe('warning');
    expect(range?.where).toBe('x1:1');
  });

  it('warns when the insulation is outside the seal, and when a part fits another system', () => {
    expect(codes(design([{ ...full[0]!, seal: 'seal-thick' }, full[1]!, full[2]!]))).toEqual(['seal-wire-range']);
    expect(codes(design([{ ...full[0]!, contact: 'other-contact' }, full[1]!, full[2]!]))).toEqual(['cavity-part-housing']);
    expect(fitsHousing(mechanicals[3]!, db.connectors[0]!, db)).toBe(false);
    expect(fitsHousing(mechanicals[0]!, db.connectors[0]!, db)).toBe(true);
  });

  it('structural mistakes are errors', () => {
    expect(codes(design([...full, { pin: '9', contact: 'socket-big' }]))).toContain('cavity-unknown-pin');
    expect(codes(design([{ pin: '1', contact: 'seal-thin' }, full[1]!, full[2]!]))).toContain('cavity-unknown-part');
    expect(codes(design([{ pin: '1', contact: 'nope' }, full[1]!, full[2]!]))).toContain('cavity-unknown-part');
    expect(codes(design([full[0]!, full[0]!, full[1]!, full[2]!]))).toContain('cavity-duplicate');
    expect(codes(design([full[0]!, full[1]!, { pin: '3', plug: 'blind-plug', contact: 'socket-big' }]))).toContain('cavity-contact-and-plug');
    expect(validateDesign(design([...full, { pin: '9', contact: 'socket-big' }]), db).some((i) => i.severity === 'error' && i.code === 'cavity-unknown-pin')).toBe(true);
  });

  it('plugs on used cavities, contacts in unused ones and contacts on a solder-cup part are flagged', () => {
    expect(codes(design([{ pin: '1', plug: 'blind-plug' }, full[1]!, { pin: '3', contact: 'socket-big' }]))).toEqual(
      expect.arrayContaining(['cavity-plug-on-used', 'cavity-contact-unused']),
    );
    const solder = design();
    solder.instances.connectors[1] = { id: 'x2', def: 'solder-2', cavities: [{ pin: '1', contact: 'socket-big' }] };
    expect(cavityIssues(solder, db).map((i) => i.code)).toContain('cavity-not-crimp');
  });

  it('rows carry the wire, contact, seal, tool, strip and crimp height', () => {
    const rows = cavityRows(design(full), db, 'x1');
    expect(rows.map((r) => r.pin)).toEqual(['1', '2', '3']);
    expect(rows[0]).toMatchObject({ used: true, stripMm: 4.5, crimpHeightMm: 1.15, crimpWidthMm: 1.7 });
    expect(rows[0]?.tool?.id).toBe('hand-tool');
    expect(rows[0]?.wires).toEqual([{ segment: 'w1', path: 'red', end: 'a', stock: 'two-core', colour: 'red', areaMm2: 0.5, insulationMm: 1.6 }]);
    expect(rows[2]).toMatchObject({ used: false });
    expect(rows[2]?.plug?.id).toBe('blind-plug');
    const override = setCavity(design(full), 'x1', '1', { crimpHeightMm: 1.2 });
    expect(cavityRows(override, db, 'x1')[0]?.crimpHeightMm).toBe(1.2);
    expect(designTools(design(full), db).map((t) => t.tool.id)).toEqual(['hand-tool']);
  });

  it('fill all by wire gauge picks the narrowest fitting contact, the seal for the insulation and a plug', () => {
    const filled = fillCavities(design(), db, 'x1');
    expect(filled.instances.connectors[0]?.cavities).toEqual(full);
    expect(codes(filled)).toEqual([]);
    // a fill keeps notes and replaces a contact the wire does not fit
    const noted = fillCavities(design([{ pin: '1', contact: 'socket-small', note: 'check' }]), db, 'x1');
    expect(noted.instances.connectors[0]?.cavities?.[0]).toEqual({ pin: '1', contact: 'socket-big', note: 'check', seal: 'seal-thin' });
  });

  it('edits drop empty assignments and the field itself', () => {
    const one = setCavity(design(), 'x1', '1', { contact: 'socket-big' });
    expect(one.instances.connectors[0]?.cavities).toEqual([{ pin: '1', contact: 'socket-big' }]);
    const none = setCavity(one, 'x1', '1', { contact: undefined });
    expect('cavities' in (none.instances.connectors[0] ?? {})).toBe(false);
    expect(withCavities(design(full), 'x1', []).instances.connectors[0]).toEqual({ id: 'x1', def: 'sealed-3' });
  });

  it('the library checks ranges and tool references', () => {
    expect(terminationDbIssues(db)).toEqual([]);
    expect(validateDb(db).filter((i) => i.severity === 'error')).toEqual([]);
    const bad: Db = {
      ...db,
      mechanicals: [
        part('backwards', 'contact', { wireMinMm2: 1, wireMaxMm2: 0.5, tool: 'boot' }),
        { id: 'odd', label: 'odd', kind: 'shell', termination: {}, src: 'x' },
      ],
    };
    expect(terminationDbIssues(bad).map((i) => i.code).sort()).toEqual(['termination-on-non-part', 'termination-range', 'termination-tool-unknown']);
  });

  it('where used: a contact is used by the designs that put it in a cavity, a tool by its contacts', () => {
    expect(definitionUsage(db, [design(full)], 'mechanicals', 'socket-big').designs.map((d) => d.id)).toEqual(['demo']);
    expect(definitionUsage(db, [design()], 'mechanicals', 'socket-big').designs).toEqual([]);
    expect(definitionUsage(db, [], 'mechanicals', 'hand-tool').definitions.sort()).toEqual(['mechanicals/socket-big', 'mechanicals/socket-small', 'mechanicals/socket-wide']);
  });

  it('prints wire ranges in mm² and AWG', () => {
    expect(awgOfMm2(0.5)).toBe(20);
    expect(awgOfMm2(0.205)).toBe(24);
    expect(wireRangeText(mechanicals[0]!.termination)).toBe('0.5–1 mm² (20–17 AWG)');
    expect(wireRangeText(undefined)).toBeUndefined();
  });
});

describe('per-tool crimp heights and the applicator per cavity (cs-5k1.28)', () => {
  const withTools: Db = {
    ...db,
    mechanicals: [
      ...mechanicals.map((m) =>
        m.id === 'socket-big'
          ? { ...m, termination: { ...m.termination!, tools: [{ tool: 'applicator-b', crimpHeights: [{ wireMm2: 0.5, heightMm: 1.22, widthMm: 1.8 }], stripMm: 4 }] } }
          : m,
      ),
      part('applicator-b', 'tool', { systems: [SYS] }),
    ],
  };
  const rowOf = (cavities: Parameters<typeof design>[0]) => cavityRows(design(cavities), withTools, 'x1')[0]!;

  it('without a pick the default tool and the contact table apply, as before', () => {
    const row = rowOf(full);
    expect(row.tool?.id).toBe('hand-tool');
    expect(row).toMatchObject({ crimpHeightMm: 1.15, crimpWidthMm: 1.7, stripMm: 4.5 });
  });

  it('a cavity that picks a tool takes its own heights and strip, and names the tool', () => {
    const row = rowOf([{ ...full[0]!, tool: 'applicator-b' }, full[1]!, full[2]!]);
    expect(row.tool?.id).toBe('applicator-b');
    expect(row).toMatchObject({ crimpHeightMm: 1.22, crimpWidthMm: 1.8, stripMm: 4 });
    expect(designTools(design([{ ...full[0]!, tool: 'applicator-b' }, full[1]!, full[2]!]), withTools).map((t) => t.tool.id).sort()).toEqual(['applicator-b', 'hand-tool']);
  });

  it('a tool with no table of its own falls back to the contact table; a cavity height still wins', () => {
    const noTable: Db = { ...withTools, mechanicals: withTools.mechanicals!.map((m) => (m.id === 'socket-big' ? { ...m, termination: { ...m.termination!, tools: [{ tool: 'applicator-b' }] } } : m)) };
    expect(cavityRows(design([{ ...full[0]!, tool: 'applicator-b' }, full[1]!, full[2]!]), noTable, 'x1')[0]).toMatchObject({ crimpHeightMm: 1.15 });
    expect(cavityRows(design([{ ...full[0]!, tool: 'applicator-b', crimpHeightMm: 1.3 }, full[1]!, full[2]!]), withTools, 'x1')[0]?.crimpHeightMm).toBe(1.3);
  });

  it('checks the tools: unknown ids are errors, a tool the contact does not list is a warning', () => {
    expect(terminationDbIssues(withTools)).toEqual([]);
    const bad: Db = { ...withTools, mechanicals: withTools.mechanicals!.map((m) => (m.id === 'socket-big' ? { ...m, termination: { ...m.termination!, tools: [{ tool: 'nope' }] } } : m)) };
    expect(terminationDbIssues(bad).map((i) => i.code)).toEqual(['termination-tool-unknown']);
    const unknown = cavityIssues(design([{ ...full[0]!, tool: 'nope' }, full[1]!, full[2]!]), withTools).map((i) => i.code);
    expect(unknown).toContain('cavity-unknown-part');
    const stray = cavityIssues(design([{ ...full[0]!, tool: 'hand-tool' }, { ...full[1]!, contact: 'socket-big', tool: 'applicator-b' }, full[2]!]), { ...withTools, mechanicals: [...withTools.mechanicals!, part('third', 'tool', undefined)] });
    expect(stray.map((i) => i.code)).toEqual([]);
    const off = cavityIssues(design([{ ...full[0]!, tool: 'third' }, full[1]!, full[2]!]), { ...withTools, mechanicals: [...withTools.mechanicals!, part('third', 'tool', undefined)] });
    expect(off.map((i) => i.code)).toEqual(['cavity-tool-contact']);
    expect(off[0]?.severity).toBe('warning');
  });

  it('a tool is in use by the contacts that list it, and edits keep a cavity that only names a tool', () => {
    expect(definitionUsage(withTools, [design()], 'mechanicals', 'applicator-b').definitions).toContain('mechanicals/socket-big');
    expect(setCavity(design(), 'x1', '1', { tool: 'applicator-b' }).instances.connectors[0]?.cavities).toEqual([{ pin: '1', tool: 'applicator-b' }]);
  });
});
