/**
 * The board's Edge.Cuts outline, as the gerber tier commits it, and the one
 * question the pipeline and the renderers ask of it: from a pad, which way
 * along the pad's own axis is *off the board*.
 *
 * Pure and dependency-free — `gerber.ts` uses it at generation time, and
 * `@cable-studio/layout` re-exports it for the entry guides and the landing
 * tests, so all of them read one outline the same way.
 */

export interface OutlineXY {
  x: number;
  y: number;
}

/**
 * The board's Edge.Cuts outline from a gerber-tier `board-top.svg`: the
 * `…-shape` clip path `import-gerbers` writes, shifted by the drawing's own
 * translate into the anchor frame. Arcs are taken as chords (the outline's
 * corner fillets are 0.5 mm). `undefined` when the file has no such path.
 */
export function boardOutlineFromSvg(svg: string): OutlineXY[] | undefined {
  const clip = /<clipPath id="[^"]*-shape"><path d="([^"]+)"/.exec(svg);
  if (clip === null) return undefined;
  const shift = /<g transform="translate\((-?[\d.]+)[ ,]+(-?[\d.]+)\)"/.exec(svg);
  const ox = shift === null ? 0 : Number(shift[1]);
  const oy = shift === null ? 0 : Number(shift[2]);
  const tokens = clip[1]!.match(/[MLAZ]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
  const points: OutlineXY[] = [];
  let i = 0;
  let command = 'M';
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/^[MLAZ]$/i.test(token)) {
      command = token.toUpperCase();
      i += 1;
      if (command === 'Z') continue;
    }
    if (command === 'A') {
      const x = Number(tokens[i + 5]);
      const y = Number(tokens[i + 6]);
      i += 7;
      points.push({ x: x + ox, y: y + oy });
    } else {
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      i += 2;
      points.push({ x: x + ox, y: y + oy });
    }
  }
  const deduped = points.filter((p, k) => k === 0 || p.x !== points[k - 1]!.x || p.y !== points[k - 1]!.y);
  return deduped.length >= 3 ? deduped : undefined;
}

/**
 * How far (mm) a ray from `point` along the unit `direction` runs before it
 * first meets the outline — `Infinity` when it never does (a point outside
 * the board looking away from it).
 */
export function outlineExit(point: OutlineXY, direction: OutlineXY, outline: readonly OutlineXY[]): number {
  let best = Infinity;
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = direction.x * ey - direction.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - point.x) * ey - (a.y - point.y) * ex) / den;
    const u = ((a.x - point.x) * direction.y - (a.y - point.y) * direction.x) / den;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
}
