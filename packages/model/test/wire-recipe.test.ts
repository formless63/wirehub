import { describe, expect, it } from 'vitest';

import {
  compileWire,
  conductorArea,
  layEnvelope,
  resolveElementPath,
  strandedOd,
  suggestBondedSets,
  validateWireParts,
  type WirePart,
  type WireRecipe,
} from '../src/index.ts';

const parts: WirePart[] = [
  { kind: 'conductor', id: 'c-tc', label: 'TC 11x0.10', material: 'tinned copper', strands: 11, strandMm: 0.1, src: 'sheet A' },
  { kind: 'conductor', id: 'c-drain', label: 'drain', material: 'bare copper', strands: 7, strandMm: 0.12, src: 'sheet A' },
  { kind: 'insulation', id: 'i-diel', label: 'FM-PE 1.6', material: 'FM-PE', odMm: 1.6, src: 'sheet A' },
  { kind: 'insulation', id: 'i-sheath', label: 'PVC wall 0.3', material: 'PVC', wallMm: 0.3, src: 'sheet A' },
  { kind: 'shield', id: 's-spiral', label: 'spiral', construction: 'spiral', material: 'tinned copper', strandMm: 0.1, src: 'sheet A' },
  { kind: 'shield', id: 's-foil', label: 'foil', construction: 'foil', material: 'aluminium', src: 'sheet A' },
  { kind: 'jacket', id: 'j-9', label: 'PVC 9.0', material: 'PVC', odMm: 9, color: 'black', src: 'sheet A' },
  { kind: 'jacket', id: 'j-5', label: 'PVC 5.0', material: 'PVC', odMm: 5, color: 'black', src: 'sheet A' },
  {
    kind: 'core',
    id: 'core-coax',
    label: 'coax',
    builtAs: 'coax',
    conductor: 'c-tc',
    dielectric: 'i-diel',
    shield: 's-spiral',
    sheath: 'i-sheath',
    src: 'sheet A',
  },
];

const colours = ['red', 'green', 'blue', 'yellow', 'white', 'black'];
const recipe: WireRecipe = {
  id: 'test-coax',
  label: 'Test coax',
  cores: colours.map((colour) => ({ id: `core-${colour}`, colour, part: 'core-coax' })),
  lay: {
    arrangement: '6-around-1',
    direction: 'cw',
    viewedFrom: 'destination',
    ring: colours.map((colour) => `core-${colour}`),
    src: 'sheet A picture',
  },
  overall: { shield: 's-foil', drain: 'c-drain' },
  jacket: 'j-9',
  src: 'sheet A',
};

describe('geometry', () => {
  it('conductor area is n·π·d²/4', () => {
    expect(conductorArea(7, 0.12)).toBeCloseTo(0.0792, 4);
  });
  it('a 7-strand conductor is three strands across', () => {
    expect(strandedOd(7, 0.12).od).toBeCloseTo(0.36, 6);
  });
  it('6 around 1 of equal cores is three cores across', () => {
    expect(layEnvelope('6-around-1', 2.4).od).toBeCloseTo(7.2, 6);
  });
  it('a centre pair opens the ring up', () => {
    const env = layEnvelope('6-around-2', 2.35, 0, [1.3, 1.3]);
    expect(env.od).toBeCloseTo(2 * (1.3 + 1.175 + 1.175), 6);
  });
});

