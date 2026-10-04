/**
 * The cable cutaway at the top of the drawing sheet.
 *
 * A stock with supplied art (`CUTAWAY_ART`, `assets.ts`) uses it; every
 * other stock gets one *drawn from its element tree*: one core pulled out of the bundle and stepped down layer by layer
 * (conductor → insulation → shield → sheath), the bundle's cut face showing
 * the cores in their stated lay order and colours, the overall foil, and the
 * jacket with its printed marking — each layer called out with a red leader.
 *
 * It is a picture, not a dimensioned drawing: layer heights step evenly so
 * every layer can be seen and labelled, and the cut face places cores by lay
 * order, not to scale. The cross-section in the schematic is the scaled view.
 *
 * Grounding (specs/shield-bonding.md): an overall foil is trimmed back at
 * every end and never indicated, so it is drawn — it is the cable's real
 * construction — but not called out. A stock whose screens are one bonded
 * copper mass (every spiral core shield, the foil and the drain) has its
 * copper shielding called out once, as that mass, and each cut core shows its
 * copper screen.
 */

import { resolveElementPath, type ConductorElement, type Element, type GroupElement, type WireDefinition } from '@wirehub/model';

import { CUTAWAY_ART } from './assets.ts';
import { sans } from './fonts.generated.ts';

export interface Cutaway {
  /** SVG content in its own 0,0 → width,height frame (no outer `<svg>`) */
  body: string;
  width: number;
  height: number;
  /** `art` — supplied artwork; `drawn` — generated from the element tree */
  source: 'art' | 'drawn';
}

const WIDTH = 525;
const HEIGHT = 131;
const CY = 64;
const LEADER = '#e30613';
const FONT = "'CS Sans', Helvetica, Arial, sans-serif";

/** The jacket print drawn on a cutaway: the stock's part number, else its id, upper-cased. */
function markingText(wire: WireDefinition): string {
  return (wire.partNumber ?? wire.id).toUpperCase();
}

const SWATCH: Readonly<Record<string, string>> = {
  red: '#a30000',
  green: '#46a000',
  blue: '#0f33b7',
  yellow: '#e2b700',
  white: '#f4f4f4',
  black: '#1e1e1e',
  brown: '#5e4324',
  purple: '#6d2a8a',
  orange: '#e27000',
  natural: '#f2f2f2',
};

function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function metalColor(material: string | undefined): { fill: string; line: string } {
  const m = (material ?? '').toLowerCase();
  if (m.includes('tin') || m.includes('alumin') || m.includes('silver')) return { fill: '#d9d9d9', line: '#7a7a7a' };
  return { fill: '#d9905a', line: '#8a4a1f' };
}

function metalWord(material: string | undefined): string {
  const m = (material ?? '').toLowerCase();
  if (m.includes('tinned')) return 'Tinned Copper';
  if (m.includes('alumin')) return 'Aluminium';
  if (m.includes('copper')) return 'Copper';
  return titleCase(material ?? 'Metal');
}

function plasticWord(material: string | undefined): string {
  const m = (material ?? '').toLowerCase();
  if (m.includes('pe') && !m.includes('pvc')) return m.includes('fm') || m.includes('foam') ? 'Foamed Polyethylene' : 'Polyethylene';
  if (m.includes('pvc')) return 'PVC';
  return titleCase(material ?? 'Insulation');
}

interface Callout {
  x: number;
  /** the feature's edge the leader touches */
  y: number;
  lines: string[];
  above: boolean;
}

/** Rough 8 pt width of a label line, enough to keep two labels apart. */
function labelWidth(text: string): number {
  return text.length * 4.1;
}

function callout(c: Callout, textX: number): string {
  const labelY = c.above ? 12 : HEIGHT - 12 - (c.lines.length - 1) * 9.6;
  const tickY = labelY - 3;
  return [
    `<path d="M${n(c.x)} ${n(c.y)}V${n(tickY)}H${n(textX >= c.x ? textX - 2 : textX + labelWidth(c.lines[0] ?? '') + 2)}" fill="none" stroke="${LEADER}" stroke-width="0.75"/>`,
    ...c.lines.map((line, i) => `<text x="${n(textX)}" y="${n(labelY + i * 9.6)}" font-size="8" font-family="${esc(FONT)}">${esc(line)}</text>`),
  ].join('');
}

