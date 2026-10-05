/**
 * Board artwork as a depiction (`meta.json` + `board-top.svg` /
 * `board-bottom.svg`, the format in `@wirehub/catalog`'s depictions): the
 * frame, the anchors and the two tiers this module draws.
 *
 * **Frame.** Both tiers draw in the same frame: millimetres, origin at the
 * top-left of the board outline's bounding box, y down — the frame the KiCad
 * import gives each terminal's pads in. A Gerber set and the `.kicad_pcb` it
 * was plotted from therefore line up whatever origin the plot used. The
 * `board-bottom` view is the board seen from below: the same frame reflected
 * about x (`mirrorOf: 'board-top'`, `mirrorAxis: 'x'`), so anchors are written
 * once, in `board-top`.
 *
 * - `kicad` tier (`kicadDepiction`): the outline and the copper pads, from
 *   the `.kicad_pcb` alone.
 * - `gerber` tier (`gerber-art.ts`): the fabrication layers rendered.
 *
 * Every id inside an SVG is prefixed by the definition id, so two boards
 * inlined on one canvas never share one. Pure.
 */

import type { PcbaDefinition } from '@wirehub/model';
import type { ImportedDepiction } from '@wirehub/modules';

import type { TerminalPad } from './derive.ts';
import type { BoardSource, Point } from './kicad.ts';

export const COLOURS = {
  substrate: '#c2b280',
  mask: '#1f6b3a',
  copperUnderMask: '#3f8a4f',
  copper: '#c9a34a',
  silk: '#f4f4f0',
  hole: '#16181a',
} as const;

export function n(value: number): string {
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

export function idPrefix(defId: string): string {
  return defId.replace(/[^a-z0-9-]/g, '-');
}

export function loopPath(loop: readonly Point[], at: (p: Point) => Point = (p) => p): string {
  if (loop.length === 0) return '';
  return `${loop.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(at(p).x)} ${n(at(p).y)}`).join('')}Z`;
}

export function svgOpen(width: number, height: number, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}mm" height="${n(height)}mm"><title>${escapeXml(title)}</title>`;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A terminal's anchor: its primary pad, and every pad behind it. */
export function anchorsOf(pads: ReadonlyMap<string, readonly TerminalPad[]>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, list] of [...pads.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const primary = list[0];
    if (primary === undefined) continue;
    out[id] = {
      x: primary.x,
      y: primary.y,
      side: primary.side,
      pads: list.map((p) => ({ ref: p.ref, pad: p.pad, x: p.x, y: p.y, side: p.side })),
      ...(list.length > 1 ? { note: `${list.length} pads; the first visible from the top is the anchor` } : {}),
    };
  }
  return out;
}

/** The pads of a PCBA record as anchor input (what the KiCad import stored on its terminals). */
export function padsOfPcba(pcba: PcbaDefinition): Map<string, TerminalPad[]> {
  const out = new Map<string, TerminalPad[]>();
  for (const terminal of pcba.terminals) {
    const list: TerminalPad[] = [];
    for (const pad of terminal.pads ?? []) {
      if (pad.x === undefined || pad.y === undefined) continue;
      const number = /^pad (.+)$/.exec(pad.note ?? '')?.[1] ?? '1';
      list.push({ ref: pad.ref, pad: number, x: pad.x, y: pad.y, side: pad.side ?? 'top' });
    }
    if (list.length > 0) out.set(terminal.id, list);
  }
  return out;
}

export interface DepictionInput {
  defId: string;
  width: number;
  height: number;
  top: string;
  bottom: string;
  sourceKind: 'kicad' | 'gerber';
  anchors: Record<string, Record<string, unknown>>;
  sources: { role: string; path: string; sha256: string }[];
  src: string;
  replaces?: readonly string[];
}

export function depiction(input: DepictionInput): ImportedDepiction {
  const view = (file: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    file,
    kind: 'vector',
    mmPerUnit: 1,
    sourceKind: input.sourceKind,
    widthUnits: Math.round(input.width * 1000) / 1000,
    heightUnits: Math.round(input.height * 1000) / 1000,
    ...extra,
    src: input.src,
  });
  return {
    defId: input.defId,
    meta: {
      defId: input.defId,
      views: {
        'board-top': view('board-top.svg'),
        'board-bottom': view('board-bottom.svg', { mirrorOf: 'board-top', mirrorAxis: 'x' }),
      },
      pinAnchors: input.anchors,
      anchorFrame: 'board-top',
      sources: input.sources,
      src: input.src,
    },
    files: { 'board-top.svg': input.top, 'board-bottom.svg': input.bottom },
    ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
  };
}

