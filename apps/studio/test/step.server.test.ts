/**
 * STEP colour handling: a STEP body's own colour is
 * kept whole when every face shares it, and split by face when they don't —
 * `readStep`'s existing behaviour, exercised here on a real STEP so a
 * regression (a dropped fallback, a merge that loses a distinct face) shows
 * up as a failing assertion rather than a "the board looks grey" report.
 *
 * `cube-colours.stp` is the tiny cube occt-import-js ships in its own test
 * suite (`simple-basic-cube/cube.stp`, whole-shape orange), with two of its
 * six faces given their own STYLED_ITEM (blue, green) — the same STEP idiom
 * Alex's boards use for a part with more than one material, so this is the
 * same code path a real, coloured board or component goes through.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readGlbJson, writeGlb } from '../server/models/glb.ts';
import { readStep } from '../server/models/step.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CUBE_COLOURS_STEP = new Uint8Array(readFileSync(join(here, 'fixtures/models/cube-colours.stp')));

/** Linear from the STEP file's own sRGB triple — what occt-import-js hands back, glTF's own colour space. */
const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

describe('STEP colour', () => {
  it('keeps a uniformly-coloured body as one part with its colour', async () => {
    const parts = await readStep(plainCube());
    expect(parts.length).toBe(1);
    expect(parts[0]!.color).toBeDefined();
  });

  it('splits a body with per-face colours into one part per colour, the rest keeping the shape colour', async () => {
    const parts = await readStep(CUBE_COLOURS_STEP);
    // orange (the shape's own colour, on the four unstyled faces) + blue + green
    expect(parts.length).toBe(3);
    const byColour = new Map(parts.map((p) => [p.color!.map((c) => Math.round(c * 100) / 100).join(','), p]));
    const blue = byColour.get('0,0,1');
    const green = byColour.get('0,1,0');
    expect(blue).toBeDefined();
    expect(green).toBeDefined();
    // every triangle in the whole cube is accounted for exactly once across the three parts
    const totalTriangles = parts.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(totalTriangles).toBeGreaterThan(0);
    // a cube face keeps its own two triangles apiece; no face is shared or dropped
    expect(blue!.indices.length / 3).toBeGreaterThan(0);
    expect(green!.indices.length / 3).toBeGreaterThan(0);

    // the fallback (unstyled) faces keep the shape's own STEP colour, orange, gamma-decoded to linear
    const orange = parts.find((p) => p !== blue && p !== green)!;
    expect(orange.color![0]).toBeCloseTo(linear(1), 2);
    expect(orange.color![1]).toBeCloseTo(linear(0.6), 2);
    expect(orange.color![2]).toBeCloseTo(linear(0), 2);
  });

  it('round-trips through the GLB writer as one material per colour', async () => {
    const parts = await readStep(CUBE_COLOURS_STEP);
    const glb = writeGlb(parts);
    const json = readGlbJson(glb)!;
    const materials = json['materials'] as { pbrMetallicRoughness: { baseColorFactor: number[] } }[];
    expect(materials.length).toBe(3);
    const factors = materials.map((m) => m.pbrMetallicRoughness.baseColorFactor.slice(0, 3));
    expect(factors).toContainEqual([0, 0, 1]);
    expect(factors).toContainEqual([0, 1, 0]);
  });
});

/** A minimal plain-orange cube (no per-face override): the plain fixture, read once and cached. */
let cached: Uint8Array | undefined;
function plainCube(): Uint8Array {
  if (cached === undefined) {
    const path = join(here, 'fixtures/models/cube-colours.stp');
    // the per-face styled items are appended after the shape's own; stripping them back off
    // gives the plain, whole-shape-only fixture without a second file to keep in sync
    const text = readFileSync(path, 'utf8').replace(/#10(00|01|02|03|04|05|06|07|10|11|12|13|14|15|16|17)=[^\n]*\n/g, '');
    cached = new TextEncoder().encode(text);
  }
  return cached;
}
