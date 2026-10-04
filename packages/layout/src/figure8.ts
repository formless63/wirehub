/**
 * The outline of a figure-8 (siamese / zip) cable end-on: two equal circles
 * — the legs' jackets — joined by a web of half-thickness `webHalf`, as one
 * closed SVG path. Works at any orientation (the
 * lobes' centres set it), so a rotated or mirrored end face draws with the
 * same helper. Pure geometry: numbers in, a path string out, 3 dp.
 */

export interface Lobe {
  x: number;
  y: number;
}

const f = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return (Object.is(rounded, -0) ? 0 : rounded).toString();
};

export function figure8Path(a: Lobe, b: Lobe, r: number, webHalf: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const pitch = Math.hypot(dx, dy);
  const R = `${f(r)} ${f(r)}`;
  if (pitch <= 1e-9 || r <= 0) {
    return `M${f(a.x - r)} ${f(a.y)}A${R} 0 1 1 ${f(a.x + r)} ${f(a.y)}A${R} 0 1 1 ${f(a.x - r)} ${f(a.y)}Z`;
  }
  const ux = dx / pitch;
  const uy = dy / pitch;
  // the normal, a quarter turn from the axis (so the winding never flips)
  const nx = -uy;
  const ny = ux;
  // a web can be no thinner than where two overlapping lobes already meet,
  // and no thicker than a lobe
  const overlapHalf = pitch < 2 * r ? Math.sqrt(r * r - (pitch / 2) ** 2) : 0;
  const h = Math.min(Math.max(webHalf, overlapHalf), r * 0.999);
  const along = Math.min(Math.sqrt(r * r - h * h), pitch / 2);
  const p = (c: Lobe, s: number, t: number): string => `${f(c.x + s * ux + t * nx)} ${f(c.y + s * uy + t * ny)}`;
  return [
    `M${p(a, along, -h)}`,
    `L${p(b, -along, -h)}`,
    `A${R} 0 1 1 ${p(b, -along, h)}`,
    `L${p(a, along, h)}`,
    `A${R} 0 1 1 ${p(a, along, -h)}`,
    'Z',
  ].join('');
}
