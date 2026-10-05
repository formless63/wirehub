/**
 * The renderer's pieces on the starter catalog and small synthetic inputs:
 * cross-section drawings, inlined artwork, part markings, paint. Re-covers the
 * generic cases of the render tests dropped at the split (docs/boundaries.md §6).
 */

import { describe, expect, it } from 'vitest';
import { loadDb } from '@wirehub/catalog';
import { findWire } from '@wirehub/model';

import {
  conductorPaint,
  inlineVectorAsset,
  prefixIds,
  renderCrossSection,
  resistorMarking,
  ringPaint,
  svgBody,
  usesXlink,
  INK,
} from '../src/index.ts';
import { parseXml, byClass } from './xml.ts';

const db = loadDb();

describe('cross-section drawing', () => {
  for (const w of db.wires) {
    it(`${w.id}: a well-formed, deterministic, self-contained svg`, () => {
      const svg = renderCrossSection(w);
      expect(renderCrossSection(w)).toBe(svg);
      const root = parseXml(svg);
      expect(root.name).toBe('svg');
      expect(svg).not.toMatch(/<script\b|href="https?:/);
    });
  }

  it('uses the given title for the heading', () => {
    expect(renderCrossSection(findWire(db, 'cat5e-utp')!, { title: 'Custom heading' })).toContain('Custom heading');
  });

  it('draws a larger panel at a larger scale', () => {
    const w = findWire(db, 'dc-2core-24awg')!;
    const width = (svg: string) => Number(/viewBox="0 0 ([\d.]+)/.exec(svg)![1]);
    expect(width(renderCrossSection(w, { scale: 8 }))).toBeGreaterThan(width(renderCrossSection(w, { scale: 4 })));
  });
});

describe('paint', () => {
  it('maps a named colour and falls back to a neutral for an unknown or missing one', () => {
    expect(conductorPaint('red')).not.toBe(conductorPaint(undefined));
    expect(conductorPaint('RED')).toBe(conductorPaint('red'));
    expect(conductorPaint('no-such-colour')).toBe(conductorPaint(undefined));
  });

  it('paints copper, metal and a jacket apart', () => {
    const copper = ringPaint({ kind: 'conductor' } as never);
    const shield = ringPaint({ kind: 'shield' } as never);
    expect(copper).not.toBe(shield);
    expect(ringPaint({ kind: 'insulation' } as never, true)).toBe(INK.jacket);
  });
});

describe('inlined artwork', () => {
  const source = '<?xml version="1.0"?><svg viewBox="0 0 1 1"><defs><linearGradient id="g"/></defs><rect id="r" fill="url(#g)" onclick="x()"/><image href="https://example.org/x.png"/><use href="#r"/><script>alert(1)</script></svg>';

  it('takes the content between the outer svg tags', () => {
    expect(svgBody('<svg a="1"><g/></svg>')).toBe('<g/>');
  });

  it('prefixes ids and the references to them', () => {
    const out = prefixIds('<g id="a"/><use href="#a"/><rect fill="url(#a)"/>', 'p-');
    expect(out).toBe('<g id="p-a"/><use href="#p-a"/><rect fill="url(#p-a)"/>');
  });

  it('drops scripts, handlers and references that leave the file', () => {
    const out = inlineVectorAsset(source, 'x-');
    expect(out).not.toMatch(/<script|onclick|https?:|<\?xml/);
    expect(out).toContain('id="x-r"');
    expect(out).toContain('href="#x-r"');
  });

  it('notices a leftover xlink prefix', () => {
    expect(usesXlink('<use xlink:href="#a"/>')).toBe(true);
    expect(usesXlink('<use href="#a"/>')).toBe(false);
  });

  it('is repeatable', () => {
    expect(inlineVectorAsset(source, 'x-')).toBe(inlineVectorAsset(source, 'x-'));
    expect(byClass(parseXml('<a class="k"/>'), 'k')).toHaveLength(1);
  });
});

describe('resistor marking', () => {
  it('derives the printed code from the value', () => {
    expect(resistorMarking('0R')).toBe('0');
    expect(resistorMarking('4.7R')).toBe('4R7');
    expect(resistorMarking('100 Ω')).toBe('101');
    expect(resistorMarking('120R')).toBe('121');
    expect(resistorMarking('10k')).toBe('103');
  });

  it('declines a value it cannot read', () => {
    expect(resistorMarking(undefined)).toBeUndefined();
    expect(resistorMarking('about right')).toBeUndefined();
    expect(resistorMarking('-5R')).toBeUndefined();
  });
});