/** Lay the labels out left to right per row, sliding a crowded one along its tick. */
function callouts(list: Callout[]): string {
  const out: string[] = [];
  const edge = { above: -Infinity, below: -Infinity };
  for (const c of [...list].sort((x, y) => x.x - y.x)) {
    const row = c.above ? 'above' : 'below';
    const width = Math.max(...c.lines.map(labelWidth));
    // right of its leader and clear of the label before it — or, where that
    // would leave the frame, flipped to the leader's left
    const rightOf = Math.max(c.x + 6, edge[row] + 8);
    const textX = rightOf + width > WIDTH - 2 ? c.x - 6 - width : rightOf;
    edge[row] = textX + width;
    out.push(callout(c, textX));
  }
  return out.join('');
}

/** The first core group of the stock — the one pulled out and stepped down. */
function representativeCore(root: GroupElement, wire: WireDefinition): GroupElement | undefined {
  // red when there is one, as the owner's art shows it; else the first laid
  const red = resolveElementPath(root, 'core-red');
  if (red?.kind === 'group') return red;
  const first = wire.layOrder?.ring[0];
  const named = first === undefined ? undefined : resolveElementPath(root, first);
  if (named?.kind === 'group') return named;
  return root.children.find((child): child is GroupElement => child.kind === 'group');
}

function coreColor(element: Element | undefined): string {
  if (element === undefined) return '#888888';
  if (element.kind === 'conductor') return SWATCH[element.color ?? ''] ?? '#888888';
  if (element.kind === 'group') {
    for (const child of element.children) {
      if ((child.kind === 'conductor' || child.kind === 'insulation') && child.color !== undefined) {
        return SWATCH[child.color] ?? '#888888';
      }
    }
  }
  return '#888888';
}

