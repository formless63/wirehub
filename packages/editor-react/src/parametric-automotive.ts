/**
 * Rounded diagnostic and sealed rectangular connector envelopes. Original
 * geometry, not manufacturer CAD: the link cites the dimensions and marks
 * inferred latch, cavity and rib detail. Axes match parametric-model.ts.
 */
import type { ParametricSpec } from '@wirehub/model';

type V = [number, number, number];
type Poly = [number, number][];
type Material = 'black' | 'rubber' | 'steel' | 'green' | 'polymer-gray' | 'seal-orange';

/** Structural seam: the shared renderer owns triangulation and glTF materials. */
export interface ConnectorMesh {
  box(m: Material, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void;
  cylinder(m: Material, from: V, to: V, r0: number, r1?: number, segments?: number, capped?: boolean): void;
  prism(m: Material, outline: Poly, z0: number, z1: number): void;
  ring(m: Material, outer: Poly, inner: Poly, z0: number, z1: number): void;
}
type Params = Record<string, number>;

/** Convex rounded rectangle, independently tessellated rather than a box. */
function roundedRect(w: number, h: number, r: number): Poly {
  const radius = Math.min(r, w / 3, h / 3);
  const centres: Poly = [[w / 2 - radius, h / 2 - radius], [-w / 2 + radius, h / 2 - radius], [-w / 2 + radius, -h / 2 + radius], [w / 2 - radius, -h / 2 + radius]];
  return centres.flatMap(([cx, cy], corner) => Array.from({ length: 7 }, (_, i) => {
    const angle = (corner * Math.PI / 2) + i * Math.PI / 12;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as [number, number];
  }));
}

function circle(x: number, y: number, r: number): Poly {
  return Array.from({ length: 24 }, (_, i) => [x + r * Math.cos(i * Math.PI / 12), y + r * Math.sin(i * Math.PI / 12)] as [number, number]);
}

function trapezoid(w: number, h: number): Poly {
  const chamfer = Math.min(1.2, h / 8);
  const lower = w / 2 - h * 0.19;
  return [[-w / 2 + chamfer, h / 2], [-w / 2, h / 2 - chamfer], [-lower, -h / 2 + chamfer], [-lower + chamfer, -h / 2], [lower - chamfer, -h / 2], [lower, -h / 2 + chamfer], [w / 2, h / 2 - chamfer], [w / 2 - chamfer, h / 2]];
}

/** Two banks of eight recessed terminals inside a keyed diagnostic shell. */
export function obd2(mesh: ConnectorMesh, spec: ParametricSpec, p: Params): void {
  const w = p['widthMm']!;
  const h = p['heightMm']!;
  const length = p['lengthMm']!;
  const male = spec.gender === 'male';
  const back = -length * 0.55;
  const front = length * 0.45;
  const floor = front - (male ? 4.5 : 5.5);
  mesh.prism('black', trapezoid(w, h), back, floor);
  mesh.ring('black', trapezoid(w, h), trapezoid(w - 2.1, h - 2.1), floor, front);
  // Type-A central polarizing feature; molded side grip ribs.
  mesh.box('black', 0, -h / 2 + 0.6, front - 1.2, 3, 1.2, 2.4);
  for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) {
    mesh.box('rubber', sx * (w / 2 - 0.65), 0, back + 2 + i * (floor - back - 4) / 4, 0.5, h * 0.6, 0.5);
  }
  for (let row = 0; row < 2; row++) for (let col = 0; col < 8; col++) {
    const x = (col - 3.5) * p['pinPitchMm']!;
    const y = (0.5 - row) * p['rowPitchMm']!;
    const surround: Poly = [[x - 1.35, y - 1.5], [x + 1.35, y - 1.5], [x + 1.35, y + 1.5], [x - 1.35, y + 1.5]];
    const cavity: Poly = [[x - 0.9, y - 1.05], [x + 0.9, y - 1.05], [x + 0.9, y + 1.05], [x - 0.9, y + 1.05]];
    mesh.ring('black', surround, cavity, floor, front - 1);
    if (male) mesh.box('steel', x, y, front - 2.4, 0.8, 1.8, 3.6);
    else for (const side of [-1, 1]) mesh.box('steel', x + side * 0.72, y, front - 2.6, 0.18, 1.5, 2.8);
    // Open crimp barrels at the rear, visible when the model is turned over.
    mesh.ring('steel', circle(x, y, 0.95), circle(x, y, 0.62), back - 0.5, back + 1.2);
  }
}

/** Rounded shroud, recessed pin/socket wells, latch and rear mat seal. */
export function sealedRectangular(mesh: ConnectorMesh, spec: ParametricSpec, p: Params): void {
  const w = p['widthMm']!;
  const h = p['heightMm']!;
  const length = p['lengthMm']!;
  const rows = p['rows']!;
  const columns = spec.pins / rows;
  const male = spec.gender === 'male';
  // Most gray sealed housings have a latch above the rounded main envelope.
  const bodyHeight = h * 0.84;
  const floor = length * 0.29;
  const front = length * 0.5;
  const back = -length * 0.5;
  mesh.prism('polymer-gray', roundedRect(w, bodyHeight, 2.2), back + 2.4, floor);
  mesh.ring('polymer-gray', roundedRect(w, bodyHeight, 2.2), roundedRect(w - 2.4, bodyHeight - 2.4, 1.2), floor, front);
  // An actual open gap below the locking arm, rather than a solid cuboid.
  mesh.box('polymer-gray', 0, bodyHeight / 2 + h * 0.04, -length * 0.12, w * 0.42, h * 0.08, length * 0.34);
  mesh.box('polymer-gray', 0, bodyHeight / 2 + h * 0.11, 0, w * 0.46, h * 0.06, length * 0.45);
  mesh.box('polymer-gray', 0, bodyHeight / 2 + h * 0.08, length * 0.19, w * 0.46, h * 0.1, length * 0.06);
  // Secondary lock is a contrasting nonmetallic insert, not exposed metal.
  mesh.prism(male ? 'green' : 'seal-orange', roundedRect(w - 4.2, bodyHeight - 4.2, 1), floor + 0.1, floor + 0.6);
  mesh.prism('seal-orange', roundedRect(w - 1.3, bodyHeight - 1.3, 2), back, back + 2.4);
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const x = (col - (columns - 1) / 2) * p['pinPitchMm']!;
    const y = ((rows - 1) / 2 - row) * p['rowPitchMm']!;
    mesh.ring('polymer-gray', circle(x, y, 1.65), circle(x, y, 1.18), floor + 0.6, front - 0.8);
    if (male) mesh.cylinder('steel', [x, y, floor + 0.65], [x, y, front - 1.1], 0.79, 0.68, 24);
    else mesh.ring('steel', circle(x, y, 1.05), circle(x, y, 0.79), floor + 0.6, front - 1.2);
    // A dark well and the molded sealing lip clearly separate rear cavities.
    mesh.cylinder('black', [x, y, back - 0.08], [x, y, back - 0.02], 1.15, 1.15, 24);
    mesh.ring('seal-orange', circle(x, y, 1.62), circle(x, y, 1.2), back - 0.05, back + 0.1);
  }
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
    mesh.box('polymer-gray', sx * (w / 2 - 0.3), 0, -length * 0.28 + i * length * 0.12, 0.6, bodyHeight * 0.6, 0.6);
  }
}
