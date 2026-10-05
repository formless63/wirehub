/**
 * A Gerber set (the zip a board house takes) → the board's `gerber`-tier
 * depiction: `board-top.svg` and `board-bottom.svg`, each the substrate, the
 * copper, the solder mask with its openings, the silkscreen and the drilled
 * holes of one face, clipped to the board outline; and the anchors of the
 * board's terminals where the PCBA record knows its pads' positions (a KiCad
 * import), each checked against the copper flashes of its face.
 *
 * Layers are recognised by their X2 file function (`%TF.FileFunction%`), else
 * by the names KiCad, Protel-style extensions and the common CAM tools use.
 * Paste, fabrication, courtyard and inner copper layers are not drawn.
 */

import type { PcbaDefinition } from '@wirehub/model';
import type { ImportedDepiction } from '@wirehub/modules';

import { anchorsOf, COLOURS, depiction, idPrefix, loopPath, n, padsOfPcba, svgOpen } from './art.ts';
import type { TerminalPad } from './derive.ts';
import { isExcellon, parseExcellon, plotGerber, PAINT, type Drill, type LayerPlot } from './gerber.ts';
import { boundsOf, chainLoops, type BoardFrame, type Point } from './kicad.ts';
import type { ZipEntry } from './zip.ts';

export type LayerRole = 'copper-top' | 'copper-bottom' | 'mask-top' | 'mask-bottom' | 'silk-top' | 'silk-bottom' | 'outline' | 'drill' | 'ignored';

const BY_NAME: [RegExp, LayerRole][] = [
  [/(\.gtl|[-_.]F[_.]Cu\.\w+|[-_]top[-_]?copper|\.top|\.cmp)$/i, 'copper-top'],
  [/(\.gbl|[-_.]B[_.]Cu\.\w+|[-_]bottom[-_]?copper|\.bot|\.sol)$/i, 'copper-bottom'],
  [/(\.gts|[-_.]F[_.]Mask\.\w+|[-_]top[-_]?(solder)?mask|\.smt|\.stc)$/i, 'mask-top'],
  [/(\.gbs|[-_.]B[_.]Mask\.\w+|[-_]bottom[-_]?(solder)?mask|\.smb|\.sts)$/i, 'mask-bottom'],
  [/(\.gto|[-_.]F[_.]Silk(S|screen)\.\w+|[-_]top[-_]?silk(screen)?|\.sst|\.plc)$/i, 'silk-top'],
  [/(\.gbo|[-_.]B[_.]Silk(S|screen)\.\w+|[-_]bottom[-_]?silk(screen)?|\.ssb|\.pls)$/i, 'silk-bottom'],
  [/(\.gko|\.gm1|\.gml|[-_.]Edge[_.]Cuts\.\w+|[-_]outline|[-_]profile|\.out|\.oln|\.bor)$/i, 'outline'],
  [/\.(drl|xln|exc|drd|txt)$/i, 'drill'],
];

/** A layer's role from its X2 file function, then its name. */
export function layerRole(name: string, attributes: Readonly<Record<string, string>> = {}, text = ''): LayerRole {
  const fn = attributes['.FileFunction'];
  if (fn !== undefined) {
    const [kind, a, b] = fn.split(',');
    if (kind === 'Copper') return b === 'Top' || a === 'Top' ? 'copper-top' : b === 'Bot' || a === 'Bot' ? 'copper-bottom' : 'ignored';
    if (kind === 'Soldermask') return a === 'Top' ? 'mask-top' : 'mask-bottom';
    if (kind === 'Legend') return a === 'Top' ? 'silk-top' : 'silk-bottom';
    if (kind === 'Profile') return 'outline';
    if (kind === 'Plated' || kind === 'NonPlated') return 'drill';
    return 'ignored';
  }
  for (const [pattern, role] of BY_NAME) {
    if (!pattern.test(name)) continue;
    if (role === 'drill' && !isExcellon(text)) return 'ignored';
    return role;
  }
  return isExcellon(text) ? 'drill' : 'ignored';
}

export interface GerberSet {
  layers: Partial<Record<Exclude<LayerRole, 'drill' | 'ignored'>, { file: string; plot: LayerPlot }>>;
  drills: Drill[];
  /** the X2 project name (`%TF.ProjectId,<name>,…%`), when the files carry one */
  project?: string;
  files: { file: string; role: LayerRole }[];
  warnings: string[];
}