describe('compileWire', () => {
  const compiled = compileWire(recipe, parts);

  it('builds the element tree with derived diameters', () => {
    expect(compiled.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const shield = resolveElementPath(compiled.wire.structure, 'core-red.shield');
    expect(shield).toMatchObject({ kind: 'shield', odMm: 1.8, construction: 'spiral' });
    const sheath = resolveElementPath(compiled.wire.structure, 'core-red.sheath');
    expect(sheath).toMatchObject({ odMm: 2.4, color: 'red', label: 'Coax sheath (red)' });
    const center = resolveElementPath(compiled.wire.structure, 'core-red.center');
    expect(center).toMatchObject({ formation: 'TC 11x0.10 mm', areaMm2: 0.086, odMm: 0.38, label: 'red centre conductor' });
    expect(compiled.wire.odMm).toBe(9);
  });

  it('reports every derived value with its formula, and flags assumptions', () => {
    const od = compiled.derived.find((d) => d.path === 'core-red.shield' && d.field === 'odMm');
    expect(od?.formula).toMatch(/inner \+ 2·strand/);
    expect(od?.inferred).toBe(true);
    expect(compiled.envelopeMm).toBeCloseTo(7.2, 6);
    const overall = compiled.derived.find((d) => d.path === 'overall-shield');
    expect(overall?.inferred).toBe(true);
    expect(resolveElementPath(compiled.wire.structure, 'overall-shield')?.src).toMatch(/INFERRED/);
  });

  it('warns when the cores cannot fit the jacket', () => {
    const tight = compileWire({ ...recipe, jacket: 'j-5' }, parts);
    expect(tight.issues.map((i) => i.code)).toContain('wire-overfill');
  });

  it('names an unknown part instead of throwing', () => {
    const broken = compileWire({ ...recipe, jacket: 'nope' }, parts);
    expect(broken.issues.map((i) => i.code)).toContain('wire-part-unknown');
  });

  it('suggests the foil and drain as one mass, and nothing for sheathed braids', () => {
    expect(suggestBondedSets(compiled.wire)).toEqual([['overall-shield', 'drain']]);
  });
});

describe('validateWireParts', () => {
  it('passes a sound library', () => {
    expect(validateWireParts(parts)).toEqual([]);
  });
  it('catches a core naming a missing or wrong-kind part', () => {
    const codes = validateWireParts([
      ...parts,
      { kind: 'core', id: 'core-bad', label: 'bad', builtAs: 'coax', conductor: 'i-diel', shield: 'missing', src: 'x' },
    ]).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['wire-part-kind', 'wire-part-unknown']));
  });
});

describe('figure-8', () => {
  const legParts: WirePart[] = [
    ...parts,
    { kind: 'insulation', id: 'i-col', label: 'coloured 1.4', material: 'PE', odMm: 1.4, src: 'sheet B' },
    { kind: 'insulation', id: 'i-leg', label: 'black leg jacket 3.0', material: 'PVC', odMm: 3, color: 'black', src: 'sheet B' },
    { kind: 'core', id: 'core-leg', label: 'leg', builtAs: 'shielded-core', conductor: 'c-tc', insulation: 'i-col', shield: 's-spiral', sheath: 'i-leg', src: 'sheet B' },
  ];
  const f8: WireRecipe = {
    id: 'test-f8',
    label: 'Test figure-8',
    manufacturer: 'acme',
    cores: [
      { id: 'left', colour: 'white', part: 'core-leg' },
      { id: 'right', colour: 'red', part: 'core-leg' },
    ],
    lay: { arrangement: 'figure-8', direction: 'cw', viewedFrom: 'destination', ring: ['left', 'right'], src: 'sheet B' },
    web: { material: 'PVC', color: 'black', gapMm: 0.4, src: 'sheet B' },
    src: 'sheet B',
  };

  it('derives width × height from the legs and the web, and carries Ø = the width', () => {
    const { wire, issues } = compileWire(f8, legParts);
    expect(issues).toEqual([]);
    expect(wire.profile).toMatchObject({ shape: 'figure-8', legOdMm: 3, pitchMm: 3.4, widthMm: 6.4, heightMm: 3, webMm: 1.8 });
    expect(wire.profile!.src).toMatch(/Web 1\.8 mm INFERRED/);
    expect(wire.odMm).toBe(6.4);
    expect(wire.manufacturer).toBe('acme');
  });

  it('builds each leg conductor → coloured insulation → shield → fixed-colour jacket, then the web', () => {
    const { wire } = compileWire(f8, legParts);
    expect(wire.structure.children.map((c) => c.id)).toEqual(['left', 'right', 'web']);
    expect(resolveElementPath(wire.structure, 'right.insulation')).toMatchObject({ color: 'red' });
    expect(resolveElementPath(wire.structure, 'right.sheath')).toMatchObject({ color: 'black', odMm: 3 });
    expect(resolveElementPath(wire.structure, 'web')).toMatchObject({ kind: 'insulation', color: 'black' });
  });

  it('warns about an overall jacket or a missing web', () => {
    const { web: _web, ...noWeb } = f8;
    const codes = compileWire({ ...noWeb, jacket: 'j-9' }, legParts).issues.map((i) => i.code);
    expect(codes).toContain('wire-figure8-jacket');
    expect(codes).toContain('wire-figure8-web');
  });
});