/** Mix a hex colour towards white — the lit cut face of a layer. */
function tint(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) return hex;
  return `#${[m[1], m[2], m[3]]
    .map((c) => Math.round(parseInt(c!, 16) + (255 - parseInt(c!, 16)) * amount).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Every screen inside a core group — `core-red.shield` — the paths a bonded set names. */
function coreShieldPaths(root: GroupElement): string[] {
  const out: string[] = [];
  for (const child of root.children) {
    if (child.kind !== 'group') continue;
    for (const inner of child.children) if (inner.kind === 'shield') out.push(`${child.id}.${inner.id}`);
  }
  return out;
}

/** The stock's core screens are all one bonded set: one copper mass for the whole length. */
function oneCopperMass(wire: WireDefinition): boolean {
  const shields = coreShieldPaths(wire.structure);
  return shields.length > 1 && (wire.bonded ?? []).some((set) => shields.every((path) => set.members.includes(path)));
}

function outerOd(element: Element | undefined): number | undefined {
  if (element === undefined) return undefined;
  if (element.kind === 'group') {
    let od: number | undefined;
    for (const child of element.children) {
      const inner = outerOd(child);
      if (inner !== undefined) od = Math.max(od ?? 0, inner);
    }
    return od;
  }
  if (element.kind === 'conductor') return element.insulatedOdMm ?? element.odMm;
  return element.odMm;
}

/**
 * Draw a cutaway for any stock from its element tree, in the geometry of the
 * owner's hand-drawn coax: the bundle's cut face is an ellipse at the end of
 * the foil sleeve showing every core at its lay position; one core — red where
 * there is one — leaves that face *at its own position*, rotated to 12
 * o'clock, and is stepped down layer by layer, each layer ending in a small
 * elliptical cut face with the next one coming out of its middle.
 *
 * Diameters are the stock's own (`odMm`), scaled so the jacket is 70 pt tall;
 * only the conductor gets a floor so it stays visible. Lengths along the cable
 * are schematic, as in the owner's art.
 */
export function drawCutaway(wire: WireDefinition): Cutaway {
  if (wire.layOrder?.arrangement === 'figure-8') return drawFigure8Cutaway(wire);
  const root = wire.structure;
  const out: string[] = [];
  const labels: Callout[] = [];

  const overall = root.children.find((c) => c.kind === 'shield');
  const jacket = root.children.find((c) => c.kind === 'insulation');
  const jacketOd = jacket?.kind === 'insulation' && jacket.odMm !== undefined ? jacket.odMm : (wire.odMm ?? 8);
  const jacketH = 70;
  const s = jacketH / jacketOd;
  const foilOd = overall?.kind === 'shield' && overall.odMm !== undefined ? overall.odMm : jacketOd * 0.88;
  const foilR = (foilOd / 2) * s;

  // --- the lay: which cores sit where on the cut face ----------------------
  const core = representativeCore(root, wire);
  const corePath = core === undefined ? undefined : root.children.includes(core) ? core.id : undefined;
  let ring = wire.layOrder?.ring ?? root.children.filter((c) => c.kind === 'group').map((c) => c.id);
  const direction = wire.layOrder?.direction === 'cw' ? 1 : -1;
  // rotate the ring so the pulled-out core sits at 12 o'clock
  const at = corePath === undefined ? -1 : ring.indexOf(corePath);
  if (at > 0) ring = [...ring.slice(at), ...ring.slice(0, at)];
  const centre = [
    ...(wire.layOrder?.center === undefined ? [] : [wire.layOrder.center]),
    ...(wire.layOrder?.inner ?? []),
  ];
  const ringOd = Math.max(...ring.map((path) => outerOd(resolveElementPath(root, path)) ?? 1));
  const pitch = Math.max((ringOd / 2) / Math.sin(Math.PI / Math.max(3, ring.length)), ringOd / 2 + 0.3);

  // --- geometry along the cable ---------------------------------------------
  const faceX = 214;
  const jacketX = 338;
  const right = WIDTH - 2;
  const squash = 0.6; // how edge-on the cut faces are seen
  const coreY = CY - pitch * s;

  // --- the jacket, then the foil sleeve over its cut face ------------------
  out.push(
    `<path d="M${n(jacketX)} ${n(CY - jacketH / 2)}H${n(right - jacketH / 2)}A${n(jacketH / 2)} ${n(jacketH / 2)} 0 0 1 ${n(right - jacketH / 2)} ${n(CY + jacketH / 2)}H${n(jacketX)}Z" fill="#171717" stroke="#000" stroke-width="0.6"/>`,
  );
  const jr = jacketH / 2;
  const jrx = jr * squash * 0.62;
  const radial: string[] = [];
  for (let i = 0; i < 90; i += 1) {
    const t = (2 * Math.PI * i) / 90;
    radial.push(`M${n(jacketX + Math.cos(t) * jrx * (foilR / jr))} ${n(CY + Math.sin(t) * foilR)}L${n(jacketX + Math.cos(t) * jrx)} ${n(CY + Math.sin(t) * jr)}`);
  }
  out.push(`<ellipse cx="${n(jacketX)}" cy="${n(CY)}" rx="${n(jrx)}" ry="${n(jr)}" fill="#5c5c5c" stroke="#000" stroke-width="0.6"/>`);
  out.push(`<path d="${radial.join('')}" stroke="#8d8d8d" stroke-width="0.35"/>`);

  const foil = metalColor(overall?.kind === 'shield' ? overall.material : 'aluminium');
  const frx = foilR * squash;
  // sleeve: from the cut face to a rounded end tucked into the jacket face
  out.push(
    `<path d="M${n(faceX)} ${n(CY - foilR)}H${n(jacketX)}A${n(frx * 0.7)} ${n(foilR)} 0 0 1 ${n(jacketX)} ${n(CY + foilR)}H${n(faceX)}Z" fill="#c4c4c4" stroke="#000" stroke-width="0.6"/>`,
  );
  // a foil/tape overall screen is trimmed back and never indicated (the owner,
  // specs/shield-bonding.md §7): drawn, not called out. A braided overall
  // screen is copper that lands, and is.
  if (overall?.kind === 'shield' && overall.construction !== 'foil' && overall.construction !== 'tape') {
    labels.push({ x: faceX + 30, y: CY - foilR, lines: [`Outer ${metalWord(overall.material)} ${titleCase(overall.construction)} Shield`], above: true });
  }
  const mass = oneCopperMass(wire);

  // --- the cut face ---------------------------------------------------------
  out.push(`<ellipse cx="${n(faceX)}" cy="${n(CY)}" rx="${n(frx)}" ry="${n(foilR)}" fill="#ffffff" stroke="#000" stroke-width="0.8"/>`);
  const faceCore = (path: string, cx: number, cy: number): void => {
    const element = resolveElementPath(root, path);
    // seen at the same angle as the face they sit in
    const r = ((outerOd(element) ?? 1) / 2) * s * 0.94;
    const screen = element?.kind === 'group' ? element.children.find((c) => c.kind === 'shield') : undefined;
    if (screen?.kind === 'shield') {
      // the core's own copper screen round its insulation
      const copper = metalColor(screen.material);
      out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r * squash)}" ry="${n(r)}" fill="${copper.fill}" stroke="#000" stroke-width="0.5"/>`);
      const ri = r * 0.78;
      out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(ri * squash)}" ry="${n(ri)}" fill="${coreColor(element)}" stroke="${copper.line}" stroke-width="0.3"/>`);
    } else {
      out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r * squash)}" ry="${n(r)}" fill="${coreColor(element)}" stroke="#000" stroke-width="0.5"/>`);
    }
    // the conductor at its centre, so each cut core reads as a wire
    const c = Math.max(0.9, r * 0.28);
    out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(c * squash)}" ry="${n(c)}" fill="#d9905a" stroke="#000" stroke-width="0.3"/>`);
  };
  ring.forEach((path, index) => {
    if (index === 0 && at >= 0) return; // this one is pulled out, below
    const t = -Math.PI / 2 + (direction * 2 * Math.PI * index) / ring.length;
    faceCore(path, faceX + Math.cos(t) * pitch * s * squash, CY + Math.sin(t) * pitch * s);
  });
  const innerOd = Math.max(0.5, ...centre.map((path) => outerOd(resolveElementPath(root, path)) ?? 0.5));
  centre.forEach((path, index) => {
    const dy = (index - (centre.length - 1) / 2) * innerOd * s;
    faceCore(path, faceX, CY + dy);
  });
  const drain = root.children.find((c): c is ConductorElement => c.kind === 'conductor' && c.bare === true);
  if (drain !== undefined) {
    const t = -Math.PI / 2 + (direction * Math.PI) / ring.length;
    const r = pitch * s * 0.62;
    out.push(`<circle cx="${n(faceX + Math.cos(t) * r * squash)}" cy="${n(CY + Math.sin(t) * r)}" r="${n(Math.max(1.2, ((drain.odMm ?? 0.4) / 2) * s))}" fill="#c9c9c9" stroke="#000" stroke-width="0.4"/>`);
  }

  // --- the pulled-out core, outermost layer first ---------------------------
  const layers = [...(core?.children ?? [])].filter((l) => l.kind !== 'group');
  const count = layers.length;
  const tipX = 6;
  const seg = count > 0 ? (faceX - frx - tipX) / (count + 0.2) : 0;
  const clipId = `ra-cut-face-${wire.id}`;
  // the outer layer runs up to the rim of the cut face, as in the owner's art
  out.push(
    `<clipPath id="${esc(clipId)}"><rect x="0" y="0" width="${n(faceX)}" height="${HEIGHT}"/><ellipse cx="${n(faceX)}" cy="${n(CY)}" rx="${n(frx)}" ry="${n(foilR)}"/></clipPath>`,
  );
  for (let i = count - 1; i >= 0; i -= 1) {
    const layer = layers[i]!;
    const x = tipX + i * seg;
    const end = i === count - 1 ? faceX + frx : tipX + (i + 1) * seg + 1;
    const od = Math.max(i === 0 ? 2.6 : 0, (outerOd(layer) ?? 0.5) * s);
    const h = od;
    const top = coreY - h / 2;
    const capRx = Math.max(0.8, h * 0.16);
    let fill = '#cccccc';
    let label: string[] = [];
    const lower = (count - 1 - i) % 2 === 1;
    if (layer.kind === 'conductor') {
      fill = metalColor(layer.material).fill;
      label = [`${metalWord(layer.material)} Conductor`];
    } else if (layer.kind === 'insulation') {
      fill = SWATCH[layer.color ?? ''] ?? SWATCH.natural!;
      const word = plasticWord(layer.material);
      label = /dielectric/i.test(layer.label ?? layer.id) ? [word, 'Dielectric'] : [`${word} Insulation`, '(See Remark 2)'];
    } else if (layer.kind === 'shield') {
      fill = metalColor(layer.material).fill;
      const kind = layer.construction === 'spiral' ? 'Spiral' : layer.construction === 'braid' ? 'Braided' : titleCase(layer.construction);
      // one bonded mass: all of the shielding indicated together
      label = mass ? [`${kind} ${metalWord(layer.material)} Shields`, '(All Bonded: One Copper Mass)'] : [`${kind} ${metalWord(layer.material)} Shield`];
    }
    const body = `<path d="M${n(x)} ${n(top)}H${n(end)}V${n(top + h)}H${n(x)}Z" fill="${fill}" stroke="#000" stroke-width="0.6"${i === count - 1 ? ` clip-path="url(#${esc(clipId)})"` : ''}/>`;
    out.push(body);
    if (layer.kind === 'shield') {
      const hatch = `ra-cut-hatch-${wire.id}-${i}`;
      const strands: string[] = [];
      for (let sx = x - h; sx < end; sx += 1.5) strands.push(`M${n(sx)} ${n(top + h)}L${n(sx + h * 0.7)} ${n(top)}`);
      out.push(`<clipPath id="${esc(hatch)}"><rect x="${n(x)}" y="${n(top)}" width="${n(end - x)}" height="${n(h)}"/></clipPath>`);
      out.push(`<path d="${strands.join('')}" stroke="${metalColor(layer.material).line}" stroke-width="0.4" clip-path="url(#${esc(hatch)})"/>`);
    }
    if (layer.kind === 'conductor') {
      // strands
      const lines: string[] = [];
      for (let k = 1; k < 4; k += 1) lines.push(`M${n(x)} ${n(top + (h * k) / 4)}H${n(end)}`);
      out.push(`<path d="${lines.join('')}" stroke="#8a4a1f" stroke-width="0.3"/>`);
    }
    // the cut face at this layer's left end: the next layer comes out of it
    out.push(`<ellipse cx="${n(x)}" cy="${n(coreY)}" rx="${n(capRx)}" ry="${n(h / 2)}" fill="${tint(fill, 0.35)}" stroke="#000" stroke-width="0.6"/>`);
    labels.push({ x: x + seg * 0.35, y: lower ? top + h : top, lines: label, above: !lower });
  }

  // --- the jacket marking -----------------------------------------------------
  // sized from the face's own advance widths to sit inside the jacket
  const markLeft = jacketX + jrx + 14;
  const markRight = right - jr * 0.45;
  const unit = [...markingText(wire)].reduce((sum, ch) => sum + (sans.widths[ch] ?? 600), 0) / 1000;
  const markSize = Math.min(20, (markRight - markLeft) / unit);
  const markX = (markLeft + markRight) / 2;
  out.push(
    `<text x="${n(markX)}" y="${n(CY + markSize * 0.36)}" font-size="${n(markSize)}" fill="#ffffff" text-anchor="middle" font-family="${esc(FONT)}">${esc(markingText(wire))}</text>`,
  );
  if (jacket?.kind === 'insulation') {
    const matte = /matte/i.test(`${jacket.material ?? ''} ${jacket.label ?? ''}`) ? 'Matte' : 'Flat';
    labels.push({ x: jacketX + jrx + 18, y: CY + jacketH / 2, lines: [`Jacket ${matte} Black ${plasticWord(jacket.material)}`], above: false });
  }
  labels.push({ x: markLeft + 12, y: CY - markSize * 0.45, lines: ['Jacket Marking'], above: true });

  const body = [...out, callouts(labels)].join('');
  return { body, width: WIDTH, height: HEIGHT, source: 'drawn' };
}

