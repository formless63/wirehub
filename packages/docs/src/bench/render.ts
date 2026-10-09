/**
 * The bench build sheet: one page per bench stage, in
 * the order the bench works — kit & cut, the source end, the destination
 * end, assembly, test — each page a picture first and words second.
 *
 * Page 1 carries the full title block (`header.ts`); every later page a
 * running header with the part number, revision and sheet number, so a page
 * that leaves the stack still says what it belongs to.
 */

import { deriveLabels, labelsHtml } from '../exports/labels.ts';
import { resolveTestParameters, type TestParameters } from '../exports/test-params.ts';
import { findWire, isFullyBonded, placedDesign, resolveTerminal, terminalKey, validateDesign, type CableDesign, type Db, endName } from '@wirehub/model';
import { catalogDepictions, type DepictionSource } from '@wirehub/layout';

import { deriveDrawing, type DrawingFace } from '../drawing/model.ts';
import { deriveBomSheet, type BomSheet, type BomSheetOptions } from '../bom-sheet.ts';
import { deriveTestSpec, type Port, type TestSpec } from '../test-spec.ts';
import { brandSheetCss } from '../drawing/brand-font.ts';
import { SHEET_STYLESHEET } from '../styles.ts';
import { compareStrings, escapeHtml } from '../text.ts';
import { lengthFromMm } from '../units.ts';
import { conductorPaint } from '@wirehub/render-svg';
import { boardFigure, breakoutFigure, faceFigure, landingWords, stripFigure, type FaceSource } from './figures.ts';
import { footHtml, headerFrameCss, headerHtml, type SheetHeader } from './header.ts';
import { deriveBench, type Bench, type BenchEnd, type Landing, type SegmentEnd, type Termination } from './model.ts';
import { breakoutSection } from './breakouts.ts';
import { assemblySteps, endSteps, prepSteps, qaSteps, solderStep, shellSets, type Step } from './standard-work.ts';
import { BENCH_STYLESHEET } from './styles.ts';
import { crimpTableHtml, toolsHtml } from './crimp.ts';
import { trunkSegment } from '../drawing/model.ts';
import { suppliedEnds, type SuppliedEnd } from '../supplied.ts';

export interface BenchSheetOptions extends BomSheetOptions {
  title?: string;
  /** the organisation's test-parameter defaults (the design's own are the sidecar's `test`) */
  testDefaults?: TestParameters;
}

function depictionSourceOf(option: boolean | DepictionSource | undefined): DepictionSource | undefined {
  if (option === false || option === undefined) return undefined;
  if (option === true) {
    try {
      return catalogDepictions();
    } catch {
      return undefined;
    }
  }
  return option;
}

function stepsHtml(steps: readonly Step[]): string {
  if (steps.length === 0) return '';
  const extras = (s: Step): string =>
    `${(s.images ?? []).map((src) => `<img class="cs-stepimg" src="${escapeHtml(src)}" alt="">`).join('')}${
      s.tools === undefined || s.tools.length === 0 ? '' : `<span class="cs-tools">Tools: ${escapeHtml(s.tools.join(', '))}</span>`
    }${(s.checks ?? []).map((c) => `<span class="cs-stepcheck"><span class="cs-check"></span> ${escapeHtml(c)}</span>`).join('')}`;
  return `<ol class="cs-steps">${steps.map((s) => `<li><span>${escapeHtml(s.text)}${extras(s)}<span class="cs-src">${escapeHtml(s.src)}</span></span></li>`).join('')}</ol>`;
}

function stage(n: number, title: string, sub?: string): string {
  return `<div class="cs-stage"><span class="cs-stage__n">${n}</span><h2 class="cs-stage__h">${escapeHtml(title)}</h2>${sub === undefined ? '' : `<span class="cs-stage__sub">${escapeHtml(sub)}</span>`}</div>`;
}

function block(title: string, inner: string): string {
  return inner === '' ? '' : `<div class="cs-block"><h3 class="cs-block__h">${escapeHtml(title)}</h3>${inner}</div>`;
}

/* ------------------------------------------------------------------ *
 * Page 1 — kit and cut
 * ------------------------------------------------------------------ */

/**
 * The sub-assemblies this cable is built from: each is built (or pulled
 * from stock) to its own build sheet — referenced here, never inlined — and
 * this sheet only lands its free ends. One row per sub-assembly, then what
 * lands on each of its ports.
 */
