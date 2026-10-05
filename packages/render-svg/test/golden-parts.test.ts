import { describe, expect, it } from 'vitest';

import { fixtureCatalog, fixtureDepictionsRoot } from '@wirehub/catalog';
import { depictionsFromRoot, layoutSchematic } from '@wirehub/layout';

import { renderCrossSection, renderSchematic } from '../src/index.ts';

/**
 * Focused goldens over the frozen fixture catalog (`packages/catalog/fixtures/v1`),
 * beside the whole-page goldens in `golden.test.ts`:
 *
 * - the cross-section cutaway of every wire stock, as its own document;
 * - the structure of every design's diagram (blocks, bands, tracks, joints),
 *   as a digest, so a structural move shows without a page of coordinates;
 * - the breakout mould fragments of the starter's breakout design.
 */
const fixture = fixtureCatalog();
const db = fixture.loadDb();
const art = depictionsFromRoot(fixtureDepictionsRoot());

const pretty = (svg: string): string => svg.replace(/></g, '>\n<');

/** The `<g class="…">` element with that class, matched by balanced nesting. */
function groupOf(svg: string, cls: string): string {
  const start = svg.indexOf(`<g class="${cls}"`);
  if (start < 0) return '';
  let depth = 0;
  const tag = /<g\b|<\/g>/g;
  tag.lastIndex = start;
  for (let m = tag.exec(svg); m !== null; m = tag.exec(svg)) {
    depth += m[0] === '</g>' ? -1 : 1;
    if (depth === 0) return svg.slice(start, m.index + 4);
  }
  return svg.slice(start);
}

describe('golden cross-sections', () => {
  for (const wire of db.wires) {
    it(`${wire.id} matches its golden cutaway`, () => {
      expect(pretty(renderCrossSection(wire))).toMatchSnapshot();
    });
  }
});

describe('golden structure', () => {
  for (const id of fixture.listDesignIds()) {
    it(`${id} matches its structure digest`, () => {
      const d = layoutSchematic(fixture.loadDesign(id), db, { depictions: false });
      const digest = {
        blocks: d.blocks.map((b) => ({ id: b.id, kind: b.kind, def: b.def, ports: b.ports.length, side: b.cableSide })),
        bands: d.bands.map((b) => ({
          segment: b.segment,
          def: b.def,
          label: b.label,
          zone: b.zone,
          leftEnd: b.leftEnd,
          tracks: b.tracks.map((t) => [t.key, t.kind, t.role, t.colorName ?? null]),
          groups: b.groups.length,
          pigtails: b.pigtails.length,
        })),
        joints: d.jointDots.map((j) => [j.key, j.degree]),
        cutEnds: d.cutEnds.length,
        edges: d.edges.length,
        components: d.components.length,
        crossSection: d.crossSection?.subtitle ?? null,
        issues: d.issues.map((i) => i.code),
      };
      expect(JSON.stringify(digest, null, 1)).toMatchSnapshot();
    });
  }
});

describe('golden breakouts', () => {
  for (const id of fixture.listDesignIds().filter((d) => layoutSchematic(fixture.loadDesign(d), db, { depictions: false }).breakouts !== undefined)) {
    for (const [name, depictions] of [['plain', false], ['depicted', art]] as const) {
      it(`${id} matches its ${name} breakout mould and wiring`, () => {
        const svg = renderSchematic(fixture.loadDesign(id), db, { depictions, crossSection: false });
        const mould = groupOf(svg, 'breakouts');
        const wiring = groupOf(svg, 'breakout-wiring');
        expect(mould).not.toBe('');
        expect(wiring).not.toBe('');
        expect(pretty(mould + wiring)).toMatchSnapshot();
      });
    }
  }
});