export function readGerberSet(entries: readonly ZipEntry[]): GerberSet {
  const set: GerberSet = { layers: {}, drills: [], files: [], warnings: [] };
  const decoder = new TextDecoder();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const text = decoder.decode(entry.bytes);
    if (isExcellon(text)) {
      const role = layerRole(entry.name, {}, text);
      set.files.push({ file: entry.path, role: role === 'ignored' ? 'drill' : role });
      const parsed = parseExcellon(text);
      set.drills.push(...parsed.drills.map((d) => (d.plated === undefined && /npth|non[-_]?plated/i.test(entry.name) ? { ...d, plated: false } : d)));
      for (const w of parsed.warnings) set.warnings.push(`${entry.name}: ${w}`);
      continue;
    }
    if (!/%FS|%MO|G04|D0?[123]\*/.test(text.slice(0, 20000))) {
      set.files.push({ file: entry.path, role: 'ignored' });
      continue;
    }
    // a cheap look at the attributes before plotting the whole file
    const fn = /%TF\.FileFunction,([^*]*)\*%/.exec(text)?.[1];
    const role = layerRole(entry.name, fn === undefined ? {} : { '.FileFunction': fn }, text);
    set.files.push({ file: entry.path, role });
    const project = /%TF\.ProjectId,([^,*]*)/.exec(text)?.[1];
    if (project !== undefined && project !== '' && set.project === undefined) set.project = project;
    if (role === 'ignored' || role === 'drill') continue;
    if (set.layers[role] !== undefined) {
      set.warnings.push(`two files are the ${role} layer; ${set.layers[role]!.file} is used, ${entry.path} is not`);
      continue;
    }
    const plot = plotGerber(text);
    for (const w of plot.warnings) set.warnings.push(`${entry.name}: ${w}`);
    set.layers[role] = { file: entry.path, plot };
  }
  return set;
}

/** The board's outline loops from the outline layer (largest first), and the art frame. */
export function boardShape(set: GerberSet): { loops: Point[][]; frame?: BoardFrame } {
  const outline = set.layers.outline?.plot;
  const loops = outline === undefined ? [] : chainLoops(outline.strokes);
  if (loops[0] !== undefined) return { loops, frame: boundsOf(loops[0])! };
  const plots = Object.values(set.layers).map((l) => l.plot.bounds).filter((b): b is NonNullable<typeof b> => b !== undefined);
  if (plots.length === 0) return { loops };
  const x0 = Math.min(...plots.map((b) => b.x0));
  const y0 = Math.min(...plots.map((b) => b.y0));
  const x1 = Math.max(...plots.map((b) => b.x1));
  const y1 = Math.max(...plots.map((b) => b.y1));
  return { loops, frame: { x0, y0, width: x1 - x0, height: y1 - y0 } };
}

