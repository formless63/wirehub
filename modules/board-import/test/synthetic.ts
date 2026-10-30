/**
 * A synthetic board in every open format the module reads, written here so
 * no real board is needed (CC0): a 40 × 20 mm adapter with three wire pads
 * (A, B, GND — GND twice, once on each face), an output pad, a 5 V pad, a
 * three-pin header, a 120 Ω termination across A/B, an R–C path from B to
 * OUT, a decoupling capacitor and a four-pin IC.
 *
 * Board frame: the outline runs (100, 100) – (140, 120) in KiCad's frame, so
 * a pad at (105, 105) is at (5, 5) in the art frame.
 */

export const BOARD_NAME = 'synthetic-adapter';

interface Pad {
  number: string;
  net: string;
  kind: 'smd' | 'thru_hole';
  at: [number, number];
  size: [number, number];
  shape?: string;
  bottom?: boolean;
}

interface Fp {
  lib: string;
  ref: string;
  value: string;
  at: [number, number, number?];
  bottom?: boolean;
  pads: Pad[];
  attr?: string;
  model?: string;
}

/** Footprints in board coordinates (pad `at` is local to the footprint). */
export const FOOTPRINTS: Fp[] = [
  { lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', ref: 'TP1', value: 'A', at: [105, 105], pads: [{ number: '1', net: '/A', kind: 'smd', at: [0, 0], size: [1.5, 1.5], shape: 'rect' }] },
  { lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', ref: 'TP2', value: 'B', at: [105, 110], pads: [{ number: '1', net: '/B', kind: 'smd', at: [0, 0], size: [1.5, 1.5], shape: 'rect' }] },
  { lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', ref: 'TP3', value: 'GND', at: [105, 115], pads: [{ number: '1', net: 'GND', kind: 'smd', at: [0, 0], size: [1.5, 1.5], shape: 'rect' }] },
  { lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', ref: 'TP4', value: 'GND', at: [110, 115], bottom: true, pads: [{ number: '1', net: 'GND', kind: 'smd', at: [0, 0], size: [1.5, 1.5], shape: 'rect', bottom: true }] },
  { lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', ref: 'TP5', value: 'TestPoint', at: [120, 115], pads: [{ number: '1', net: '/OUT', kind: 'smd', at: [0, 0], size: [1.5, 1.5], shape: 'rect' }] },
  { lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', ref: 'TP6', value: '5V', at: [125, 115], pads: [{ number: '1', net: '+5V', kind: 'smd', at: [0, 0], size: [1.5, 1.5], shape: 'rect' }] },
  {
    lib: 'Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical',
    ref: 'J1',
    value: 'Conn_01x03',
    at: [130, 105],
    pads: [
      { number: '1', net: '/A', kind: 'thru_hole', at: [0, 0], size: [1.7, 1.7], shape: 'rect' },
      { number: '2', net: '/B', kind: 'thru_hole', at: [0, 2.54], size: [1.7, 1.7], shape: 'oval' },
      { number: '3', net: 'GND', kind: 'thru_hole', at: [0, 5.08], size: [1.7, 1.7], shape: 'oval' },
    ],
  },
  {
    lib: 'Resistor_SMD:R_0603_1608Metric',
    ref: 'R1',
    value: '120',
    at: [115, 107.5, 90],
    model: '${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl',
    pads: [
      { number: '1', net: '/A', kind: 'smd', at: [-0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
      { number: '2', net: '/B', kind: 'smd', at: [0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
    ],
  },
  {
    lib: 'Resistor_SMD:R_0603_1608Metric',
    ref: 'R2',
    value: '1k',
    at: [115, 112],
    pads: [
      { number: '1', net: '/B', kind: 'smd', at: [-0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
      { number: '2', net: 'Net-(C1-Pad1)', kind: 'smd', at: [0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
    ],
  },
  {
    lib: 'Capacitor_SMD:C_0603_1608Metric',
    ref: 'C1',
    value: '100n',
    at: [118, 112],
    pads: [
      { number: '1', net: 'Net-(C1-Pad1)', kind: 'smd', at: [-0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
      { number: '2', net: '/OUT', kind: 'smd', at: [0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
    ],
  },
  {
    lib: 'Capacitor_SMD:C_0603_1608Metric',
    ref: 'C2',
    value: '100n',
    at: [125, 110],
    pads: [
      { number: '1', net: '+5V', kind: 'smd', at: [-0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
      { number: '2', net: 'GND', kind: 'smd', at: [0.775, 0], size: [0.8, 0.95], shape: 'roundrect' },
    ],
  },
  {
    lib: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
    ref: 'U1',
    value: 'XCVR',
    at: [122, 105],
    pads: [
      { number: '1', net: '/A', kind: 'smd', at: [-2.5, -1.9], size: [1.5, 0.6], shape: 'roundrect' },
      { number: '2', net: '/B', kind: 'smd', at: [-2.5, -0.6], size: [1.5, 0.6], shape: 'roundrect' },
      { number: '3', net: 'GND', kind: 'smd', at: [-2.5, 0.6], size: [1.5, 0.6], shape: 'roundrect' },
      { number: '4', net: '+5V', kind: 'smd', at: [-2.5, 1.9], size: [1.5, 0.6], shape: 'roundrect' },
    ],
  },
];

const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

export function kicadPcb(): string {
  const nets = [...new Set(FOOTPRINTS.flatMap((f) => f.pads.map((p) => p.net)))];
  const netNo = (name: string): number => nets.indexOf(name) + 1;
  const out: string[] = [
    '(kicad_pcb',
    '\t(version 20241229)',
    '\t(generator "pcbnew")',
    '\t(general (thickness 1.6))',
    '\t(paper "A4")',
    `\t(title_block (title "Synthetic adapter") (rev "2") (company "Example Shop"))`,
    '\t(net 0 "")',
    ...nets.map((n, i) => `\t(net ${i + 1} ${q(n)})`),
  ];
  for (const fp of FOOTPRINTS) {
    const layer = fp.bottom === true ? 'B' : 'F';
    out.push(`\t(footprint ${q(fp.lib)} (layer "${layer}.Cu") (at ${fp.at[0]} ${fp.at[1]}${fp.at[2] === undefined ? '' : ` ${fp.at[2]}`})`);
    out.push(`\t\t(property "Reference" ${q(fp.ref)} (at 0 -2 0) (layer "${layer}.SilkS"))`);
    out.push(`\t\t(property "Value" ${q(fp.value)} (at 0 2 0) (layer "${layer}.Fab"))`);
    if (fp.attr !== undefined) out.push(`\t\t(attr ${fp.attr})`);
    for (const pad of fp.pads) {
      const layers = pad.kind === 'thru_hole' ? '"*.Cu" "*.Mask"' : `"${pad.bottom === true ? 'B' : 'F'}.Cu" "${pad.bottom === true ? 'B' : 'F'}.Paste" "${pad.bottom === true ? 'B' : 'F'}.Mask"`;
      out.push(
        `\t\t(pad ${q(pad.number)} ${pad.kind} ${pad.shape ?? 'rect'} (at ${pad.at[0]} ${pad.at[1]}${fp.at[2] === undefined ? '' : ` ${fp.at[2]}`}) (size ${pad.size[0]} ${pad.size[1]})${pad.kind === 'thru_hole' ? ' (drill 1)' : ''} (layers ${layers}) (net ${netNo(pad.net)} ${q(pad.net)}))`,
      );
    }
    if (fp.model !== undefined) out.push(`\t\t(model ${q(fp.model)} (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`);
    out.push('\t)');
  }
  // the outline as four lines
  const corners: [number, number][] = [
    [100, 100],
    [140, 100],
    [140, 120],
    [100, 120],
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    out.push(`\t(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))`);
  }
  out.push(')', '');
  return out.join('\n');
}

export function kicadNetlist(): string {
  const nets = [...new Set(FOOTPRINTS.flatMap((f) => f.pads.map((p) => p.net)))];
  const out: string[] = [
    '(export (version "E")',
    '  (design (source "synthetic-adapter.kicad_sch") (tool "Eeschema 9.0")',
    '    (sheet (number "1") (name "/") (tstamps "/") (title_block (title "Synthetic adapter") (company "Example Shop") (rev "2"))))',
    '  (components',
  ];
  for (const fp of FOOTPRINTS) out.push(`    (comp (ref ${q(fp.ref)}) (value ${q(fp.value)}) (footprint ${q(fp.lib)}))`);
  out.push('  )', '  (nets');
  nets.forEach((net, i) => {
    out.push(`    (net (code "${i + 1}") (name ${q(net)})`);
    for (const fp of FOOTPRINTS) for (const pad of fp.pads) if (pad.net === net) out.push(`      (node (ref ${q(fp.ref)}) (pin ${q(pad.number)}) (pintype "passive"))`);
    out.push('    )');
  });
  out.push('  )', ')', '');
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Gerbers, as KiCad plots them (format 4.6, mm, y up = −KiCad y)
 * ------------------------------------------------------------------ */

const g = (v: number): string => String(Math.round(v * 1e6));

function boardPos(fp: Fp, pad: Pad): [number, number] {
  const t = ((fp.at[2] ?? 0) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [fp.at[0] + pad.at[0] * c + pad.at[1] * s, fp.at[1] - pad.at[0] * s + pad.at[1] * c];
}

function header(fn: string): string[] {
  return [
    '%TF.GenerationSoftware,KiCad,Pcbnew,9.0*%',
    '%TF.ProjectId,synthetic-adapter,73796e74,2*%',
    `%TF.FileFunction,${fn}*%`,
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%LPD*%',
    'G04 synthetic example*',
  ];
}

function copper(side: 'top' | 'bottom'): string {
  const lines = [
    ...header(side === 'top' ? 'Copper,L1,Top' : 'Copper,L2,Bot'),
    // KiCad's rounded-rectangle macro
    '%AMRoundRect*',
    '0 Rectangle with rounded corners*',
    '0 $1 Rounding radius*',
    '0 $2 $3 $4 $5 $6 $7 $8 $9 X,Y pos of 4 corners*',
    '0 Add a 4 corners polygon primitive as box body*',
    '4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*',
    '0 Add four circle primitives for the rounded corners*',
    '1,1,$1+$1,$2,$3*',
    '1,1,$1+$1,$4,$5*',
    '1,1,$1+$1,$6,$7*',
    '1,1,$1+$1,$8,$9*',
    '0 Add four rect primitives between the rounded corners*',
    '20,1,$1+$1,$2,$3,$4,$5,0*',
    '20,1,$1+$1,$4,$5,$6,$7,0*',
    '20,1,$1+$1,$6,$7,$8,$9,0*',
    '20,1,$1+$1,$8,$9,$2,$3,0*%',
    '%ADD10R,1.500000X1.500000*%',
    '%ADD11C,1.700000*%',
    '%ADD12R,1.700000X1.700000*%',
    '%ADD13RoundRect,0.200000X-0.200000X-0.275000X0.200000X-0.275000X0.200000X0.275000X-0.200000X0.275000X0*%',
    '%ADD14C,0.250000*%',
    '%ADD15O,1.700000X1.700000*%',
  ];
  for (const fp of FOOTPRINTS) {
    for (const pad of fp.pads) {
      const onBottom = pad.bottom === true;
      if (pad.kind === 'smd' && onBottom !== (side === 'bottom')) continue;
      const [x, y] = boardPos(fp, pad);
      const d = pad.kind === 'thru_hole' ? (pad.shape === 'rect' ? 'D12' : 'D15') : pad.shape === 'roundrect' ? 'D13' : 'D10';
      lines.push(`${d}*`, `X${g(x)}Y${g(-y)}D03*`);
    }
  }
  if (side === 'top') {
    // a trace with an arc, and a filled zone with a cut-out (clear polarity)
    lines.push('D14*', `X${g(105)}Y${g(-105)}D02*`, `G01X${g(110)}Y${g(-105)}D01*`, `G75*`, `G02X${g(112)}Y${g(-107)}I${g(0)}J${g(-2)}D01*`, `G01*`);
    lines.push('G36*', `X${g(132)}Y${g(-114)}D02*`, `X${g(138)}Y${g(-114)}D01*`, `X${g(138)}Y${g(-118)}D01*`, `X${g(132)}Y${g(-118)}D01*`, `X${g(132)}Y${g(-114)}D01*`, 'G37*');
    lines.push('%LPC*%', 'D11*', `X${g(135)}Y${g(-116)}D03*`, '%LPD*%');
  }
  lines.push('M02*', '');
  return lines.join('\n');
}

function mask(side: 'top' | 'bottom'): string {
  const lines = [...header(side === 'top' ? 'Soldermask,Top' : 'Soldermask,Bot'), '%ADD10R,1.600000X1.600000*%', '%ADD11C,1.800000*%'];
  for (const fp of FOOTPRINTS) {
    for (const pad of fp.pads) {
      if (pad.kind === 'smd' && (pad.bottom === true) !== (side === 'bottom')) continue;
      const [x, y] = boardPos(fp, pad);
      lines.push(pad.kind === 'thru_hole' ? 'D11*' : 'D10*', `X${g(x)}Y${g(-y)}D03*`);
    }
  }
  lines.push('M02*', '');
  return lines.join('\n');
}

function silk(): string {
  return [...header('Legend,Top'), '%ADD10C,0.150000*%', 'D10*', `X${g(102)}Y${g(-102)}D02*`, `X${g(112)}Y${g(-102)}D01*`, 'M02*', ''].join('\n');
}

function edge(): string {
  return [
    ...header('Profile,NP'),
    '%ADD10C,0.050000*%',
    'D10*',
    `X${g(100)}Y${g(-100)}D02*`,
    `X${g(140)}Y${g(-100)}D01*`,
    `X${g(140)}Y${g(-120)}D01*`,
    `X${g(100)}Y${g(-120)}D01*`,
    `X${g(100)}Y${g(-100)}D01*`,
    'M02*',
    '',
  ].join('\n');
}

function drill(): string {
  const lines = ['M48', '; DRILL file {KiCad 9.0} date 2026-01-01', '; FORMAT={-:-/ absolute / metric / decimal}', '; #@! TF.FileFunction,Plated,1,2,PTH', 'FMAT,2', 'METRIC', 'T1C1.000', '%', 'G90', 'G05', 'T1'];
  for (const fp of FOOTPRINTS) for (const pad of fp.pads) if (pad.kind === 'thru_hole') {
    const [x, y] = boardPos(fp, pad);
    lines.push(`X${x.toFixed(3)}Y${(-y).toFixed(3)}`);
  }
  lines.push('M30', '');
  return lines.join('\n');
}

export function gerberFiles(): { path: string; text: string }[] {
  return [
    { path: `gerbers/${BOARD_NAME}-F_Cu.gtl`, text: copper('top') },
    { path: `gerbers/${BOARD_NAME}-B_Cu.gbl`, text: copper('bottom') },
    { path: `gerbers/${BOARD_NAME}-F_Mask.gts`, text: mask('top') },
    { path: `gerbers/${BOARD_NAME}-B_Mask.gbs`, text: mask('bottom') },
    { path: `gerbers/${BOARD_NAME}-F_Silkscreen.gto`, text: silk() },
    { path: `gerbers/${BOARD_NAME}-Edge_Cuts.gm1`, text: edge() },
    { path: `gerbers/${BOARD_NAME}-PTH.drl`, text: drill() },
    { path: `gerbers/${BOARD_NAME}-job.gbrjob`, text: '{"Header":{}}' },
  ];
}

/* ------------------------------------------------------------------ *
 * Fab files (a JLCPCB-style BOM and placement)
 * ------------------------------------------------------------------ */

export const BOM_CSV = [
  'Comment,Designator,Footprint,LCSC',
  '120,R1,R_0603_1608Metric,C0001',
  '1k,R2,R_0603_1608Metric,C0002',
  '100n,"C1,C2",C_0603_1608Metric,C0003',
  'XCVR,U1,SOIC-8_3.9x4.9mm_P1.27mm,C0004',
  'Conn_01x03,J1,PinHeader_1x03_P2.54mm_Vertical,',
  '',
].join('\n');

export const CPL_CSV = ['Designator,Mid X,Mid Y,Layer,Rotation', 'R1,15mm,-7.5mm,Top,90', 'R2,15,-12,Top,0', 'C1,18,-12,Top,0', 'C2,25,-10,Top,0', 'U1,22,-5,Top,0', 'J1,30,-5,Top,0', 'TP4,10,-15,Bottom,0', ''].join('\n');

/** A BOM with headers nobody's tool writes: the review step maps them. */
export const ODD_BOM_CSV = ['Board parts list, synthetic', '', 'Where;What;Shape;Maker PN', 'R1;120;R_0603_1608Metric;RC-0603-120R', 'R2;1k;R_0603_1608Metric;RC-0603-1K', ''].join('\n');

/* ------------------------------------------------------------------ *
 * The schematic (KiCad 8+ `.kicad_sch`), for the disagreement check: the
 * same parts and nets as the board, except where `SCHEMATIC_DIFFERS` says —
 * J1 pin 3 on its own SHIELD net (the board ties it to GND), C2 never drawn,
 * and a SENSE test point (TP7) the board does not have. Labels sit on the
 * pin ends; the R2–C1 net is a wire with no name.
 * ------------------------------------------------------------------ */

export const SCHEMATIC_DIFFERS = { 'J1.3': '/SHIELD', omitted: ['C2'], added: { ref: 'TP7', value: 'SENSE', net: '/SENSE' } } as const;

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export function kicadSch(): string {
  let n = 1;
  const root = uuid(n++);
  const font = '(effects (font (size 1.27 1.27)))';
  const hidden = '(effects (font (size 1.27 1.27)) (hide yes))';
  // one generic symbol per pin count; pins on the left edge, 2.54 mm apart, ends at x = -5.08
  const symbolOf = (pins: number): string => `synthetic:P${pins}`;
  const libSymbol = (pins: number): string =>
    [
      `(symbol ${q(symbolOf(pins))} (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)`,
      `  (property "Reference" "X" (at 0 2.54 0) ${font})`,
      `  (property "Value" "P${pins}" (at 0 ${-2.54 * pins} 0) ${font})`,
      `  (property "Footprint" "" (at 0 0 0) ${hidden})`,
      `  (property "Datasheet" "" (at 0 0 0) ${hidden})`,
      `  (symbol "P${pins}_0_1" (rectangle (start -2.54 1.27) (end 2.54 ${-2.54 * pins + 1.27}) (stroke (width 0.254) (type default)) (fill (type none))))`,
      `  (symbol "P${pins}_1_1"`,
      ...Array.from({ length: pins }, (_, i) => `    (pin passive line (at -5.08 ${-2.54 * i} 0) (length 2.54) (name "${i + 1}" ${font}) (number "${i + 1}" ${font}))`),
      '  )',
      ')',
    ].join('\n');
  const parts: { ref: string; value: string; lib: string; pins: string[] }[] = FOOTPRINTS.filter((fp) => !(SCHEMATIC_DIFFERS.omitted as readonly string[]).includes(fp.ref)).map((fp) => ({
    ref: fp.ref,
    value: fp.value,
    lib: fp.lib,
    pins: fp.pads.map((p) => (fp.ref === 'J1' && p.number === '3' ? SCHEMATIC_DIFFERS['J1.3'] : p.net)),
  }));
  parts.push({ ref: SCHEMATIC_DIFFERS.added.ref, value: SCHEMATIC_DIFFERS.added.value, lib: 'TestPoint:TestPoint_Pad_1.5x1.5mm', pins: [SCHEMATIC_DIFFERS.added.net] });
  const counts = [...new Set(parts.map((p) => p.pins.length))].sort();
  const body: string[] = [];
  const wires: [number, number][] = [];
  parts.forEach((part, i) => {
    const sx = 50.8 + (i % 4) * 30.48;
    const sy = 50.8 + Math.floor(i / 4) * 20.32;
    body.push(
      [
        `(symbol (lib_id ${q(symbolOf(part.pins.length))}) (at ${sx} ${sy} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${q(uuid(n++))})`,
        `  (property "Reference" ${q(part.ref)} (at ${sx} ${sy - 3.81} 0) ${font})`,
        `  (property "Value" ${q(part.value)} (at ${sx} ${sy + 2.54 * part.pins.length} 0) ${font})`,
        `  (property "Footprint" ${q(part.lib)} (at ${sx} ${sy} 0) ${hidden})`,
        `  (property "Datasheet" "" (at ${sx} ${sy} 0) ${hidden})`,
        ...part.pins.map((_, k) => `  (pin "${k + 1}" (uuid ${q(uuid(n++))}))`),
        `  (instances (project "${BOARD_NAME}" (path "/${root}" (reference ${q(part.ref)}) (unit 1))))`,
        ')',
      ].join('\n'),
    );
    part.pins.forEach((net, k) => {
      // the pin end: symbol y grows down on the sheet, the library's y up
      const x = Math.round((sx - 5.08) * 100) / 100;
      const y = Math.round((sy + 2.54 * k) * 100) / 100;
      if (net.startsWith('Net-(')) {
        wires.push([x, y]);
        return;
      }
      body.push(
        net.startsWith('/')
          ? `(label ${q(net.slice(1))} (at ${x} ${y} 180) ${font} (uuid ${q(uuid(n++))}))`
          : `(global_label ${q(net)} (shape passive) (at ${x} ${y} 180) ${font} (uuid ${q(uuid(n++))}))`,
      );
    });
  });
  // the unnamed net: wires joining its pin ends, around the parts (a step left, down below the sheet's parts, across, up)
  const below = 50.8 + Math.ceil(parts.length / 4) * 20.32;
  const segment = (a: [number, number], b: [number, number]): string => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid ${q(uuid(n++))}))`;
  for (let i = 1; i < wires.length; i++) {
    const [a, b] = [wires[i - 1]!, wires[i]!];
    const ax = Math.round((a[0] - 1.27) * 100) / 100;
    const bx = Math.round((b[0] - 1.27) * 100) / 100;
    body.push(segment(a, [ax, a[1]]), segment([ax, a[1]], [ax, below]), segment([ax, below], [bx, below]), segment([bx, below], [bx, b[1]]), segment([bx, b[1]], b));
  }
  return [
    '(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")',
    `(uuid ${q(root)})`,
    '(paper "A4")',
    '(title_block (title "Synthetic adapter") (rev "2") (company "Example Shop"))',
    '(lib_symbols',
    ...counts.map(libSymbol),
    ')',
    ...body,
    '(sheet_instances (path "/" (page "1")))',
    ')',
    '',
  ].join('\n');
}
