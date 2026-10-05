/**
 * Generates the starter connector face art: simple, original, monochrome SVG
 * mating faces (and their mirrored solder-side views) with a pin anchor per
 * position, plus one cutaway illustration. Every file is CC0-1.0 and says in
 * its `src` that it was drawn for WireHub from public dimensions; nothing is
 * traced from a vendor drawing.
 *
 *   node packages/catalog/scripts/face-art.ts          # rewrite the files
 *   node packages/catalog/scripts/face-art.ts --check  # exit 1 when a file differs
 *
 * `faceArtFiles()` returns every file (repo-relative path → text); the test
 * `test/face-art.test.ts` holds the committed files to it and the anchors to
 * the catalogs' pinouts.
 *
 * Geometry is millimetres, +x right, +y down, the mating face seen head-on.
 * Where a pin layout is inferred rather than read from a standard or a
 * manufacturer drawing it is flagged in the `src` text.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const r = (v: number): number => Math.round(v * 100) / 100;

type Item =
  | { t: 'poly'; pts: [number, number][] }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number }
  | { t: 'circle'; x: number; y: number; r: number }
  | { t: 'pin'; id: string; shape: 'circle' | 'rect'; x: number; y: number; r?: number; w?: number; h?: number }
  | { t: 'text'; x: number; y: number; text: string; size?: number };

interface Face {
  /** depiction directory: a connector body id (or wire id) */
  id: string;
  /** where it is written, repo-relative root */
  root: string;
  title: string;
  w: number;
  h: number;
  items: Item[];
  /** anchors for positions that have no drawn pin element (a shell contact) */
  extraAnchors?: Record<string, [number, number]>;
  src: string;
  /** line weight, default 0.15 mm */
  stroke?: number;
}

const CC0 = 'Drawn for WireHub from public dimensions; CC0-1.0, not traced from any vendor drawing.';

/* --- rendering ---------------------------------------------------- */

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function render(item: Item, fx: (x: number) => number, flip: boolean): string {
  switch (item.t) {
    case 'poly':
      return `<path d="${item.pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r(fx(x))} ${r(y)}`).join(' ')} Z"/>`;
    case 'rect': {
      const x = flip ? fx(item.x + item.w) : item.x;
      return `<rect x="${r(x)}" y="${r(item.y)}" width="${r(item.w)}" height="${r(item.h)}"${item.rx === undefined ? '' : ` rx="${r(item.rx)}"`}/>`;
    }
    case 'circle':
      return `<circle cx="${r(fx(item.x))}" cy="${r(item.y)}" r="${r(item.r)}"/>`;
    case 'pin':
      return item.shape === 'circle'
        ? `<circle data-pin="${esc(item.id)}" cx="${r(fx(item.x))}" cy="${r(item.y)}" r="${r(item.r ?? 0.6)}"/>`
        : `<rect data-pin="${esc(item.id)}" x="${r(fx(item.x) - (item.w ?? 1) / 2)}" y="${r(item.y - (item.h ?? 1) / 2)}" width="${r(item.w ?? 1)}" height="${r(item.h ?? 1)}"/>`;
    case 'text':
      return `<text x="${r(fx(item.x))}" y="${r(item.y)}" font-size="${item.size ?? 1.3}" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">${esc(item.text)}</text>`;
  }
}

