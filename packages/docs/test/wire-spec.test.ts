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
    const html = sheet('vga-3coax-4core');
    expect(sheet('vga-3coax-4core')).toBe(html);
    expect(html).not.toMatch(/<link\b|<script\b|\bsrc="http|url\(http/);
  });

  it('numbers the document with the canonical part number and names the file after it', () => {
    expect(wireSpecDocNumber(wire('mic-2core-braid'))).toBe('WIR-00003');
    expect(wireSpecFileName(wire('mic-2core-braid'), 'html')).toBe('WSS_WIR-00003.html');
  });

  it('carries the organisation and standard a deployment names, and no rights line unless given one', () => {
    const plain = sheet('mic-2core-braid');
    expect(plain).toContain('WireHub Standard');
    const branded = sheet('mic-2core-braid', { organisation: 'Acme Cables', standard: 'Acme Wire Standard', rightsNotice: 'Acme internal' });
    expect(branded).toContain('ACME CABLES');
    expect(branded).toContain('Acme Wire Standard');
    expect(branded).toContain('Acme internal');
  });

  it('draws the cutaway to a stated scale', () => {
    expect(wireSpecScale(wire('vga-3coax-4core').odMm)).toBe(8);
    expect(groundingNotes(wire('vga-3coax-4core')).length).toBeGreaterThan(0);
  });
});
