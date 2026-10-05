/**
 * Pure editor behaviours on the starter catalog and synthetic parts: the wire
 * builder's recipe edits, trunk stock swap, pigtail edits. Re-covers the
 * generic cases of the editor tests dropped at the split (docs/boundaries.md §6).
 */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';
import type { WireLibrary, WirePart, WireRecipe } from '@wirehub/model';

import {
  addCore,
  addVendorDoc,
  applyPartToAll,
  blankRecipe,
  compileRecipe,
  duplicateRecipe,
  flipViewedFrom,
  layFor,
  memoryWireLibraryAdapter,
  nextColour,
  otherEndReading,
  recipeProblems,
  recolourCore,
  removeCore,
  removeVendorDoc,
  signalChoices,
  slotOf,
  stepInRing,
  swapInLay,
  withArrangement,
} from '../src/wire-builder.ts';
import { withTrunkStock } from '../src/stock-swap.ts';
import { editPigtails, freePigtailId, pigtailLanding } from '../src/pigtail-edit.ts';

const db = loadDb();

const parts: WirePart[] = [
  { kind: 'conductor', id: 'c-cu', label: 'Cu 7x0.2', material: 'tinned copper', strands: 7, strandMm: 0.2, src: 'synthetic example' },
  { kind: 'insulation', id: 'i-pe', label: 'PE wall 0.3', material: 'PE', wallMm: 0.3, src: 'synthetic example' },
  { kind: 'jacket', id: 'j-6', label: 'PVC 6.0', material: 'PVC', odMm: 6, color: 'black', src: 'synthetic example' },
  { kind: 'core', id: 'core-plain', label: 'plain core', builtAs: 'plain', conductor: 'c-cu', insulation: 'i-pe', src: 'synthetic example' } as WirePart,
];
const library = (): WireLibrary => ({ parts: structuredClone(parts), recipes: [] });

