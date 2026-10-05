/**
 * Structured PCBA link elements: the parse of a `via`,
 * the precedence of declared elements, the trace carrying them, and the
 * validator holding elements and prose together.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import {
  linkDesignators,
  linkElements,
  linkVia,
  parseVia,
  trace,
  validateDb,
  viaText,
  type PcbaInternalLink,
} from '../src/index.ts';

const db = loadDb();

describe('parseVia', () => {
  it('splits a multi-part path into typed elements that spell the prose back', () => {
    const via = 'C201 0.1 µF → U201 LM1881 sync stripper → R202 470 Ω';
    const elements = parseVia(via);
    expect(elements.map((e) => [e.designator, e.kind, e.value, e.ohms])).toEqual([
      ['C201', 'capacitor', '0.1 µF', undefined],
      ['U201', 'ic', undefined, undefined],
      ['R202', 'resistor', '470 Ω', 470],
    ]);
    expect(viaText(elements)).toBe(via);
  });

  it('reads jumper and switch states', () => {
    expect(parseVia('JP201 0 Ω (bridged — CPL Basic)')[0]).toMatchObject({ kind: 'jumper', ohms: 0, state: 'bridged' });
    expect(parseVia('JP1 (solder jumper — build option)')[0]?.state).toBe('build option');
    expect(parseVia('SW1 (SP3T select — CS position)')[0]).toMatchObject({ kind: 'switch', state: 'CS position' });
    expect(parseVia('J1 PJ-311D switch contact (no plug inserted)')[0]).toMatchObject({
      designator: 'J1',
      kind: 'switch',
      state: 'no plug inserted',
    });
  });

  it('names only the parts in the path, never the ones the prose mentions', () => {
    const link = { via: 'JP2 0 Ω (bridged — Option A (JP2 A closed, JP1 C open))' };
    expect(linkDesignators(link)).toEqual(['JP2']);
  });
});

describe('linkElements', () => {
  it('prefers declared elements over the prose', () => {
    const link: PcbaInternalLink = {
      from: 'a',
      to: 'b',
      via: 'the coupling part',
      elements: [{ text: 'the coupling part', kind: 'capacitor', designator: 'C9', value: '10 µF' }],
    };
    expect(linkElements(link)[0]?.kind).toBe('capacitor');
    expect(parseVia(link.via as string)[0]?.kind).toBe('other');
    expect(linkDesignators(link)).toEqual(['C9']);
  });

  it('spells a via from elements when a link has none', () => {
    expect(linkVia({ elements: [{ text: 'R1 75 Ω', kind: 'resistor' }] })).toBe('R1 75 Ω');
    expect(linkVia({})).toBeUndefined();
  });

  it('is empty for plain copper', () => {
    expect(linkElements({})).toEqual([]);
  });
});

describe('the catalog and the trace', () => {
  it('every imported link carries elements that spell its via exactly', () => {
    let withElements = 0;
    for (const pcba of db.pcbas) {
      for (const link of pcba.internalLinks) {
        if (link.elements === undefined) continue;
        withElements += 1;
        expect(viaText(link.elements), `${pcba.id} ${link.from}→${link.to}`).toBe(link.via);
      }
    }
    expect(withElements).toBeGreaterThan(0);
    expect(validateDb(db).filter((i) => i.code === 'link-elements-via-mismatch')).toEqual([]);
  });

  it('flags elements that do not spell the via', () => {
    const pcba = db.pcbas.find((p) => p.internalLinks.some((l) => l.elements !== undefined));
    if (pcba === undefined) throw new Error('no board with elements');
    const broken = {
      ...pcba,
      internalLinks: pcba.internalLinks.map((l) => (l.elements === undefined ? l : { ...l, via: `${l.via} (reworded)` })),
    };
    const issues = validateDb({ ...db, pcbas: [broken] }).filter((i) => i.code === 'link-elements-via-mismatch');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('hands the trace the structure, not only the prose', () => {
    const design = loadDesign('de9-terminal-board');
    const result = trace(design, db, { instance: 'j1', terminal: '8' });
    const step = result.reached.find((s) => s.terminal.key === 'j1:3');
    const board = step?.passages.find((p) => p.kind === 'pcba-link' && p.description.includes('120'));
    expect(board?.elements?.map((e) => e.designator)).toEqual(['R1']);
  });
});