function svg(face: Face, side: 'mating-face' | 'solder-side'): string {
  const flip = side === 'solder-side';
  const fx = (x: number): number => (flip ? face.w - x : x);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${face.w} ${face.h}" width="${face.w}mm" height="${face.h}mm">`,
    `  <title>${esc(face.title)} — ${side === 'mating-face' ? 'mating face' : 'solder side'}</title>`,
    `  <desc>${esc(CC0)}</desc>`,
    `  <g fill="none" stroke="currentColor" stroke-width="${face.stroke ?? 0.15}" stroke-linecap="round" stroke-linejoin="round">`,
    ...face.items.map((item) => `    ${render(item, fx, flip)}`),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

function meta(face: Face): string {
  const anchors: Record<string, { x: number; y: number }> = {};
  for (const item of face.items) if (item.t === 'pin') anchors[item.id] = { x: r(item.x), y: r(item.y) };
  for (const [id, [x, y]] of Object.entries(face.extraAnchors ?? {})) anchors[id] = { x: r(x), y: r(y) };
  const sorted = Object.fromEntries(Object.entries(anchors).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  const asset = (file: string, extra: object = {}): object => ({ file, kind: 'vector', mmPerUnit: 1, sourceKind: 'hand', widthUnits: face.w, heightUnits: face.h, src: `${face.src} ${CC0}`, ...extra });
  return `${JSON.stringify(
    {
      defId: face.id,
      views: {
        'mating-face': asset('mating-face.svg'),
        'solder-side': asset('solder-side.svg', { mirrorOf: 'mating-face', mirrorAxis: 'x' }),
      },
      pinAnchors: sorted,
      anchorFrame: 'mating-face',
      src: `${face.src} ${CC0}`,
    },
    null,
    2,
  )}\n`;
}

/* --- shapes ------------------------------------------------------- */

/** An inset copy of a trapezoid-ish polygon is overkill; faces use two nested polys instead. */
function dsubDE9(id: string, male: boolean): Face {
  const w = 32;
  const h = 13.5;
  const cx = w / 2;
  const cy = h / 2;
  const items: Item[] = [{ t: 'rect', x: 0.5, y: 0.5, w: 31, h: 12.5, rx: 1.2 }];
  items.push({ t: 'circle', x: cx - 12.495, y: cy, r: 1.6 }, { t: 'circle', x: cx + 12.495, y: cy, r: 1.6 });
  const top = 8.14;
  const bot = 6.83;
  const half = 3.72;
  items.push({ t: 'poly', pts: [[cx - top, cy - half], [cx + top, cy - half], [cx + bot, cy + half], [cx - bot, cy + half]] });
  const i = 0.7;
  items.push({ t: 'poly', pts: [[cx - top + i, cy - half + i], [cx + top - i, cy - half + i], [cx + bot - i * 0.8, cy + half - i], [cx - bot + i * 0.8, cy + half - i]] });
  const sign = male ? 1 : -1;
  const pitch = 2.77;
  const pr = male ? 0.55 : 0.75;
  for (let n = 0; n < 5; n += 1) items.push({ t: 'pin', id: String(n + 1), shape: 'circle', x: cx + sign * (n - 2) * pitch, y: cy - 1.42, r: pr });
  for (let n = 0; n < 4; n += 1) items.push({ t: 'pin', id: String(n + 6), shape: 'circle', x: cx + sign * (n - 1.5) * pitch, y: cy + 1.42, r: pr });
  for (const [label, x, y] of [['1', cx - sign * 5.54, cy - half - 0.6], ['5', cx + sign * 5.54, cy - half - 0.6], ['6', cx - sign * 4.155, cy + half + 1.5], ['9', cx + sign * 4.155, cy + half + 1.5]] as const) {
    items.push({ t: 'text', x, y, text: label });
  }
  return { id, root: 'packages/catalog/depictions', title: `DE-9 ${male ? 'male' : 'female'}`, w, h, items, extraAnchors: { shell: [cx - 12.495, cy] }, src: `D-subminiature DE-9 ${male ? 'plug' : 'socket'} mating face (IEC 60807-3 contact layout: five contacts on the wide row, 2.77 mm pitch, 2.84 mm row gap; numbering 1-5 then 6-9).` };
}

function jstXh2(): Face {
  const w = 10;
  const h = 8.5;
  const items: Item[] = [
    { t: 'rect', x: 1.3, y: 1.2, w: 7.4, h: 5.8, rx: 0.4 },
    { t: 'rect', x: 1.9, y: 1.9, w: 6.2, h: 4.4, rx: 0.3 },
    { t: 'poly', pts: [[1.3, 1.2], [2.6, 1.2], [1.3, 2.5]] },
    { t: 'pin', id: '1', shape: 'rect', x: 3.75, y: 4.1, w: 1, h: 1 },
    { t: 'pin', id: '2', shape: 'rect', x: 6.25, y: 4.1, w: 1, h: 1 },
    { t: 'text', x: 3.75, y: 7.9, text: '1' },
    { t: 'text', x: 6.25, y: 7.9, text: '2' },
  ];
  return { id: 'jst-xh-2', root: 'packages/catalog/depictions', title: 'Two-position 2.5 mm wire-to-board housing', w, h, items, src: '2-position, 2.5 mm pitch wire-to-board housing mating face; outline approximated from the family\'s published dimensions (inferred, approximate), position 1 at the chamfered corner.' };
}

function terminalBlock4(): Face {
  const pitch = 5.08;
  const w = 4 * pitch + 2;
  const h = 12;
  const items: Item[] = [{ t: 'rect', x: 1, y: 1, w: 4 * pitch, h: 9, rx: 0.5 }];
  for (let n = 0; n < 4; n += 1) {
    const x = 1 + pitch * (n + 0.5);
    items.push({ t: 'rect', x: x - 1.8, y: 4.6, w: 3.6, h: 3.6, rx: 0.4 }, { t: 'circle', x, y: 2.9, r: 1.3 }, { t: 'pin', id: String(n + 1), shape: 'circle', x, y: 6.4, r: 0.9 }, { t: 'text', x, y: 11.4, text: String(n + 1) });
  }
  return { id: 'terminal-block-4', root: 'packages/catalog/depictions', title: '4-way 5.08 mm screw terminal block', w, h, items, src: '4-way screw terminal block, 5.08 mm pitch: screw heads above, wire entries below (approximate generic outline); positions numbered left to right.' };
}

function rj45(): Face {
  const w = 14;
  const h = 18;
  const items: Item[] = [
    { t: 'rect', x: 1.15, y: 1, w: 11.7, h: 16, rx: 0.8 },
    { t: 'poly', pts: [[3.3, 17], [3.3, 12.5], [10.7, 12.5], [10.7, 17]] },
  ];
  for (let n = 0; n < 8; n += 1) items.push({ t: 'pin', id: String(n + 1), shape: 'rect', x: 7 + (n - 3.5) * 1.02, y: 5, w: 0.6, h: 5 });
  for (const n of [1, 8]) items.push({ t: 'text', x: 7 + (n === 1 ? -3.57 : 3.57), y: 0.7, text: String(n) });
  return { id: 'rj45-8p8c-plug', root: 'modules/networking/pack/depictions', title: 'RJ45 (8P8C) plug', w, h, items, extraAnchors: { shell: [7, 14.8] }, src: '8P8C modular plug (IEC 60603-7): contacts facing the viewer, latch down, eight contacts at 1.02 mm pitch numbered 1-8 left to right; plan view, approximate outline.' };
}

function xlr(male: boolean): Face {
  const w = 24;
  const h = 24;
  const c = 12;
  // latch (key) at the top, as in the manufacturer drawings: contacts 1 and 2 on the horizontal centre line, 3 below.
  // A socket numbers them the other way round (2 left, 1 right) from a plug (1 left, 2 right).
  const items: Item[] = [{ t: 'circle', x: c, y: c, r: 11 }, { t: 'circle', x: c, y: c, r: male ? 9 : 9.6 }, { t: 'rect', x: c - 1.2, y: 1.3, w: 2.4, h: 2.4, rx: 0.4 }];
  const pos: [string, number, number][] = [
    [male ? '1' : '2', c - 4, c],
    [male ? '2' : '1', c + 4, c],
    ['3', c, c + 3.9],
  ];
  for (const [id, x, y] of pos) items.push({ t: 'pin', id, shape: 'circle', x, y, r: male ? 0.8 : 1.2 });
  return {
    id: male ? 'xlr3-male' : 'xlr3-female',
    root: 'modules/pro-audio/pack/depictions',
    title: `XLR3 ${male ? 'male' : 'female'}`,
    w,
    h,
    items,
    extraAnchors: { shell: [c, 2.5] },
    src: male
      ? '3-pin XLR plug mating face (IEC 61076-2-103 interface), latch at the top: contact 1 left, 2 right, 3 below, as in the Neutrik NC3MDL-1 front view (drawing 3102 St 10 16); contact spacing (about 8 mm across, 3.9 mm down) scaled from that drawing, approximate outline.'
      : '3-pin XLR socket mating face (IEC 61076-2-103 interface), latch at the top: contact 2 left, 1 right, 3 below, as in the Neutrik NC3FXX front view (drawing ST-NC3FXX); contact spacing (about 8 mm across, 3.9 mm down) taken from the plug drawing NC3MDL-1 (drawing 3102 St 10 16) and mirrored, approximate outline.',
  };
}

function rcaEnd(): Face {
  const w = 14;
  const items: Item[] = [{ t: 'circle', x: 7, y: 7, r: 6 }, { t: 'circle', x: 7, y: 7, r: 4.4 }, { t: 'pin', id: 'tip', shape: 'circle', x: 7, y: 7, r: 1.4 }, { t: 'pin', id: 'sleeve', shape: 'circle', x: 12.2, y: 7, r: 0.5 }];
  return { id: 'rca-male', root: 'modules/pro-audio/pack/depictions', title: 'RCA plug', w, h: w, items, src: 'RCA (phono) plug end-on: centre pin (tip) inside the outer sleeve; approximate generic outline.' };
}

function trsEnd(): Face {
  const w = 10;
  const items: Item[] = [{ t: 'circle', x: 5, y: 5, r: 3.5 }, { t: 'circle', x: 5, y: 5, r: 2 }, { t: 'pin', id: 'tip', shape: 'circle', x: 5, y: 5, r: 0.7 }, { t: 'pin', id: 'ring', shape: 'circle', x: 6.4, y: 5, r: 0.35 }, { t: 'pin', id: 'sleeve', shape: 'circle', x: 7.6, y: 5, r: 0.35 }];
  return { id: 'trs-3-5mm-male', root: 'modules/pro-audio/pack/depictions', title: '3.5 mm TRS plug', w, h: w, items, src: '3.5 mm stereo (TRS) plug end-on: tip at the centre, ring and sleeve bands outward; end-on markers for the ring and sleeve are placed on their bands (approximate).' };
}

function usbA(): Face {
  const w = 16;
  const h = 8.5;
  const items: Item[] = [{ t: 'rect', x: 2, y: 2, w: 12, h: 4.5, rx: 0.4 }, { t: 'rect', x: 3, y: 3, w: 10, h: 2.5 }];
  // seen head-on the contacts run 4 3 2 1 left to right, centres 3.5 mm (VBUS, GND) and 1.0 mm (D-, D+) either side of the plug's centre line
  const xs = [11.5, 9, 7, 4.5];
  ['1', '2', '3', '4'].forEach((id, n) => items.push({ t: 'pin', id, shape: 'rect', x: xs[n] ?? 0, y: 4.6, w: 1.2, h: 1.4 }, { t: 'text', x: xs[n] ?? 0, y: 8, text: id }));
  return { id: 'usb-a-plug', root: 'modules/pc-serial/pack/depictions', title: 'USB Type-A plug', w, h, items, extraAnchors: { shell: [8, 2] }, src: 'USB Standard-A plug mating face, 12.0 x 4.5 mm shell; contacts numbered 4 3 2 1 left to right with centres 3.5 and 1.0 mm either side of the centre line, as in USB 2.0 Specification Figure 6-9 (USB Series "A" Plug Interface Drawing, USB-IF); contact widths and the outline are approximate.' };
}

function obd2(): Face {
  const w = 40;
  const h = 18;
  const items: Item[] = [{ t: 'poly', pts: [[2, 2], [38, 2], [34, 14], [6, 14]] }, { t: 'poly', pts: [[3.2, 3.2], [36.8, 3.2], [33.2, 12.8], [6.8, 12.8]] }];
  // viewed as the vehicle socket is (wide row on top, 1-8 then 9-16 left to right); the plug is its mirror
  for (let n = 0; n < 8; n += 1) items.push({ t: 'pin', id: String(8 - n), shape: 'rect', x: 20 + (n - 3.5) * 4, y: 5.8, w: 2, h: 2.4 });
  for (let n = 0; n < 8; n += 1) items.push({ t: 'pin', id: String(16 - n), shape: 'rect', x: 20 + (n - 3.5) * 4, y: 10.2, w: 2, h: 2.4 });
  items.push({ t: 'text', x: 8, y: 1.3, text: '8' }, { t: 'text', x: 32, y: 1.3, text: '1' }, { t: 'text', x: 9, y: 16.6, text: '16' }, { t: 'text', x: 31, y: 16.6, text: '9' });
  return { id: 'obd2-16-male', root: 'modules/automotive/pack/depictions', title: 'OBD-II (J1962) plug', w, h, items, src: 'SAE J1962 16-pin diagnostic plug mating face: the vehicle socket has pins 1-8 on the upper row and 9-16 on the lower row left to right; the plug is its mirror image (approximate trapezoid outline).' };
}

function vga(): Face {
  const w = 32;
  const h = 13.5;
  const cx = w / 2;
  const cy = h / 2;
  const items: Item[] = [{ t: 'rect', x: 0.5, y: 0.5, w: 31, h: 12.5, rx: 1.2 }, { t: 'circle', x: cx - 12.495, y: cy, r: 1.6 }, { t: 'circle', x: cx + 12.495, y: cy, r: 1.6 }];
  items.push({ t: 'poly', pts: [[cx - 7.3, cy - 4.2], [cx + 7.3, cy - 4.2], [cx + 6.2, cy + 4.2], [cx - 6.2, cy + 4.2]] });
  const p = 2.29;
  // three rows of five: 1-5, 6-10, 11-15 left to right, the middle row offset half a pitch
  for (let row = 0; row < 3; row += 1) {
    for (let n = 0; n < 5; n += 1) items.push({ t: 'pin', id: String(row * 5 + n + 1), shape: 'circle', x: cx + (n - 2 + (row === 1 ? -0.5 : 0)) * p, y: cy + (row - 1) * 1.98, r: 0.5 });
  }
  return { id: 'hd15-male', root: 'modules/av-video/pack/depictions', title: 'HD15 (VGA) male', w, h, items, extraAnchors: { shell: [cx - 12.495, cy] }, src: 'High-density D-sub 15-pin plug mating face: three rows of five at 2.29 mm pitch, 1.98 mm row gap, numbered 1-5, 6-10, 11-15 left to right (middle row half a pitch left); approximate outline.' };
}

/** A side cutaway of a coax multicore: jacket cut back to show coax cores stepped down and the plain cores. */
function multicoreCutaway(): Face & { cutaway: true } {
  const w = 525;
  const h = 131;
  const cy = 65;
  const items: Item[] = [
    { t: 'poly', pts: [[20, cy - 28], [200, cy - 28], [214, cy - 20], [200, cy - 12], [214, cy - 4], [200, cy + 4], [214, cy + 12], [200, cy + 20], [214, cy + 28], [20, cy + 28]] },
  ];
  const lanes = [cy - 20, cy - 4, cy + 12];
  lanes.forEach((y, i) => {
    items.push({ t: 'rect', x: 200, y: y - 5, w: 120 - i * 10, h: 10, rx: 4 }, { t: 'rect', x: 300 - i * 10, y: y - 3, w: 90, h: 6, rx: 3 }, { t: 'rect', x: 380 - i * 10, y: y - 1.2, w: 120, h: 2.4 });
  });
  items.push({ t: 'rect', x: 200, y: cy + 22, w: 130, h: 5, rx: 2 }, { t: 'text', x: 110, y: cy + 4, text: 'Jacket', size: 9 }, { t: 'text', x: 250, y: cy - 31, text: 'Coax shield', size: 9 }, { t: 'text', x: 345, y: cy - 31, text: 'Dielectric', size: 9 }, { t: 'text', x: 450, y: cy - 31, text: 'Centre conductor', size: 9 }, { t: 'text', x: 265, y: cy + 42, text: 'Plain core', size: 9 });
  return { cutaway: true, stroke: 1, id: 'multicore-3coax-4core', root: 'packages/catalog/depictions', title: 'Coax multicore, cutaway', w, h, items, src: 'Generic cutaway of a multicore with coax cores: jacket cut back, shields and dielectric stepped down to the centre conductors, plain cores alongside. Illustrative, not to scale.' };
}

export function faces(): Face[] {
  return [dsubDE9('de9-male', true), dsubDE9('de9-female', false), jstXh2(), terminalBlock4(), rj45(), xlr(true), xlr(false), rcaEnd(), trsEnd(), usbA(), obd2(), vga()];
}

/** Every generated file: repo-relative path → text. */
export function faceArtFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const face of faces()) {
    const dir = `${face.root}/${face.id}`;
    out[`${dir}/mating-face.svg`] = svg(face, 'mating-face');
    out[`${dir}/solder-side.svg`] = svg(face, 'solder-side');
    out[`${dir}/meta.json`] = meta(face);
  }
  const cut = multicoreCutaway();
  const dir = `${cut.root}/${cut.id}`;
  out[`${dir}/illustration.svg`] = svg(cut, 'mating-face').replace(' — mating face', ' — cutaway');
  out[`${dir}/meta.json`] = `${JSON.stringify(
    {
      defId: cut.id,
      views: { illustration: { file: 'illustration.svg', kind: 'vector', mmPerUnit: 1, sourceKind: 'hand', widthUnits: cut.w, heightUnits: cut.h, src: `${cut.src} ${CC0}` } },
      pinAnchors: {},
      anchorFrame: 'illustration',
      src: `${cut.src} ${CC0}`,
    },
    null,
    2,
  )}\n`;
  return out;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let differs = false;
  for (const [path, text] of Object.entries(faceArtFiles())) {
    const file = join(ROOT, path);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (current === text) continue;
    differs = true;
    if (check) console.error(`differs: ${path}`);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  if (check && differs) process.exit(1);
}