describe('wire builder: recipe edits', () => {
  const base = (): WireRecipe => ({ ...blankRecipe('test-stock'), label: 'Test stock', src: 'synthetic example', jacket: 'j-6' });

  it('starts blank and hands out colours in order', () => {
    expect(blankRecipe().cores).toEqual([]);
    expect(nextColour(base())).toBe('red');
    expect(nextColour(addCore(base(), 'core-plain'))).toBe('green');
  });

  it('adds cores with free ids and puts them in the ring once a lay exists', () => {
    let r = addCore(addCore(base(), 'core-plain', 'red'), 'core-plain', 'red');
    expect(r.cores.map((c) => c.id)).toEqual(['core-red', 'core-red-2']);
    r = withArrangement(r, '6-around-1');
    expect(r.lay!.ring).toEqual(['core-red', 'core-red-2']);
    r = addCore(r, 'core-plain', 'blue');
    expect(r.lay!.ring).toContain('core-blue');
  });

  it('removes a core from the lay and from bonded sets', () => {
    let r = addCore(addCore(addCore(base(), 'core-plain'), 'core-plain'), 'core-plain');
    r = { ...withArrangement(r, '6-around-1'), bonded: [{ members: ['core-red', 'core-green'], src: 'x' }] } as WireRecipe;
    const out = removeCore(r, 'core-red');
    expect(out.cores.map((c) => c.id)).not.toContain('core-red');
    expect(out.lay!.ring).not.toContain('core-red');
    expect(out.lay!.center).toBeUndefined();
    expect(out.bonded ?? []).toEqual([]);
  });

  it('recolours a core and renames it along with its lay slot', () => {
    let r = addCore(addCore(base(), 'core-plain'), 'core-plain');
    r = withArrangement(r, 'pair');
    const out = recolourCore(r, 'core-red', 'yellow');
    expect(out.cores.map((c) => c.id)).toEqual(['core-yellow', 'core-green']);
    expect(out.lay!.ring).toEqual(['core-yellow', 'core-green']);
  });

  it('applies one part to every core', () => {
    const r = applyPartToAll(addCore(addCore(base(), 'a'), 'b'), 'core-plain');
    expect(r.cores.every((c) => c.part === 'core-plain')).toBe(true);
  });

  it('a duplicate is a different stock: identity, number and history dropped', () => {
    const source: WireRecipe = { ...addCore(base(), 'core-plain'), partNumber: 'WIR-00099', revisions: [] } as WireRecipe;
    const copy = duplicateRecipe(source, 'copy-stock', 'Copy stock');
    expect(copy.id).toBe('copy-stock');
    expect(copy.partNumber).toBeUndefined();
    expect(copy.revisions).toBeUndefined();
    expect(copy.cores).toEqual(source.cores);
    expect(copy.src).toContain('Duplicated from test-stock');
  });

  it('vendor documents are added once and removed by asset', () => {
    const doc = { id: 'asset-1', mime: 'application/pdf', originalName: 'sheet.pdf', src: 'synthetic example', bytes: 10 };
    const once = addVendorDoc(base(), doc);
    expect(addVendorDoc(once, doc)).toBe(once);
    expect(once.vendorDocs).toEqual([{ asset: 'asset-1', label: 'sheet', src: 'synthetic example' }]);
    expect(removeVendorDoc(once, 'asset-1').vendorDocs).toBeUndefined();
  });

  it('offers the vocabulary signals first, then any the recipe already says', () => {
    const vocab = { signals: { entries: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', pending: true }] } } as never;
    const r = { ...addCore(base(), 'core-plain'), cores: [{ id: 'core-red', colour: 'red', part: 'core-plain', signal: 'Custom' }] } as WireRecipe;
    expect(signalChoices(r, vocab)).toEqual(['Alpha', 'Custom']);
  });

  it('says what is missing from a recipe in words', () => {
    const r = blankRecipe('Bad Id');
    const problems = recipeProblems(r, compileRecipe(r, library()), true, ['taken']);
    const text = problems.join(' ');
    expect(text).toMatch(/lowercase/);
    expect(text).toMatch(/name/);
    expect(text).toMatch(/at least one core/);
    expect(recipeProblems({ ...r, id: 'taken' }, compileRecipe(r, library()), true, ['taken']).join(' ')).toMatch(/already called/);
  });
});

describe('wire builder: lay edits', () => {
  const lay = () =>
    layFor({ ...addCore(addCore(addCore(blankRecipe('x'), 'p'), 'p'), 'p'), src: '' } as WireRecipe, '6-around-1');

  it('puts the first cores in the ring and the next in the centre', () => {
    const r = addCore(addCore(blankRecipe('x'), 'p'), 'p');
    const l = layFor(addCore(r, 'p'), '6-around-1');
    expect(l.ring.length).toBe(3);
    expect(layFor(r, 'pair').center).toBeUndefined();
  });

  it('swaps two slots and finds where an id sits', () => {
    const l = lay();
    const swapped = swapInLay(l, l.ring[0]!, l.ring[2]!);
    expect(swapped.ring[0]).toBe(l.ring[2]);
    expect(swapped.ring[2]).toBe(l.ring[0]);
    expect(slotOf(l, l.ring[1]!)).toEqual({ at: 'ring', index: 1 });
    expect(swapInLay(l, 'nope', l.ring[0]!)).toBe(l);
  });

  it('steps round the ring and wraps', () => {
    const l = lay();
    const first = l.ring[0]!;
    expect(stepInRing(l, first, -1).ring[2]).toBe(first);
    expect(stepInRing(l, first, 1).ring[1]).toBe(first);
  });

  it('reads from the other end by flipping view and direction', () => {
    const l = { ...lay(), direction: 'cw' as const, viewedFrom: 'source' as const };
    expect(otherEndReading(l)).toEqual({ end: 'destination', direction: 'ccw' });
    const flipped = flipViewedFrom(l);
    expect(flipped.direction).toBe('ccw');
    expect(flipped.viewedFrom).toBe('destination');
    expect(flipViewedFrom(flipped)).toEqual(l);
  });
});

describe('wire builder: the in-memory library adapter', () => {
  it('refuses a duplicate part and a duplicate new stock, and accepts a changed one', async () => {
    const adapter = memoryWireLibraryAdapter(library());
    expect((await adapter.addPart(parts[0]!)).ok).toBe(false);
    const recipe: WireRecipe = { id: 'one', label: 'One', cores: [], src: 'x' };
    expect((await adapter.saveStock(recipe, true)).ok).toBe(true);
    expect((await adapter.saveStock(recipe, true)).ok).toBe(false);
    expect((await adapter.saveStock({ ...recipe, label: 'Changed' }, false)).ok).toBe(true);
    expect(adapter.current().recipes.map((r) => r.label)).toEqual(['Changed']);
  });

  it('hands out copies, so a caller cannot change the library by editing a result', async () => {
    const adapter = memoryWireLibraryAdapter(library());
    const loaded = await adapter.load();
    if (!loaded.ok) throw new Error('load failed');
    loaded.value.parts.length = 0;
    expect(adapter.current().parts.length).toBe(parts.length);
  });
});

describe('trunk stock swap', () => {
  it('does nothing when the stock is already the trunk', () => {
    const d = loadDesign('de9-terminal-board');
    const r = withTrunkStock(d, db, 'shielded-2pair-24awg');
    expect(r.design).toBe(d);
    expect(r.lost).toEqual([]);
  });

  it('says so when the stock is not in the catalog', () => {
    const d = loadDesign('de9-terminal-board');
    const r = withTrunkStock(d, db, 'no-such-stock');
    expect(r.design).toBe(d);
    expect(r.lost.join(' ')).toMatch(/not in the catalog/);
  });

  it('carries what it can by colour and names what it could not, without touching the input', () => {
    const d = structuredClone(loadDesign('de9-terminal-board'));
    const before = JSON.stringify(d);
    const r = withTrunkStock(d, db, 'multicore-3coax-4core');
    expect(JSON.stringify(d)).toBe(before);
    expect(r.design.instances.segments[0]!.def).toBe('multicore-3coax-4core');
    expect(r.lost.length).toBeGreaterThan(0);
    const newStock = db.wires.find((w) => w.id === 'multicore-3coax-4core')!;
    const paths = new Set<string>();
    const walk = (children: readonly { id: string; kind: string; children?: unknown }[], prefix: string): void => {
      for (const child of children) {
        const path = prefix === '' ? child.id : `${prefix}.${child.id}`;
        paths.add(path);
        if (child.kind === 'group') walk(child.children as never, path);
      }
    };
    walk(newStock.structure.children, '');
    for (const joint of r.design.joints) {
      for (const ref of [joint.a, joint.b]) {
        if (ref.instance !== 'w1' || ref.terminal.startsWith('pigtail:')) continue;
        expect(paths.has(ref.terminal), ref.terminal).toBe(true);
      }
    }
  });
});

describe('pigtail edits', () => {
  const design = () => structuredClone(loadDesign('de9-terminal-board'));

  it('finds the joint a pigtail lands on, and which terminal it is', () => {
    const found = pigtailLanding(design(), 'w1', 'shield', 'a');
    expect(found?.landing).toEqual({ instance: 'j1', terminal: 'shell' });
    expect(pigtailLanding(design(), 'w1', 'shield', 'b')?.landing).toEqual({ instance: 'u1', terminal: 'SHLD' });
    expect(pigtailLanding(design(), 'w1', 'nope', 'a')).toBeUndefined();
  });

  it('names a free pigtail id by counting up', () => {
    const d = design();
    const segment = d.instances.segments[0]!;
    expect(freePigtailId(segment, 'a', 'Shield')).toBe('shield-2');
    expect(freePigtailId(segment, 'a', 'drain')).toBe('drain');
    expect(freePigtailId(segment, 'a', '!!')).toBe('gnd');
  });

  it('refuses an edit on a segment that is not there, or a pigtail with no member list', () => {
    const d = design();
    expect(editPigtails(d, db, { op: 'drop', segment: 'zz', end: 'a', id: 'shield', members: [] })).toEqual({ ok: false, reason: "no segment 'zz'" });
    const r = editPigtails(d, db, { op: 'split', segment: 'w1', end: 'a', id: 'shield', members: ['drain'] });
    expect(r.ok).toBe(false);
  });

  it('moves a pigtail to another pad of its landing and leaves the input alone', () => {
    const d = design();
    const before = JSON.stringify(d);
    const r = editPigtails(d, db, { op: 'pad', segment: 'w1', end: 'a', id: 'shield', pad: 'P7' });
    expect(JSON.stringify(d)).toBe(before);
    if (!r.ok) throw new Error(r.reason);
    expect(pigtailLanding(r.design, 'w1', 'shield', 'a')?.landing.pad).toBe('P7');
  });
});