/**
 * A figure-8 lead seen from the side: no round jacket,
 * no overall sleeve — two black-jacketed legs moulded side by side with a web
 * between them. The first leg peels away from the web and is stepped down
 * layer by layer (black jacket → copper shield → coloured insulation →
 * conductor); the other leg's cut face shows its own layers. Scaled so the
 * pair's **width** (the larger dimension, `odMm`) is 70 pt, as the round
 * stocks' Ø is.
 */
function drawFigure8Cutaway(wire: WireDefinition): Cutaway {
  const root = wire.structure;
  const out: string[] = [];
  const labels: Callout[] = [];
  const legs = (wire.layOrder?.ring ?? [])
    .map((path) => resolveElementPath(root, path))
    .filter((leg): leg is GroupElement => leg?.kind === 'group');
  const legOd = wire.profile?.legOdMm ?? Math.max(1, ...legs.map((leg) => outerOd(leg) ?? 1));
  const pitchMm = wire.profile?.pitchMm ?? legOd;
  const webMm = wire.profile?.webMm ?? legOd * 0.6;
  const s = 70 / (wire.profile?.widthMm ?? wire.odMm ?? pitchMm + legOd);
  const legH = legOd * s;
  const topY = CY - (pitchMm * s) / 2;
  const bottomY = CY + (pitchMm * s) / 2;
  const jacketX = 250;
  const right = WIDTH - 2;
  const squash = 0.6;
  const black = '#171717';
  const webH = webMm * s;

  // the web, then both legs' jackets running off to the right
  out.push(`<rect x="${n(jacketX)}" y="${n(CY - webH / 2)}" width="${n(right - legH / 2 - jacketX)}" height="${n(webH)}" fill="${black}"/>`);
  for (const y of [topY, bottomY]) {
    out.push(
      `<path d="M${n(jacketX)} ${n(y - legH / 2)}H${n(right - legH / 2)}A${n(legH / 2)} ${n(legH / 2)} 0 0 1 ${n(right - legH / 2)} ${n(y + legH / 2)}H${n(jacketX)}Z" fill="${black}" stroke="#000" stroke-width="0.6"/>`,
    );
  }

  // the second leg's cut face: its own layers, outermost first
  const other = legs[1];
  if (other !== undefined) {
    const layers = other.children.filter((l) => l.kind !== 'group').map((l) => ({ layer: l, od: outerOd(l) ?? 0.5 }));
    for (const { layer, od } of [...layers].sort((a, b) => b.od - a.od)) {
      const r = (od / 2) * s;
      const fill =
        layer.kind === 'insulation'
          ? layer.color === 'black'
            ? '#3a3a3a'
            : (SWATCH[layer.color ?? ''] ?? SWATCH.natural!)
          : metalColor(layer.kind === 'shield' || layer.kind === 'conductor' ? layer.material : undefined).fill;
      out.push(`<ellipse cx="${n(jacketX)}" cy="${n(bottomY)}" rx="${n(Math.max(0.6, r * squash))}" ry="${n(Math.max(0.9, r))}" fill="${fill}" stroke="#000" stroke-width="0.5"/>`);
    }
  }

  // the first leg, peeled off the web and stepped down
  const leg = legs[0];
  const layers = [...(leg?.children ?? [])].filter((l) => l.kind !== 'group');
  const count = layers.length;
  const tipX = 6;
  const seg = count > 0 ? (jacketX - tipX) / (count + 0.2) : 0;
  for (let i = count - 1; i >= 0; i -= 1) {
    const layer = layers[i]!;
    const x = tipX + i * seg;
    const end = i === count - 1 ? jacketX : tipX + (i + 1) * seg + 1;
    const h = Math.max(i === 0 ? 2.6 : 0, (outerOd(layer) ?? 0.5) * s);
    const top = topY - h / 2;
    let fill = '#cccccc';
    let label: string[] = [];
    const lower = (count - 1 - i) % 2 === 1;
    if (layer.kind === 'conductor') {
      fill = metalColor(layer.material).fill;
      label = [`${metalWord(layer.material)} Conductor`];
    } else if (layer.kind === 'insulation') {
      const jacketLayer = layer.color === 'black' && i === count - 1;
      fill = jacketLayer ? black : (SWATCH[layer.color ?? ''] ?? SWATCH.natural!);
      label = jacketLayer
        ? [`Leg Jacket Black ${plasticWord(layer.material)}`, '(Two Legs Moulded Together)']
        : [`${plasticWord(layer.material)} Insulation`, `(${titleCase(layer.color ?? 'natural')} / Other Leg ${titleCase(other?.children.find((c) => c.kind === 'insulation')?.color ?? '')})`];
    } else if (layer.kind === 'shield') {
      fill = metalColor(layer.material).fill;
      const kind = layer.construction === 'spiral' ? 'Spiral' : layer.construction === 'braid' ? 'Braided' : titleCase(layer.construction);
      label = [`${kind} ${metalWord(layer.material)} Shield`, '(Each Leg Its Own)'];
    }
    out.push(`<path d="M${n(x)} ${n(top)}H${n(end)}V${n(top + h)}H${n(x)}Z" fill="${fill}" stroke="#000" stroke-width="0.6"/>`);
    if (layer.kind === 'shield') {
      const strands: string[] = [];
      for (let sx = x; sx + h * 0.7 < end; sx += 1.5) strands.push(`M${n(sx)} ${n(top + h)}L${n(sx + h * 0.7)} ${n(top)}`);
      out.push(`<path d="${strands.join('')}" stroke="${metalColor(layer.material).line}" stroke-width="0.4"/>`);
    }
    out.push(`<ellipse cx="${n(x)}" cy="${n(topY)}" rx="${n(Math.max(0.8, h * 0.16))}" ry="${n(h / 2)}" fill="${tint(fill, 0.35)}" stroke="#000" stroke-width="0.6"/>`);
    labels.push({ x: x + seg * 0.35, y: lower ? top + h : top, lines: label, above: !lower });
  }
  labels.push({ x: jacketX + 30, y: CY + webH / 2, lines: ['Web Joining the Two Legs (Figure-8)'], above: false });

  // the marking, on the lower leg
  const markLeft = jacketX + 24;
  const markRight = right - legH;
  const unit = [...markingText(wire)].reduce((sum, ch) => sum + (sans.widths[ch] ?? 600), 0) / 1000;
  const markSize = Math.min(legH * 0.62, (markRight - markLeft) / unit);
  out.push(
    `<text x="${n((markLeft + markRight) / 2)}" y="${n(bottomY + markSize * 0.36)}" font-size="${n(markSize)}" fill="#ffffff" text-anchor="middle" font-family="${esc(FONT)}">${esc(markingText(wire))}</text>`,
  );

  return { body: [...out, callouts(labels)].join(''), width: WIDTH, height: HEIGHT, source: 'drawn' };
}

/** Whether supplied art exists for this stock. */
export function hasCutawayArt(wire: WireDefinition): boolean {
  return CUTAWAY_ART[wire.id] !== undefined;
}

/**
 * Supplied art where there is some (unless `style` asks for the generated
 * one), a cutaway drawn from the element tree for everything else.
 */
export function cutawayFor(wire: WireDefinition, style: 'art' | 'drawn' = 'art'): Cutaway {
  const art = CUTAWAY_ART[wire.id];
  if (style === 'art' && art !== undefined) {
    const body = art.svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    return { body, width: art.width, height: art.height, source: 'art' };
  }
  return drawCutaway(wire);
}