function maskOf(id: string, plot: LayerPlot, frame: BoardFrame, invert = false): string {
  const on = invert ? '#000' : '#fff';
  const off = invert ? '#fff' : '#000';
  const base = invert ? `<rect x="${n(frame.x0 - 1)}" y="${n(frame.y0 - 1)}" width="${n(frame.width + 2)}" height="${n(frame.height + 2)}" fill="#fff"/>` : '';
  const body = plot.elements.map((e) => e.svg.split(PAINT).join(e.dark ? on : off)).join('');
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="${n(frame.x0 - 1)}" y="${n(frame.y0 - 1)}" width="${n(frame.width + 2)}" height="${n(frame.height + 2)}">${base}${body}</mask>`;
}

function face(set: GerberSet, shape: { loops: Point[][]; frame: BoardFrame }, side: 'top' | 'bottom', defId: string): string {
  const { frame, loops } = shape;
  const p = `${idPrefix(defId)}-${side}`;
  const copper = set.layers[side === 'top' ? 'copper-top' : 'copper-bottom']?.plot;
  const mask = set.layers[side === 'top' ? 'mask-top' : 'mask-bottom']?.plot;
  const silk = set.layers[side === 'top' ? 'silk-top' : 'silk-bottom']?.plot;
  const board = loops.length > 0 ? loops.map((l) => loopPath(l)).join('') : `M${n(frame.x0)} ${n(frame.y0)}h${n(frame.width)}v${n(frame.height)}h${n(-frame.width)}Z`;
  const cover = `x="${n(frame.x0 - 1)}" y="${n(frame.y0 - 1)}" width="${n(frame.width + 2)}" height="${n(frame.height + 2)}"`;
  const defs: string[] = [`<clipPath id="${p}-clip"><path d="${board}" clip-rule="evenodd"/></clipPath>`];
  const layers: string[] = [`<path d="${board}" fill="${COLOURS.substrate}" fill-rule="evenodd"/>`];
  if (copper !== undefined) defs.push(maskOf(`${p}-cu`, copper, frame));
  if (mask !== undefined) {
    defs.push(maskOf(`${p}-open`, mask, frame));
    defs.push(maskOf(`${p}-cover`, mask, frame, true));
    if (copper !== undefined) layers.push(`<rect ${cover} fill="${COLOURS.copperUnderMask}" mask="url(#${p}-cu)"/>`);
    layers.push(`<rect ${cover} fill="${COLOURS.mask}" fill-opacity="0.85" mask="url(#${p}-cover)"/>`);
    if (copper !== undefined) layers.push(`<g mask="url(#${p}-open)"><rect ${cover} fill="${COLOURS.copper}" mask="url(#${p}-cu)"/></g>`);
  } else if (copper !== undefined) {
    layers.push(`<rect ${cover} fill="${COLOURS.copper}" mask="url(#${p}-cu)"/>`);
  }
  if (silk !== undefined) {
    defs.push(maskOf(`${p}-silk`, silk, frame));
    layers.push(`<rect ${cover} fill="${COLOURS.silk}" mask="url(#${p}-silk)"/>`);
  }
  const holes = set.drills
    .map((d) =>
      d.to === undefined
        ? `<circle cx="${n(d.x)}" cy="${n(d.y)}" r="${n(d.diameter / 2)}"/>`
        : `<path d="M${n(d.x)} ${n(d.y)}L${n(d.to.x)} ${n(d.to.y)}" fill="none" stroke="${COLOURS.hole}" stroke-width="${n(d.diameter)}" stroke-linecap="round"/>`,
    )
    .join('');
  if (holes !== '') layers.push(`<g fill="${COLOURS.hole}">${holes}</g>`);
  // the bottom is the board seen from below: reflected about x, in the same frame as the top
  const place = side === 'top' ? `translate(${n(-frame.x0)} ${n(-frame.y0)})` : `translate(${n(frame.width + frame.x0)} ${n(-frame.y0)}) scale(-1 1)`;
  return [svgOpen(frame.width, frame.height, `${defId} — ${side} (from the Gerber set)`), `<defs>${defs.join('')}</defs>`, `<g transform="${place}"><g clip-path="url(#${p}-clip)">${layers.join('')}</g></g>`, '</svg>', ''].join('\n');
}

/** Pads whose centre is on no copper flash of their face: the art and the board record disagree there. */
export function padsOffCopper(set: GerberSet, frame: BoardFrame, pads: ReadonlyMap<string, readonly TerminalPad[]>): string[] {
  const off: string[] = [];
  const tolerance = 0.05;
  for (const [terminal, list] of pads) {
    for (const pad of list) {
      const faces = pad.side === 'both' ? ['copper-top', 'copper-bottom'] : [pad.side === 'top' ? 'copper-top' : 'copper-bottom'];
      const x = pad.x + frame.x0;
      const y = pad.y + frame.y0;
      const hit = faces.some((f) => set.layers[f as 'copper-top']?.plot.flashes.some((fl) => Math.abs(fl.x - x) <= fl.hw + tolerance && Math.abs(fl.y - y) <= fl.hh + tolerance));
      const anyCopper = faces.some((f) => set.layers[f as 'copper-top'] !== undefined);
      if (anyCopper && !hit) off.push(`${terminal} (${pad.ref}${pad.pad === '' ? '' : ` pad ${pad.pad}`})`);
    }
  }
  return off;
}

export interface GerberDepictionResult {
  depiction: ImportedDepiction;
  notes: string[];
}

export function gerberDepiction(set: GerberSet, pcba: PcbaDefinition, citation: { path: string; sha256: string }): GerberDepictionResult {
  const notes: string[] = [];
  const shape = boardShape(set);
  if (shape.frame === undefined) throw new Error('The archive has no Gerber layer this module can draw (copper, mask, silkscreen or outline).');
  if (shape.loops.length === 0) notes.push('No closed board outline (profile / Edge.Cuts layer) was found: the art is framed on the copper, and anchors may be offset.');
  const frame = shape.frame;
  const drawn = Object.entries(set.layers)
    .map(([role, l]) => `${role} ${l.file}`)
    .sort();
  notes.push(`Layers drawn: ${drawn.join('; ') || 'none'}${set.drills.length > 0 ? `; ${set.drills.length} drilled hole(s)` : ''}.`);
  const ignored = set.files.filter((f) => f.role === 'ignored').map((f) => f.file);
  if (ignored.length > 0) notes.push(`Not drawn: ${ignored.join(', ')}.`);
  notes.push(...set.warnings);
  const pads = padsOfPcba(pcba);
  if (pads.size === 0) notes.push(`${pcba.id} has no pad positions, so the art has no anchors: import the board's .kicad_pcb first, then its Gerbers.`);
  const off = padsOffCopper(set, frame, pads);
  if (off.length > 0) notes.push(`${off.length} anchored pad(s) are not on a copper flash of their face — check the board record and the Gerbers are the same revision: ${off.slice(0, 8).join(', ')}${off.length > 8 ? ' …' : ''}.`);
  const full = { loops: shape.loops, frame };
  return {
    depiction: depiction({
      defId: pcba.id,
      width: frame.width,
      height: frame.height,
      top: face(set, full, 'top', pcba.id),
      bottom: face(set, full, 'bottom', pcba.id),
      sourceKind: 'gerber',
      anchors: anchorsOf(pads),
      sources: [{ role: 'gerber-zip', path: citation.path, sha256: citation.sha256 }],
      src: `Rendered by the board-import module from ${citation.path} (sha256 ${citation.sha256.slice(0, 16)}…); anchors from ${pcba.id}'s pad positions`,
      replaces: ['kicad', 'gerber'],
    }),
    notes,
  };
}