export function subassembliesHtml(design: CableDesign, db: Db): string {
  const subs = design.instances.subassemblies ?? [];
  if (subs.length === 0) return '';
  const rows = subs
    .map((sub) => {
      const opened = placedDesign(db, sub);
      const placed = opened?.ok === true ? opened.placed.design : undefined;
      const rev = sub.rev === undefined ? 'working copy — not frozen' : `Rev ${sub.rev}`;
      const sheet = `the build sheet of ${sub.def} (${rev})`;
      const landings = design.joints
        .flatMap((joint) =>
          [
            [joint.a, joint.b],
            [joint.b, joint.a],
          ].filter(([mine]) => mine!.instance === sub.id),
        )
        .map(([mine, other]) => {
          const port = resolveTerminal(design, db, mine!);
          const to = resolveTerminal(design, db, other!);
          const portText = port.ok ? (port.terminal.label ?? mine!.terminal) : mine!.terminal;
          const toText = `${terminalKey(other!)}${to.ok && to.terminal.label !== undefined ? ` (${to.terminal.label})` : ''}`;
          return `${mine!.terminal} · ${portText} → ${toText}`;
        })
        .sort(compareStrings);
      return `<tr><td><span class="cs-check"></span></td><td>${escapeHtml(sub.label ?? sub.id)}</td><td class="cs-sku">${escapeHtml(placed?.productRef ?? 'UNMAPPED')}</td><td>${escapeHtml(placed?.label ?? sub.def)}<span class="cs-meta"> build to ${escapeHtml(sheet)}</span>${
        landings.length === 0 ? '' : `<ul class="cs-notes">${landings.map((l) => `<li><span>${escapeHtml(l)}</span></li>`).join('')}</ul>`
      }</td><td>${escapeHtml(sub.role ?? '')}</td></tr>`;
    })
    .join('');
  return `<table class="cs-cut cs-pull" data-subassemblies=""><thead><tr><th></th><th>Ref</th><th>Part</th><th>Built to · lands here</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pullList(bom: BomSheet): string {
  const rows = bom.lines.filter((l) => l.section !== 'wire');
  if (rows.length === 0) return '';
  const body = rows
    .map((l) => {
      const part = l.sku ?? 'UNMAPPED';
      const extra = [l.board?.build, l.board?.jumpers].filter((s): s is string => s !== undefined).join(' · ');
      return `<tr><td><span class="cs-check"></span></td><td class="cs-num">${escapeHtml(l.quantity)}</td><td class="cs-sku">${escapeHtml(part)}</td><td>${escapeHtml(l.label)}${
        extra === '' ? '' : `<span class="cs-jumpers">${escapeHtml(extra)}</span>`
      }</td><td>${escapeHtml(l.location)}</td></tr>`;
    })
    .join('');
  return `<table class="cs-cut cs-pull"><thead><tr><th></th><th class="cs-num">Qty</th><th>Part</th><th>Description</th><th>Where</th></tr></thead><tbody>${body}</tbody></table>`;
}

function cutList(design: CableDesign, db: Db, header: SheetHeader, supplied: readonly SuppliedEnd[]): string {
  const trunk = trunkSegment(design, db);
  const rows: string[] = [];
  const covered = new Set(supplied.flatMap((s) => [...s.covers]));
  for (const s of supplied) {
    // the trunk arrives cut, one end terminated: nothing to cut
    rows.push(
      `<tr><td><span class="cs-check"></span></td><td>${escapeHtml(s.def.supplies?.trunk === true ? 'Trunk' : 'End')}</td><td class="cs-sku">${escapeHtml(s.def.partNumber ?? '—')}</td><td>${escapeHtml(
        `${s.def.label.replace(/\s*—.*$/, '')} — supplied by the contract manufacturer, ${s.side === 'a' ? 'source' : 'destination'} end terminated`,
      )}</td><td class="cs-num">—</td><td class="cs-num"></td><td class="cs-sku"></td></tr>`,
    );
  }
  for (const segment of design.instances.segments) {
    if (covered.has(segment.id)) continue;
    const wire = findWire(db, segment.def);
    const isTrunk = segment.id === trunk?.id;
    const lengths =
      isTrunk && header.variation !== undefined
        ? [{ pn: header.variation.pn, mm: header.variation.mm }]
        : isTrunk && header.variations.length > 0
          ? header.variations.map((v) => ({ pn: v.pn, mm: v.mm }))
          : [{ pn: '', mm: segment.lengthMm }];
    for (const length of lengths) {
      const l = length.mm === undefined ? undefined : lengthFromMm(length.mm);
      rows.push(
        `<tr><td><span class="cs-check"></span></td><td>${escapeHtml(isTrunk ? 'Trunk' : (segment.role ?? segment.id).replace(/\s*\(.*$/, ''))}</td><td class="cs-sku">${escapeHtml(wire?.partNumber ?? '—')}</td><td>${escapeHtml(
          (wire?.label ?? segment.def).replace(/\s*\([^)]*\)\s*$/, ''),
        )}</td><td class="cs-num">${escapeHtml(l === undefined ? '—' : `${l.mm} mm`)}</td><td class="cs-num">${escapeHtml(l === undefined ? '' : l.text.replace(/^[\d.]+ mm \(|\)$/g, ''))}</td><td class="cs-sku">${escapeHtml(length.pn)}</td></tr>`,
      );
    }
  }
  if (rows.length === 0) return '';
  return `<table class="cs-cut"><thead><tr><th></th><th>Piece</th><th>Stock</th><th>Description</th><th class="cs-num">Cut</th><th class="cs-num">ft · in</th><th>For</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------ *
 * End pages
 * ------------------------------------------------------------------ */

function swatch(colour: string | undefined): string {
  return colour === undefined ? '' : `<span class="cs-swatch" style="background:${conductorPaint(colour)}"></span>`;
}

function landingList(landings: readonly Landing[], narrow = false): string {
  if (landings.length === 0) return '';
  return `<ul class="cs-landlist${narrow ? ' cs-landlist--one' : ''}">${landings
    .map((l) => {
      const { head, sub } = landingWords(l);
      const colour = l.element.kind === 'pigtail' ? undefined : l.element.colour;
      return `<li><span class="cs-n">${l.n}</span><span>${swatch(colour)}<strong>${escapeHtml(head)}</strong>${sub === '' ? '' : ` <span class="cs-meta">${escapeHtml(sub)}</span>`}${
        l.note === undefined ? '' : `<span class="cs-src" style="display:block;color:#98a2ac;font-size:6.2pt">${escapeHtml(l.note)}</span>`
      }</span></li>`;
    })
    .join('')}</ul>`;
}

/** The drawing-sheet face (or side-view plug) for a connector instance, when there is one. */
function faceFor(drawing: ReturnType<typeof deriveDrawing>, instance: string): FaceSource | undefined {
  const faces: DrawingFace[] = [drawing.faces.a, drawing.faces.b].filter((f): f is DrawingFace => f !== undefined);
  const face = faces.find((f) => f.port.instance === instance && f.port.prefix === undefined);
  if (face !== undefined) return { art: face.face, pins: face.pins, traced: face.traced, bridges: face.bridges, caption: face.face.subtitle ?? 'Solder side' };
  // a side-view plug (an RCA on a whip) has no face to land on: its landings are listed
  return undefined;
}

function omittedParts(term: Termination, db: Db, source: DepictionSource | undefined): string[] {
  if (source === undefined || term.kind !== 'pcba') return [];
  const own = db.pcbas.find((p) => p.id === term.def);
  if (own === undefined) return [];
  const mine = new Set((source.meta(term.def)?.components?.parts ?? []).map((p) => p.ref));
  if (mine.size === 0) return [];
  const others = new Set<string>();
  for (const sibling of db.pcbas) {
    if (sibling.id === own.id || sibling.partNumber !== own.partNumber || sibling.revision !== own.revision) continue;
    for (const part of source.meta(sibling.id)?.components?.parts ?? []) if (part.kind !== 'jumper') others.add(part.ref);
  }
  return [...others].filter((ref) => !mine.has(ref)).sort(compareStrings);
}

function endPage(
  n: number,
  end: BenchEnd,
  design: CableDesign,
  db: Db,
  source: DepictionSource | undefined,
  drawing: ReturnType<typeof deriveDrawing>,
  trunkId: string | undefined,
  other?: BenchEnd,
): string {
  const side = end.side;
  // the source end's parts sit left of the cable, the destination's right of it
  const cableSide = side === 'a' ? 'right' : 'left';
  const title = side === 'a' ? 'Source end' : 'Destination end';
  const main = end.terminations[0];
  const parts: string[] = [stage(n, title, main === undefined ? undefined : `${main.label}${main.partNumber === undefined ? '' : ` · ${main.partNumber}`}`)];

  // strip, then the board's own notes
  // the trunk's strip on the left; a whip's or lead's ends on the right, under the board notes
  const stripOf = (se: SegmentEnd): string => {
    const onBoard = end.terminations.some((t) => t.kind === 'pcba' && t.landings.some((l) => l.segment === se.segment && l.segEnd === se.end));
    const name = se.segment === trunkId ? 'trunk' : `${(se.role ?? se.segment).replace(/\s*\(.*$/, '')}, ${onBoard ? 'board end' : 'plug end'}`;
    return `<div class="cs-figwrap"><div class="cs-figwrap__cap">Strip — ${escapeHtml(name)} <span class="cs-meta">${escapeHtml(se.stock)}</span></div>${stripFigure(se, cableSide)}</div>`;
  };
  const trunkStrips = end.segmentEnds.filter((se) => se.segment === trunkId).map(stripOf).join('');
  const otherStrips = end.segmentEnds.filter((se) => se.segment !== trunkId).map(stripOf).join('');
  const before = endSteps(end, db, other);
  // the strip sits at its natural width, anchored to the left; the right column carries what belongs beside it, and when
  // there is nothing to put there the strip takes the row at a larger, still capped, size (cs-ld1m)
  const beside = `${block('Before soldering', stepsHtml(before))}${bridgesHtml(end)}${componentsHtml(end)}${otherStrips}`;
  parts.push(`<div class="cs-cols cs-endtop<!--solo-->" data-endtop><div class="cs-endtop__strip">${trunkStrips}</div><div>${block('Before soldering', stepsHtml(before))}${bridgesHtml(end)}${componentsHtml(end)}<!--side-->${otherStrips}</div></div>`);
  const colsAt = parts.length - 1;
  const pinned: Landing[] = [];

  const listed: Landing[] = [];
  // a trunk end that splits into single-signal plugs: the breakout drawing
  const breakout = drawing.breakouts[side];
  const jackPort = breakout?.jack?.designator === undefined ? undefined : drawing.ports.find((p) => p.designator === breakout.jack?.designator);
  const inBreakout = new Set([...(breakout?.plugs ?? []).map((p) => p.port.instance), ...(jackPort === undefined ? [] : [jackPort.instance])]);
  if (breakout !== undefined && inBreakout.size > 0) {
    const plugTerms = end.terminations.filter((t) => breakout.plugs.some((p) => p.port.instance === t.instance));
    const jackTerm = end.terminations.find((t) => t.instance === jackPort?.instance);
    const nameOf = (t: Termination): string => `${t.instance} ${design.instances.connectors.find((c) => c.id === t.instance)?.role?.replace(/\s*\(.*$/, '').replace(/:.*$/, '') ?? t.label}`;
    const plugs = plugTerms.map((t) => ({ term: t, moulded: breakout.plugs.find((p) => p.port.instance === t.instance)?.port.moulded === true, name: nameOf(t) }));
    parts.push(
      `<div class="cs-figwrap"><div class="cs-figwrap__cap">Breakout${plugs.some((p) => p.moulded) ? ' <span class="cs-meta">moulded by the contract manufacturer — pass-through lines run out to premade plugs</span>' : ''}</div>${breakoutFigure(
        plugs,
        jackTerm === undefined ? undefined : { term: jackTerm, moulded: false, name: nameOf(jackTerm) },
        cableSide,
      )}</div>`,
    );
  }
  // what becomes of every conductor in the mould on this end
  const moulds = breakoutSection(design, db, side);
  if (moulds !== '') parts.push(moulds);
  for (const [index, term] of end.terminations.entries()) {
    if (inBreakout.has(term.instance)) continue;
    const figure =
      term.kind === 'pcba'
        ? boardFigure(term, source, cableSide)
        : (() => {
            // a pin or two straight onto a connector another part carries is listed, not drawn
            const face = index > 0 && term.landings.length < 3 ? undefined : faceFor(drawing, term.instance);
            return face === undefined ? undefined : faceFigure(term, face, cableSide, index === 0 ? 70 : end.terminations.some((t) => t.mounted.some((m) => m.instance === term.instance)) ? 24 : 38);
          })();
    if (figure === undefined && term.kind !== 'pcba' && index > 0) {
      pinned.push(...term.landings);
      continue;
    }
    const chips: string[] = [];
    for (const j of figure?.jumpers ?? []) chips.push(`<span class="cs-chip ${j.state === 'bridged' ? 'cs-is-closed' : 'cs-is-open'}">${escapeHtml(`${j.ref} ${j.state === 'bridged' ? 'closed' : j.state}`)}</span>`);
    for (const f of figure?.fitted ?? []) chips.push(`<span class="cs-chip">${escapeHtml(`${f.ref}${f.label === undefined ? '' : ` ${f.label}`}`)}</span>`);
    for (const ref of omittedParts(term, db, source)) chips.push(`<span class="cs-chip cs-is-omit" title="on other builds of this board, not this one">${escapeHtml(ref)}</span>`);
    const mounted = term.mounted.length === 0 ? '' : ` <span class="cs-meta">· carries ${escapeHtml(term.mounted.map((m) => `${m.instance} ${m.label}`).join(', '))}</span>`;
    parts.push(
      `<div class="cs-figwrap" data-instance="${escapeHtml(term.instance)}"><div class="cs-figwrap__cap">${escapeHtml(term.instance)} — ${escapeHtml(term.label)}${mounted}</div>${
        chips.length === 0 ? '' : `<div class="cs-chips">${chips.join('')}</div>`
      }${figure?.svg ?? ''}</div>`,
    );
    listed.push(...term.landings.filter((l) => figure === undefined || !figure.drawn.has(l.n)));
  }
  // crimp: contact, seal and tool per cavity of each connector at this end
  for (const term of end.terminations) {
    if (term.kind === 'pcba') continue;
    const crimp = crimpTableHtml(design, db, term.instance);
    if (crimp !== '') parts.push(block(`Crimp — ${term.instance} ${term.label}`, crimp));
  }
  parts[colsAt] = (parts[colsAt] ?? '').replace('<!--solo-->', beside === '' && pinned.length === 0 ? ' cs-endtop--solo' : '').replace('<!--side-->', pinned.length === 0 ? '' : block('Plugs and pins', landingList(pinned, true)));
  if (listed.length > 0) parts.push(block(listed.length === end.terminations.reduce((c, t) => c + t.landings.length, 0) ? 'Landings' : 'Also at this end', landingList(listed)));
  return parts.join('');
}

function bridgesHtml(end: BenchEnd): string {
  const bridges = end.bridges.filter((b) => b.part === undefined);
  if (bridges.length === 0) return '';
  return block('Bridges', `<ul class="cs-notes">${bridges.map((b) => `<li><span>${escapeHtml(`${b.from} ↔ ${b.to}`)}${b.note === undefined ? '' : ` <span class="cs-meta">${escapeHtml(b.note)}</span>`}</span></li>`).join('')}</ul>`);
}

function componentsHtml(end: BenchEnd): string {
  const parts = end.bridges.filter((b) => b.part !== undefined);
  if (parts.length === 0) return '';
  return block('Fit by hand', `<ul class="cs-notes">${parts.map((b) => `<li><span><strong>${escapeHtml(b.part ?? '')}</strong> ${escapeHtml(`${b.from} → ${b.to}`)}</span></li>`).join('')}</ul>`);
}

/* ------------------------------------------------------------------ *
 * An end the contract manufacturer supplies terminated
 * ------------------------------------------------------------------ */

function suppliedHtml(s: SuppliedEnd): string {
  return `<p class="cs-legend"><strong>Supplied terminated by the contract manufacturer</strong> — ${escapeHtml(s.def.partNumber ?? '')} ${escapeHtml(s.def.label)}. Nothing to build at this end: check it arrived complete and undamaged.</p>`;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

function assemblyPage(n: number, bench: Bench, design: CableDesign, db: Db, supplied: readonly SuppliedEnd[]): string {
  const trunk = trunkSegment(design, db);
  const wire = trunk === undefined ? undefined : findWire(db, trunk.def);
  const cols = bench.ends.map((end) => {
    const bought = supplied.find((s) => s.side === end.side);
    if (bought !== undefined) return `<div>${block(end.side === 'a' ? 'Source end' : 'Destination end', suppliedHtml(bought))}</div>`;
    const instances = new Set(end.terminations.flatMap((t) => [t.instance, ...t.mounted.map((m) => m.instance)]));
    const sets = shellSets(design, db, instances);
    const setHtml = sets
      .map(
        (s) =>
          `<table class="cs-cut"><thead><tr><th></th><th class="cs-num">Qty</th><th>Part</th><th>${escapeHtml(s.attachedTo ?? '')}</th></tr></thead><tbody>${[
            ...(s.shell === undefined ? [] : [s.shell]),
            ...s.parts,
          ]
            .map((p) => `<tr><td><span class="cs-check"></span></td><td class="cs-num">${p.qty}</td><td class="cs-sku">${escapeHtml(p.partNumber ?? '—')}</td><td>${escapeHtml(p.label)}</td></tr>`)
            .join('')}</tbody></table>`,
      )
      .join('');
    const steps = assemblySteps(design, db, end, sets, wire);
    return `<div>${block(end.side === 'a' ? 'Source end' : 'Destination end', `${setHtml}${stepsHtml(steps)}`)}</div>`;
  });
  const labels = block('Wire labels', labelsHtml(deriveLabels(design, db)));
  return `${stage(n, 'Assembly', 'shells, hardware, strain relief')}<div class="cs-cols">${cols.join('')}</div>${labels}`;
}

/* ------------------------------------------------------------------ *
 * Test
 * ------------------------------------------------------------------ */

function portName(p: Port): string {
  const [prefix, pin] = p.terminal.includes('.') ? p.terminal.split('.') : [undefined, p.terminal];
  const where = prefix === undefined ? `${p.instance} ${pin}` : `${prefix.toUpperCase()} ${pin}`;
  return where;
}

function portsText(ports: readonly Port[]): string {
  if (ports.length === 0) return '—';
  if (ports.length === 1) {
    const p = ports[0] as Port;
    return `${portName(p)}${p.label === undefined ? '' : ` ${p.label}`}`;
  }
  const groups = new Map<string, string[]>();
  for (const p of ports) {
    const name = portName(p);
    const at = name.lastIndexOf(' ');
    const key = name.slice(0, at);
    groups.set(key, [...(groups.get(key) ?? []), name.slice(at + 1)]);
  }
  return [...groups.entries()]
    .map(([k, pins]) => `${k} ${pins.sort((x, y) => Number(x) - Number(y) || compareStrings(x, y)).join(', ')}`)
    .join('; ');
}

function shortExpect(expected: string, dc: boolean | undefined): string {
  if (dc === false) return 'OPEN — correct';
  const ohms = /≈\s*[\d.,]+\s*[kM]?Ω/.exec(expected);
  if (ohms !== null) return ohms[0];
  if (/OPEN/.test(expected) && !/beep/.test(expected)) return 'OPEN';
  return `Beep < ${/< ([\d.]+) Ω/.exec(expected)?.[1] ?? '5'} Ω`;
}

function signalWord(signal: string): string {
  return signal === 'control' ? 'control' : signal;
}

function continuityTable(spec: TestSpec): string {
  const rows: string[] = [];
  for (const c of spec.netChecks) {
    const a = c.ports.filter((p) => p.side === 'a' || p.side === 'both');
    const b = c.ports.filter((p) => p.side === 'b');
    rows.push(`<tr><td><span class="cs-check"></span></td><td>${escapeHtml(signalWord(c.signal))}</td><td>${escapeHtml(portsText(a))}</td><td>${escapeHtml(portsText(b))}</td><td><strong>${escapeHtml(shortExpect(c.expected, true))}</strong></td></tr>`);
  }
  for (const c of spec.pathChecks) {
    rows.push(
      `<tr><td><span class="cs-check"></span></td><td>${escapeHtml(signalWord(c.from.signal))}</td><td>${escapeHtml(portsText([c.from]))}</td><td>${escapeHtml(portsText([c.to]))}</td><td><strong>${escapeHtml(
        shortExpect(c.expected, c.dcContinuous),
      )}</strong> <span class="cs-meta">via ${escapeHtml(c.through.join(' · '))}</span></td></tr>`,
    );
  }
  if (rows.length === 0) return '';
  return `<table class="cs-cut"><thead><tr><th></th><th>Signal</th><th>Source end</th><th>Destination end</th><th>Expect</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/** Isolation, one matrix per end: each net once (its first port), O = must read open. */
function isolationMatrix(spec: TestSpec, side: 'a' | 'b'): string {
  const checks = [...spec.isolationChecks, ...spec.commoned].filter((c) => c.side === side);
  if (checks.length === 0) return '';
  const reps = new Map<string, Port>();
  const keyOf = (p: Port): string => p.net ?? p.key;
  for (const c of checks) {
    for (const p of [c.a, c.b]) {
      const k = keyOf(p);
      const have = reps.get(k);
      if (have === undefined || compareStrings(p.key, have.key) < 0) reps.set(k, p);
    }
  }
  const nets = [...reps.entries()].sort((x, y) => compareStrings(portName(x[1]), portName(y[1])));
  const cell = new Map<string, 'open' | 'common' | 'bad'>();
  for (const c of checks) {
    const x = keyOf(c.a);
    const y = keyOf(c.b);
    const v = c.commoned !== undefined ? 'common' : c.violated ? 'bad' : 'open';
    cell.set(`${x}|${y}`, v);
    cell.set(`${y}|${x}`, v);
  }
  const head = nets.map(([, p], i) => `<th title="${escapeHtml(portsText([p]))}">${i + 1}</th>`).join('');
  const body = nets
    .map(([kx, px], i) => {
      const tds = nets
        .map(([ky], j) => {
          if (j === i) return '<td class="cs-is-diag"></td>';
          if (j > i) return '<td></td>';
          const v = cell.get(`${kx}|${ky}`);
          return v === undefined ? '<td></td>' : v === 'open' ? '<td class="cs-is-open">O</td>' : v === 'common' ? '<td class="cs-is-common">=</td>' : '<td class="cs-is-bad">X</td>';
        })
        .join('');
      return `<tr><th class="cs-rowh">${i + 1} ${escapeHtml(portsText([px]))}</th>${tds}</tr>`;
    })
    .join('');
  return `<table class="cs-matrix"><thead><tr><th class="cs-rowh">${side === 'a' ? 'Source end' : 'Destination end'}</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function testPage(n: number, spec: TestSpec, db?: Db): string {
  const parts: string[] = [stage(n, 'Test', 'continuity, isolation, ground twists, picture and sound')];
  parts.push(block('Continuity — end to end', continuityTable(spec)));
  if (spec.commoned.length > 0) {
    parts.push(
      block(
        'Commoned by design — beeps, and that is correct',
        `<ul class="cs-notes">${spec.commoned
          .map((c) => `<li><span class="cs-check"></span> <span><strong>${escapeHtml(`${portsText([c.a])} = ${portsText([c.b])}`)}</strong> <span class="cs-meta">${escapeHtml(c.commoned ?? '')}</span></span></li>`)
          .join('')}</ul>`,
      ),
    );
  }
  const matrices = [isolationMatrix(spec, 'a'), isolationMatrix(spec, 'b')].filter((m) => m !== '');
  if (matrices.length > 0) {
    parts.push(
      block(
        'Isolation — meter reads OPEN',
        `<p class="cs-legend">O must read open · = commoned by design (beeps) · X shorted: reject · blank: not a check</p><div class="cs-cols">${matrices.map((m) => `<div>${m}</div>`).join('')}</div>`,
      ),
    );
  }
  if (spec.violations.length > 0) {
    parts.push(`<p class="cs-callout">${escapeHtml(`${spec.violations.length} isolation check${spec.violations.length === 1 ? '' : 's'} fail on the design itself: ${spec.violations.map((v) => `${portsText([v.a])} ~ ${portsText([v.b])}`).join('; ')}`)}</p>`);
  }
  const opens = spec.openChecks;
  if (opens.length > 0) {
    const unused = opens.filter((o) => o.openKind === 'unused-pin');
    const other = opens.filter((o) => o.openKind !== 'unused-pin');
    const unusedText = (() => {
      const groups = new Map<string, string[]>();
      for (const o of unused) {
        const m = /^([^.\s]+)\.(?:(\w+)\.)?([^\s]+)/.exec(o.text);
        const key = m === null ? o.text : m[2] === undefined ? m[1] ?? '' : `${m[1]} ${m[2].toUpperCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), m?.[3] ?? '']);
      }
      return [...groups.entries()].map(([k, pins]) => `${k} ${pins.join(', ')}`).join('; ');
    })();
    parts.push(
      block(
        'Deliberately open',
        `<ul class="cs-notes">${other.map((o) => `<li><span>${escapeHtml(o.text)} <span class="cs-meta">— ${escapeHtml(o.openKind === 'cut-end' ? 'cut back' : 'not terminated')}</span></span></li>`).join('')}${
          unused.length === 0 ? '' : `<li><span>Unused pins: ${escapeHtml(unusedText)}</span></li>`
        }</ul>`,
      ),
    );
  }
  if (spec.groundLandings.length > 0) {
    parts.push(
      block(
        'Ground twists — before the shell goes on',
        `<ul class="cs-notes">${spec.groundLandings
          .map((g) => `<li><span class="cs-check"></span> <span>${escapeHtml(`${endName(g.end)}: ${g.membersText} → ${g.landing === '' ? 'NOT LANDED' : `${g.landing}${g.pad === undefined ? '' : ` (${g.pad})`}`}`)} <span class="cs-meta">${escapeHtml(g.expected)}</span></span></li>`)
          .join('')}</ul>`,
      ),
    );
  }
  parts.push(block('Picture and sound', stepsHtml(qaSteps(db))));
  return parts.join('');
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

export function benchSheetBody(design: CableDesign, db: Db, options: BenchSheetOptions = {}): string {
  const source = depictionSourceOf(options.depictions);
  const bom = deriveBomSheet(design, db, { ...options, ...(source === undefined ? {} : { depictions: source }) });
  const header = options.title === undefined ? bom.header : { ...bom.header, title: options.title, kind: 'BENCH BUILD SHEET' };
  header.kind = 'BENCH BUILD SHEET';
  const bench = deriveBench(design, db);
  const spec = deriveTestSpec(design, db, { continuityOhmsMax: resolveTestParameters(options.drawing?.test, options.testDefaults).continuityOhmsMax });
  const drawing = deriveDrawing(design, db, options.drawing ?? {});
  const trunkId = trunkSegment(design, db)?.id;
  const supplied = suppliedEnds(design, db);
  const covered = new Set(supplied.flatMap((s) => [...s.covers]));

  const pages: { title: string; html: string }[] = [];
  const prep = design.instances.segments
    .filter((segment) => segment.id === trunkId || !covered.has(segment.id))
    .map((segment) => {
      const wire = findWire(db, segment.def);
      if (wire === undefined) return '';
      const title = `Prep — ${segment.id === trunkId ? 'trunk' : (segment.role ?? segment.id).replace(/\s*\(.*$/, '')} (${wire.label.replace(/\s*\([^)]*\)\s*$/, '')})`;
      return block(title, stepsHtml(prepSteps(wire, isFullyBonded(wire), db)));
    })
    .join('');
  const kit = [
    block('Sub-assemblies — build each to its own sheet first', subassembliesHtml(design, db)),
    block('Parts to pull', pullList(bom)),
    block('Tools', toolsHtml(design, db)),
    block(supplied.length > 0 ? 'Cut and stock' : 'Cut', cutList(design, db, header, supplied)),
    `<div class="cs-cols">${prep}${block('Solder', stepsHtml([solderStep(db)]))}</div>`,
  ].join('');
  const errors = validateDesign(design, db).filter((issue) => issue.severity === 'error');
  const validation =
    errors.length === 0
      ? ''
      : `<div class="cs-callout"><strong>Validation: ${errors.length} error${errors.length === 1 ? '' : 's'} — not fit to build from.</strong><ul class="cs-notes">${errors
          .map((e) => `<li><span class="cs-tag">${escapeHtml(e.code)}</span> <span>${escapeHtml(e.message)}</span></li>`)
          .join('')}</ul></div>`;
  pages.push({ title: 'Kit & cut', html: `${validation}${stage(1, 'Kit & cut')}${kit}` });
  for (const end of bench.ends) {
    if (end.terminations.length === 0) continue;
    const bought = supplied.find((s) => s.side === end.side);
    if (bought !== undefined) {
      const title = end.side === 'a' ? 'Source end' : 'Destination end';
      pages.push({ title, html: `${stage(pages.length + 1, title, 'supplied terminated by the contract manufacturer')}${suppliedHtml(bought)}` });
      continue;
    }
    const other = bench.ends.find((e) => e.side !== end.side);
    pages.push({ title: end.side === 'a' ? 'Source end' : 'Destination end', html: endPage(pages.length + 1, end, design, db, source, drawing, trunkId, other) });
  }
  pages.push({ title: 'Assembly', html: assemblyPage(pages.length + 1, bench, design, db, supplied) });
  pages.push({ title: 'Test', html: testPage(pages.length + 1, spec, db) });

  const out: string[] = ['<div class="cs-root cs-sheet cs-bench wh-sheet-col">', `<style>${SHEET_STYLESHEET}${BENCH_STYLESHEET}${headerFrameCss(header)}${brandSheetCss()}</style>`];
  // the first page opens with the title block; every printed page carries the frame's strip (`frame/`), so the later stages need no running header
  pages.forEach((page, i) => {
    out.push(`<section class="cs-page" data-stage="${escapeHtml(page.title)}">${i === 0 ? headerHtml(header) : ''}${page.html}</section>`);
  });
  out.push(footHtml(header), '</div>');
  return out.join('');
}
