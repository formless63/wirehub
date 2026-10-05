/**
 * Sheet art from depictions (`specs/drawing-language.md` §6).
 *
 * A connector's depiction (`mating-face` and its mirrored `solder-side`, an
 * SVG with `data-pin` elements and a pin anchor per position) becomes the
 * sheet's solder-side face; a wire stock's `illustration` becomes its
 * cutaway. The reader understands the vocabulary the face generator and
 * the depiction importer emit — absolute-coordinate paths (`M L H V Z`),
 * rects, circles and text — and ignores anything else, so an exotic asset
 * costs its detail, never the sheet.
 *
 * Units: faces are millimetres in the asset; the sheet draws in points, so
 * the face is scaled to put the closest two pins about 13 pt apart (the
 * pitch of the traced faces), within sane bounds.
 */

import type { DepictionSource } from '@wirehub/layout';
import type { ConnectorDefinition, WireDefinition } from '@wirehub/model';

import type { CutawayArt } from './assets.ts';
import type { FaceArt, FaceArtPath, FacePin } from './faces.ts';

const r2 = (v: number): number => Math.round(v * 100) / 100;

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}

const num = (tag: string, name: string): number => Number(attr(tag, name) ?? 0);

function unescapeXml(v: string): string {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** `M1 2 L3 4 Z` scaled; `undefined` for a command the reader does not do. */
function scalePath(d: string, k: number): string | undefined {
  const out: string[] = [];
  for (const [, cmd, args] of d.matchAll(/([MLHVZmlhvz])([^MLHVZmlhvz]*)/g)) {
    if (cmd !== cmd!.toUpperCase()) return undefined;
    const v = (args!.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
    out.push(cmd === 'Z' ? 'Z' : `${cmd}${v.map((n) => r2(n * k)).join(' ')}`);
  }
  return out.join('');
}

function roundedRect(x: number, y: number, w: number, h: number, rx: number): string {
  if (rx <= 0) return `M${x} ${y}H${r2(x + w)}V${r2(y + h)}H${x}Z`;
  const a = r2(x + rx);
  const b = r2(x + w - rx);
  const c = r2(y + rx);
  const e = r2(y + h - rx);
  const xr = r2(x + w);
  const yb = r2(y + h);
  return `M${a} ${y}H${b}Q${xr} ${y} ${xr} ${c}V${e}Q${xr} ${yb} ${b} ${yb}H${a}Q${x} ${yb} ${x} ${e}V${c}Q${x} ${y} ${a} ${y}Z`;
}

function circlePath(cx: number, cy: number, rad: number): string {
  const k = 0.5523 * rad;
  const [l, t, rt, b] = [cx - rad, cy - rad, cx + rad, cy + rad].map(r2) as [number, number, number, number];
  const f = (n: number): number => r2(n);
  return `M${cx} ${t}C${f(cx + k)} ${t} ${rt} ${f(cy - k)} ${rt} ${cy}C${rt} ${f(cy + k)} ${f(cx + k)} ${b} ${cx} ${b}C${f(cx - k)} ${b} ${l} ${f(cy + k)} ${l} ${cy}C${l} ${f(cy - k)} ${f(cx - k)} ${t} ${cx} ${t}Z`;
}

const STROKE = '#000000';

/** The face a depiction's solder-side SVG draws, or `undefined` when it is not readable that way. */
export function faceFromDepiction(svg: string, def: ConnectorDefinition, widthMm: number, heightMm: number, meta: { src: string }): FaceArt | undefined {
  const tags = [...svg.matchAll(/<(path|rect|circle|text)\b([^>]*?)(?:\/>|>([^<]*)<\/text>)/g)].map((m) => ({ el: m[1]!, tag: ` ${m[2]!}`, body: m[3] }));
  const pinTags = tags.filter((t) => attr(t.tag, 'data-pin') !== undefined);
  // scale: closest two pins ≈ 13 pt
  const centres = pinTags.map((t) => (t.el === 'circle' ? [num(t.tag, 'cx'), num(t.tag, 'cy')] : [num(t.tag, 'x') + num(t.tag, 'width') / 2, num(t.tag, 'y') + num(t.tag, 'height') / 2]) as [number, number]);
  let nearest = Infinity;
  centres.forEach(([x, y], i) => centres.slice(i + 1).forEach(([x2, y2]) => (nearest = Math.min(nearest, Math.hypot(x - x2, y - y2)))));
  const k = Number.isFinite(nearest) && nearest > 0 ? Math.min(10, Math.max(3, 13 / nearest)) : Math.min(8, 120 / Math.max(widthMm, heightMm, 1));
  const art: FaceArtPath[] = [];
  const pins: FacePin[] = [];
  const labels: { text: string; x: number; y: number }[] = [];
  for (const t of tags) {
    const id = attr(t.tag, 'data-pin');
    if (id !== undefined) {
      pins.push(
        t.el === 'circle'
          ? { id: unescapeXml(id), x: r2(num(t.tag, 'cx') * k), y: r2(num(t.tag, 'cy') * k), w: r2(num(t.tag, 'r') * 2 * k), h: r2(num(t.tag, 'r') * 2 * k), shape: 'circle' }
          : { id: unescapeXml(id), x: r2((num(t.tag, 'x') + num(t.tag, 'width') / 2) * k), y: r2((num(t.tag, 'y') + num(t.tag, 'height') / 2) * k), w: r2(num(t.tag, 'width') * k), h: r2(num(t.tag, 'height') * k), shape: 'rect' },
      );
      continue;
    }
    if (t.el === 'text') {
      if (t.body !== undefined) labels.push({ text: unescapeXml(t.body), x: r2(num(t.tag, 'x') * k), y: r2(num(t.tag, 'y') * k) });
      continue;
    }
    let d: string | undefined;
    if (t.el === 'path') d = scalePath(attr(t.tag, 'd') ?? '', k);
    else if (t.el === 'rect') d = roundedRect(r2(num(t.tag, 'x') * k), r2(num(t.tag, 'y') * k), r2(num(t.tag, 'width') * k), r2(num(t.tag, 'height') * k), r2(num(t.tag, 'rx') * k));
    else d = circlePath(r2(num(t.tag, 'cx') * k), r2(num(t.tag, 'cy') * k), r2(num(t.tag, 'r') * k));
    if (d !== undefined && d !== '') art.push({ d, stroke: STROKE, width: 1 });
  }
  if (art.length === 0 || pins.length === 0) return undefined;
  const approximate = /approximate|inferred/i.test(meta.src);
  const gender = def.gender === undefined ? '' : `${def.gender[0]?.toUpperCase()}${def.gender.slice(1)} `;
  return {
    material: `${gender}${def.label.replace(/\s*\(.*$/, '').replace(/,.*$/, '').replace(/\s+(male|female)\b/i, '').trim()}`,
    width: r2(widthMm * k),
    height: r2(heightMm * k),
    art,
    pins,
    labels,
    src: meta.src,
    ...(approximate ? { approximate: 'Approx. outline' } : {}),
  };
}

/** The ids a connector's artwork may be filed under: itself, its body. */
export function artKeys(def: ConnectorDefinition): string[] {
  return def.body === undefined ? [def.id] : [def.id, def.body];
}

/** The depicted solder-side face for a connector, when the source has one. */
export function depictedFace(source: DepictionSource | undefined, def: ConnectorDefinition): FaceArt | undefined {
  if (source === undefined) return undefined;
  for (const key of artKeys(def)) {
    const meta = source.meta(key);
    const asset = meta?.views['solder-side'];
    if (meta === undefined || asset === undefined || asset.kind !== 'vector' || asset.widthUnits === undefined || asset.heightUnits === undefined) continue;
    const art = source.artwork(key, 'solder-side');
    if (art?.source === undefined) continue;
    const face = faceFromDepiction(art.source, def, asset.widthUnits * asset.mmPerUnit, asset.heightUnits * asset.mmPerUnit, meta);
    if (face !== undefined) return face;
  }
  return undefined;
}

/** The depicted cutaway (an `illustration` view) for a wire stock. */
export function depictedCutaway(source: DepictionSource | undefined, wire: WireDefinition): CutawayArt | undefined {
  const meta = source?.meta(wire.id);
  const asset = meta?.views['illustration'];
  if (source === undefined || asset === undefined || asset.kind !== 'vector' || asset.widthUnits === undefined || asset.heightUnits === undefined) return undefined;
  const art = source.artwork(wire.id, 'illustration');
  if (art?.source === undefined) return undefined;
  return { svg: art.source, width: asset.widthUnits, height: asset.heightUnits };
}