function padShape(pad: { x: number; y: number; w: number; h: number; angle: number; shape?: string }, fill: string): string {
  const round = pad.shape === 'circle' || (pad.shape === 'oval' && Math.abs(pad.w - pad.h) < 1e-6);
  if (round) return `<circle cx="${n(pad.x)}" cy="${n(pad.y)}" r="${n(pad.w / 2)}" fill="${fill}"/>`;
  const rx = pad.shape === 'oval' ? Math.min(pad.w, pad.h) / 2 : pad.shape === 'roundrect' ? Math.min(pad.w, pad.h) * 0.25 : 0;
  const rotate = Math.abs(pad.angle) < 1e-9 ? '' : ` transform="rotate(${n(pad.angle)} ${n(pad.x)} ${n(pad.y)})"`;
  return `<rect x="${n(pad.x - pad.w / 2)}" y="${n(pad.y - pad.h / 2)}" width="${n(pad.w)}" height="${n(pad.h)}"${rx > 0 ? ` rx="${n(rx)}"` : ''} fill="${fill}"${rotate}/>`;
}

/**
 * The `kicad` tier: the board's outline (with its cut-outs) and the copper
 * pads of each face, drawn from the `.kicad_pcb` — art a board has the moment
 * it is imported, replaced by the `gerber` tier when its Gerbers come in.
 */
export function kicadDepiction(
  source: BoardSource,
  defId: string,
  pads: ReadonlyMap<string, readonly TerminalPad[]>,
  citation: { path: string; sha256: string },
): ImportedDepiction | undefined {
  const frame = source.frame;
  if (frame === undefined || source.format !== 'kicad-pcb') return undefined;
  const { width, height } = frame;
  const local = (p: Point): Point => ({ x: p.x - frame.x0, y: p.y - frame.y0 });
  const mirror = (p: Point): Point => ({ x: width - (p.x - frame.x0), y: p.y - frame.y0 });
  const prefix = idPrefix(defId);
  const draw = (face: 'top' | 'bottom'): string => {
    const at = face === 'top' ? local : mirror;
    const board = source.outline === undefined ? `M0 0H${n(width)}V${n(height)}H0Z` : [source.outline, ...(source.cutouts ?? [])].map((loop) => loopPath(loop, at)).join('');
    const copper: string[] = [];
    const holes: string[] = [];
    for (const fp of source.footprints) {
      for (const pad of fp.pads) {
        if (pad.x === undefined || pad.y === undefined || pad.w === undefined || pad.h === undefined) continue;
        const through = pad.kind === 'thru_hole' || pad.kind === 'np_thru_hole';
        const onFace = through || pad.layers.some((l) => l === '*.Cu' || l.startsWith(face === 'top' ? 'F.' : 'B.'));
        if (!onFace) continue;
        const p = at({ x: pad.x, y: pad.y });
        const angle = face === 'top' ? -(pad.angle ?? 0) : pad.angle ?? 0;
        if (pad.kind !== 'np_thru_hole') copper.push(padShape({ x: p.x, y: p.y, w: pad.w, h: pad.h, angle, ...(pad.shape === undefined ? {} : { shape: pad.shape }) }, COLOURS.copper));
        if (through && pad.drill !== undefined) holes.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(pad.drill / 2)}" fill="${COLOURS.hole}"/>`);
      }
    }
    return [
      svgOpen(width, height, `${defId} — ${face} (from the KiCad board)`),
      `<g id="${prefix}-${face}-board"><path d="${board}" fill="${COLOURS.mask}" fill-rule="evenodd" stroke="${COLOURS.substrate}" stroke-width="0.15"/></g>`,
      `<g id="${prefix}-${face}-copper">${copper.join('')}</g>`,
      `<g id="${prefix}-${face}-holes">${holes.join('')}</g>`,
      '</svg>',
      '',
    ].join('\n');
  };
  return depiction({
    defId,
    width,
    height,
    top: draw('top'),
    bottom: draw('bottom'),
    sourceKind: 'kicad',
    anchors: anchorsOf(pads),
    sources: [{ role: 'kicad-pcb', path: citation.path, sha256: citation.sha256 }],
    src: `Drawn by the board-import module from ${citation.path} (sha256 ${citation.sha256.slice(0, 16)}…): Edge.Cuts outline and copper pads; anchors at each terminal's pads`,
    replaces: ['kicad'],
  });
}
