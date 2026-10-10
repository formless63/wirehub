/**
 * The pack's art draws: the RJ45 face a pack ships (a depiction keyed by the
 * body) appears on a design that uses the plug, with the pins on their
 * anchors; without the pack's depictions the same design draws the abstract
 * block it always did.
 */

import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource } from '@wirehub/catalog';
import { depictionsFromRoot, layeredDepictions, layoutSchematic } from '@wirehub/layout';
import { renderSchematic } from '@wirehub/render-svg';
import { describe, expect, it } from 'vitest';

import { NETWORKING_PACK } from '../src/index.ts';

const packDir = fileURLToPath(NETWORKING_PACK);
const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'networking')]));
const db = catalog.loadDb();
const design = catalog.loadDesign('rj45-patch-t568b');
const withPack = layeredDepictions(depictionsFromRoot(`${packDir}depictions`));
const baseOnly = depictionsFromRoot(fileURLToPath(new URL('../../../packages/catalog/depictions', import.meta.url)));

describe('RJ45 pack art', () => {
  it('draws the plug as the pack\'s face, by its body, with ports on the anchors', () => {
    const diagram = layoutSchematic(design, db, { depictions: withPack });
    const plug = diagram.blocks.find((b) => b.id === 'j1')!;
    expect(plug.depiction?.defId).toBe('rj45-8p8c-plug');
    expect(plug.depiction?.view).toBe('mating-face');
    expect(plug.depiction?.turn).toBe(90);
    expect(plug.depiction?.widthUnits).toBe(18);
    expect(plug.ports.length).toBeGreaterThan(0);
    const svg = renderSchematic(design, db, { depictions: withPack });
    expect(svg).toContain('data-depiction="rj45-8p8c-plug/mating-face"');
    expect(renderSchematic(design, db, { depictions: withPack })).toBe(svg);
  });

  it('draws without the pack: the abstract block, no depiction, no diagnostics', () => {
    const diagram = layoutSchematic(design, db, { depictions: baseOnly });
    expect(diagram.blocks.find((b) => b.id === 'j1')?.depiction).toBeUndefined();
    expect(diagram.depictions.filter((d) => d.status !== 'no-depiction' && d.status !== 'drawn')).toEqual([]);
    expect(renderSchematic(design, db, { depictions: baseOnly })).not.toContain('rj45-8p8c-plug/mating-face');
  });

  it('draws the new jack from its own open-mouth face with all eight contact anchors', () => {
    const jackDesign = structuredClone(design);
    jackDesign.instances.connectors[0]!.def = 'rj45-jack-mdi';
    const diagram = layoutSchematic(jackDesign, db, { depictions: withPack });
    const jack = diagram.blocks.find((b) => b.id === 'j1')!;
    expect(jack.depiction?.defId).toBe('rj45-8p8c-jack');
    expect(jack.ports).toHaveLength(8);
    expect(renderSchematic(jackDesign, db, { depictions: withPack })).toContain('data-depiction="rj45-8p8c-jack/mating-face"');
  });
});
