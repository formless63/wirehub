import { describe, expect, it } from 'vitest';

import { fixtureCatalog } from '@wirehub/catalog';

import {
  groundingNotes,
  renderWireSpecSheet,
  wireSpecDocNumber,
  wireSpecFileName,
  wireSpecScale,
} from '../src/index.ts';

// the frozen fixture catalog: a Library edit to a live stock never moves
// these file snapshots
const fixture = fixtureCatalog();
const library = fixture.loadWireLibrary();
const wires = fixture.loadWires();
const wire = (id: string) => wires.find((w) => w.id === id)!;
const manufacturers = fixture.loadVocabList('manufacturers').entries;
const sheet = (id: string, extra: Parameters<typeof renderWireSpecSheet>[1] = {}): string =>
  renderWireSpecSheet(wire(id), {
    ...(library.recipes.find((r) => r.id === id) === undefined ? {} : { recipe: library.recipes.find((r) => r.id === id)! }),
    parts: library.parts,
    manufacturers,
    ...extra,
  });

describe('wire spec sheet', () => {
  it.each(wires.map((w) => w.id))('%s matches its snapshot', async (id) => {
    await expect(sheet(id)).toMatchFileSnapshot(`./__snapshots__/wire-spec/${id}.html`);
  });

  it('is deterministic and self-contained', () => {
    const html = sheet('shielded-2pair-24awg');
    expect(sheet('shielded-2pair-24awg')).toBe(html);
    expect(html).not.toMatch(/<link\b|<script\b|\bsrc="http|url\(http/);
  });

  it('numbers the document with the canonical part number and names the file after it', () => {
    expect(wireSpecDocNumber(wire('dc-2core-24awg'))).toBe('WIR-00005');
    expect(wireSpecFileName(wire('dc-2core-24awg'), 'html')).toBe('WSS_WIR-00005.html');
  });

  it('carries the organisation and standard a deployment names, and no rights line unless given one', () => {
    const plain = sheet('dc-2core-24awg');
    expect(plain).toContain('WireHub Standard');
    const branded = sheet('dc-2core-24awg', { organisation: 'Acme Cables', standard: 'Acme Wire Standard', rightsNotice: 'Acme internal' });
    expect(branded).toContain('ACME CABLES');
    expect(branded).toContain('Acme Wire Standard');
    expect(branded).toContain('Acme internal');
  });

  it('draws the cutaway to a stated scale', () => {
    expect(wireSpecScale(wire('shielded-2pair-24awg').odMm)).toBe(15);
    expect(groundingNotes(wire('shielded-2pair-24awg')).length).toBeGreaterThan(0);
  });
});
