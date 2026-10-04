/**
 * The BOM as a document: the cable's **product part number** in the header,
 * then its lines grouped the way purchasing and the bench think — boards,
 * connectors, wire, shells & hardware, discrete parts — with kits as an
 * informational note and every part without a part number flagged beside the
 * numbering scheme's proposal (never applied).
 *
 * The lines are `deriveBom`'s: this file only groups and annotates them, so
 * the printed BOM and the structured BOM can never disagree. A length family
 * (a PN ending in an `X` placeholder) fans the trunk out to one line per
 * variation PN; the family notation is a heading, never a part number.
 */

import {
  findPcba,
  findWire,
  kitsContaining,
  type CableDesign,
  type Db,
  type KnownPartNumber,
  type PartNumberScheme,
  type PnKind,
  type PnSuggestion,
} from '@cable-studio/model';
import type { DepictionSource } from '@cable-studio/layout';
import { catalogDepictions } from '@cable-studio/layout';

import { deriveBom, type BomCategory, type BomLine } from './bom.ts';
import { headerHtml, sheetHeader, type DocumentFacts, type SheetHeader } from './bench/header.ts';
import { trunkSides } from './bench/model.ts';
import { trunkSegment, type DrawingMeta } from './drawing/model.ts';
import { SHEET_STYLESHEET } from './styles.ts';
import { BENCH_STYLESHEET } from './bench/styles.ts';
import { compareStrings, escapeHtml, escapeMarkdownCell, facts } from './text.ts';
import { num } from './units.ts';

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

export type BomSection = 'boards' | 'connectors' | 'wire' | 'shells' | 'discretes';

export const BOM_SECTIONS: readonly { id: BomSection; title: string }[] = [
  { id: 'boards', title: 'Boards' },
  { id: 'connectors', title: 'Connectors' },
  { id: 'wire', title: 'Wire' },
  { id: 'shells', title: 'Shells & hardware' },
  { id: 'discretes', title: 'Discrete parts' },
];

const SECTION_OF: Readonly<Record<BomCategory, BomSection>> = {
  pcba: 'boards',
  connector: 'connectors',
  wire: 'wire',
  assembly: 'wire',
  shell: 'shells',
  hardware: 'shells',
  component: 'discretes',
};

const PN_KIND_OF: Readonly<Record<BomCategory, PnKind>> = {
  pcba: 'pcba',
  connector: 'connector',
  wire: 'wire',
  assembly: 'mechanical-other',
  shell: 'shell',
  hardware: 'fastener',
  component: 'component',
};

/** A problem the sheet reports beside its lines. */
export interface BomSheetProblem {
  code: string;
  message: string;
}

/** One printed line: a BOM line (or, for a family's trunk, one per variation), annotated. */
export interface BomSheetLine {
  section: BomSection;
  /** the BOM line's `key` */
  sourceKey: string;
  category: BomCategory;
  /** the part number the definition carries */
  sku?: string;
  state: 'mapped' | 'unmapped';
  /** quantity as printed (a numeric string) */
  quantity: string;
  unit: 'each' | 'ft';
  /** a family's trunk: the variation PN this quantity is for */
  variationPn?: string;
  ref: string;
  label: string;
  /** where it goes: `Source end`, `trunk (6 ft)` */
  location: string;
  instances: string[];
  /** boards: the bare PCB behind a populated board, its revision and build */
  board?: { bare?: string; rev?: string; build?: string; jumpers?: string };
  /** wire: the stock's manufacturer and the length in mm */
  wire?: { manufacturer?: string; mm?: number };
  notes: string;
  /** an unmapped part: the numbering scheme's proposal (never applied) */
  proposal?: PnSuggestion;
  /** why it is unmapped */
  reason?: string;
}

export interface BomSheet {
  header: SheetHeader;
  /** the product PN (or each variation PN of a family) */
  products: string[];
  lines: BomSheetLine[];
  /** kits that ship any of these parts — information, never a BOM line */
  kits: { sku: string; label: string; parts: string[] }[];
  blockers: BomSheetProblem[];
  warnings: BomSheetProblem[];
  /** a design with no product PN: the scheme's proposal for one */
  productProposal?: PnSuggestion;
  /** the notes that change what you buy (`deriveBom`'s roll-up) */
  notes: string[];
}

export interface BomSheetOptions {
  drawing?: DrawingMeta;
  /** a family's suffix to print one variation */
  variation?: string;
  /** the saved revision number */
  revision?: number;
  document?: { number?: string; revision?: string; status?: string };
  facts?: DocumentFacts;
  /** the numbering scheme and every number in use — given them, unmapped parts carry a proposal */
  partNumbers?: { scheme: PartNumberScheme; known: readonly KnownPartNumber[] };
  /** jumper settings for boards come from the artwork's population */
  depictions?: boolean | DepictionSource;
  generatedAt?: string;
}

function vendorOf(specRef: string | undefined): string | undefined {
  const first = specRef?.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? undefined : first;
}

function jumpersOf(source: DepictionSource | undefined, def: string): string | undefined {
  const parts = source?.meta(def)?.components?.parts ?? [];
  const jumpers = parts.filter((p) => p.kind === 'jumper' && (p.state === 'bridged' || p.state === 'open'));
  if (jumpers.length === 0) return undefined;
  return [...jumpers]
    .sort((a, b) => compareStrings(a.ref, b.ref))
    .map((p) => `${p.ref} ${p.state === 'bridged' ? 'closed' : 'open'}`)
    .join(' · ');
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

const MM_PER_FT = 304.8;

export function deriveBomSheet(design: CableDesign, db: Db, options: BomSheetOptions = {}): BomSheet {
  const header = sheetHeader(design, db, {
    kind: 'BILL OF MATERIALS',
    ...(options.drawing === undefined ? {} : { drawing: options.drawing }),
    ...(options.variation === undefined ? {} : { variation: options.variation }),
    ...(options.document === undefined ? {} : { document: options.document }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  const bom = deriveBom(design, db);
  const source = depictionSourceOf(options.depictions);
  const variations = header.variation !== undefined ? [header.variation] : header.variations.filter(() => header.family !== undefined);
  const products = header.productPn !== undefined ? [header.productPn] : variations.map((v) => v.pn);

  const propose = (category: BomCategory, ref: string, label: string): PnSuggestion | undefined => {
    if (options.partNumbers === undefined) return undefined;
    try {
      return options.partNumbers.scheme.suggest({ kind: PN_KIND_OF[category], label, id: ref }, options.partNumbers.known);
    } catch {
      return undefined;
    }
  };
  const productProposal =
    header.productPn === undefined && header.family === undefined && options.partNumbers !== undefined
      ? (() => {
          try {
            return options.partNumbers.scheme.suggest({ kind: 'design', label: design.label, id: design.id }, options.partNumbers.known);
          } catch {
            return undefined;
          }
        })()
      : undefined;

  // where a part goes, in bench words: the end it sits at (a shell's screws at their shell's end)
  const sides = trunkSides(design, db);
  const mech = design.instances.mechanical ?? [];
  const whereOf = (line: BomLine): string => {
    if (line.category === 'wire') return line.location;
    let id = line.provenance[0] ?? '';
    for (let guard = 0; guard < 4; guard += 1) {
      const m = mech.find((x) => x.id === id);
      if (m?.attachedTo === undefined) break;
      id = m.attachedTo;
    }
    const side = sides.get(id);
    const end = side === 'a' ? 'Source end' : side === 'b' ? 'Destination end' : undefined;
    const role = design.instances.connectors.find((c) => c.id === id)?.role;
    return facts([end, line.category === 'connector' ? role : undefined]) || line.location;
  };

  const trunkId = trunkSegment(design, db)?.id;
  const annotate = (line: BomLine, variation?: { pn: string; mm: number }): BomSheetLine => {
    const isWire = line.category === 'wire';
    const mm = isWire ? (variation?.mm ?? line.totalMm ?? line.length?.mm) : undefined;
    const quantity = isWire && mm !== undefined ? num(Math.round((mm / MM_PER_FT) * 100) / 100) : String(line.qty);
    const out: BomSheetLine = {
      section: SECTION_OF[line.category],
      sourceKey: line.key,
      category: line.category,
      ...(line.partNumber === undefined ? {} : { sku: line.partNumber }),
      state: line.partNumber === undefined ? 'unmapped' : 'mapped',
      quantity,
      unit: isWire && mm !== undefined ? 'ft' : 'each',
      ...(variation === undefined ? {} : { variationPn: variation.pn }),
      ref: line.ref,
      label: line.label,
      location: whereOf(line),
      instances: [...line.provenance].sort(compareStrings),
      notes: line.detail ?? '',
    };
    if (line.category === 'pcba') {
      const pcba = findPcba(db, line.ref);
      const jumpers = jumpersOf(source, line.ref);
      out.board = {
        ...(pcba?.partNumber === undefined ? {} : { bare: pcba.partNumber }),
        ...(pcba?.revision === undefined ? {} : { rev: pcba.revision }),
        ...(pcba?.build === undefined ? {} : { build: pcba.build }),
        ...(jumpers === undefined ? {} : { jumpers }),
      };
    }
    if (isWire) {
      const wire = findWire(db, line.ref);
      const manufacturer = wire?.manufacturer ?? vendorOf(wire?.specRef);
      out.wire = { ...(manufacturer === undefined ? {} : { manufacturer }), ...(mm === undefined ? {} : { mm }) };
    }
    if (out.state === 'unmapped') {
      out.reason = 'the definition carries no part number';
      const proposal = propose(line.category, line.ref, line.label);
      if (proposal !== undefined) out.proposal = proposal;
    }
    return out;
  };

  const lines: BomSheetLine[] = [];
  for (const line of bom.lines) {
    const fansOut = line.category === 'wire' && header.family !== undefined && variations.length > 0 && trunkId !== undefined && line.provenance.includes(trunkId);
    if (fansOut) for (const v of variations) lines.push(annotate(line, v));
    else lines.push(annotate(line));
  }
  const order = BOM_SECTIONS.map((s) => s.id);
  lines.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));

  // kits: which orderable kits carry any of these parts (information only)
  const kitMap = new Map<string, { sku: string; label: string; parts: Set<string> }>();
  const anchors = new Set(bom.lines.filter((l) => l.category === 'connector' || l.category === 'pcba' || l.category === 'shell').map((l) => l.ref));
  for (const line of bom.lines) {
    const kind = line.category === 'shell' || line.category === 'hardware' ? 'mechanical' : line.category;
    for (const kit of kitsContaining(db, { kind: kind as never, def: line.ref })) {
      // a kit that only shares a screw with this cable is not this cable's kit
      if (!kit.contents.some((c) => anchors.has(c.part.def))) continue;
      const entry = kitMap.get(kit.sku) ?? { sku: kit.sku, label: kit.label, parts: new Set<string>() };
      entry.parts.add(line.label);
      kitMap.set(kit.sku, entry);
    }
  }
  const kits = [...kitMap.values()]
    .map((k) => ({ sku: k.sku, label: k.label, parts: [...k.parts].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.sku, b.sku));

  const warnings: BomSheetProblem[] = lines
    .filter((l) => l.state === 'unmapped')
    .map((l) => ({ code: 'unmapped', message: `${l.label} (${l.ref}) has no part number` }));

  return {
    header,
    products,
    lines,
    kits,
    blockers: [],
    warnings,
    ...(productProposal === undefined ? {} : { productProposal }),
    notes: bom.notes.map((n) => n.text),
  };
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

function qtyText(line: BomSheetLine): string {
  return line.unit === 'ft' ? `${line.quantity} ft` : line.quantity;
}

function partCell(line: BomSheetLine): string {
  if (line.sku !== undefined) return `<span class="cs-sku">${escapeHtml(line.sku)}</span>`;
  return `<span class="cs-flag" title="${escapeHtml(line.reason ?? 'no part number')}">UNMAPPED</span>${
    line.proposal === undefined
      ? ''
      : `<span class="cs-proposal" title="${escapeHtml(`${line.proposal.explanation}${line.proposal.fallback ? ' (next free number — no pattern applied)' : ''}`)}">proposed ${escapeHtml(line.proposal.pn)}</span>`
  }`;
}

function describe(line: BomSheetLine): string {
  const extra: string[] = [];
  if (line.board !== undefined) {
    if (line.board.bare !== undefined) extra.push(`bare PCB ${line.board.bare}`);
    extra.push(...[line.board.rev, line.board.build].filter((s): s is string => s !== undefined));
  }
  // never the maker in the printed build sheet (owner 2026-09-25/26) —
  // `line.wire.manufacturer` still carries it, for a caller that wants it
  return `<span class="cs-desc">${escapeHtml(line.label)}</span>${extra.length === 0 ? '' : `<span class="cs-meta"> ${escapeHtml(extra.join(' · '))}</span>`}${
    line.board?.jumpers === undefined ? '' : `<span class="cs-jumpers">${escapeHtml(line.board.jumpers)}</span>`
  }`;
}

function sectionHtml(sheet: BomSheet, section: BomSection, title: string): string {
  const rows = sheet.lines.filter((l) => l.section === section);
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (line) =>
        `<tr class="${line.state === 'unmapped' ? 'cs-is-unmapped' : ''}" data-key="${escapeHtml(line.sourceKey)}"><td class="cs-num">${escapeHtml(qtyText(line))}</td><td>${partCell(line)}</td><td>${describe(
          line,
        )}</td><td>${escapeHtml(line.variationPn ?? line.location)}<span class="cs-refs">${escapeHtml(line.instances.join(' '))}</span></td></tr>`,
    )
    .join('');
  const head = `<th class="cs-num">Qty</th><th>Part</th><th>Description</th><th>${section === 'wire' ? 'For' : 'Where'}</th>`;
  return `<section class="cs-section cs-bom-sec" data-section="${section}"><h2 class="cs-section__h">${escapeHtml(title)}</h2><table class="cs-table cs-bomtable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

export function bomSheetBody(sheet: BomSheet): string {
  const parts: string[] = ['<div class="cs-root cs-sheet cs-bench">', `<style>${SHEET_STYLESHEET}${BENCH_STYLESHEET}</style>`, headerHtml(sheet.header)];
  if (sheet.header.productPn === undefined && sheet.header.family === undefined) {
    parts.push(
      `<p class="cs-callout">No part number for this cable.${
        sheet.productProposal === undefined ? '' : ` Proposed: <strong>${escapeHtml(sheet.productProposal.pn)}</strong> <span class="cs-meta">${escapeHtml(sheet.productProposal.explanation)}</span>`
      }</p>`,
    );
  }
  if (sheet.header.family !== undefined && sheet.header.variation === undefined && sheet.header.variations.length > 0) {
    parts.push(
      `<table class="cs-table cs-variations"><thead><tr><th>Part number</th><th>Length</th></tr></thead><tbody>${sheet.header.variations
        .map((v) => `<tr><td class="cs-sku">${escapeHtml(v.pn)}</td><td>${escapeHtml(`${v.mm} mm · ${v.feet}${v.overallMm === undefined ? '' : ` (${v.overallMm} mm overall)`}`)}</td></tr>`)
        .join('')}</tbody></table>`,
    );
  }
  for (const { id, title } of BOM_SECTIONS) parts.push(sectionHtml(sheet, id, title));
  if (sheet.kits.length > 0) {
    parts.push(
      `<section class="cs-section"><h2 class="cs-section__h">Kits</h2><p class="cs-meta">Information only — kits are never BOM lines.</p><ul class="cs-notes">${sheet.kits
        .map((k) => `<li><span class="cs-sku">${escapeHtml(k.sku)}</span> <span>${escapeHtml(k.label)} — ${escapeHtml(k.parts.join(', '))}</span></li>`)
        .join('')}</ul></section>`,
    );
  }
  const problems = [...sheet.blockers, ...sheet.warnings.filter((w) => w.code !== 'unmapped')];
  if (problems.length > 0) {
    parts.push(`<section class="cs-section"><h2 class="cs-section__h">Problems</h2><ul class="cs-notes">${problems.map((p) => `<li><span class="cs-tag">${escapeHtml(p.code)}</span> <span>${escapeHtml(p.message)}</span></li>`).join('')}</ul></section>`);
  }
  parts.push('</div>');
  return parts.join('');
}

/* ------------------------------------------------------------------ *
 * Markdown (Documents › Copy)
 * ------------------------------------------------------------------ */

export function bomSheetMarkdown(sheet: BomSheet): string {
  const h = sheet.header;
  const pn = h.productPn ?? (h.family !== undefined ? `${h.family} family: ${h.variations.map((v) => v.pn).join(', ')}` : 'no part number');
  const out: string[] = [
    `# Bill of materials — ${h.title}`,
    '',
    `**${pn}** · Rev ${h.revision ?? '—'}${h.release === undefined ? '' : ` · ${h.release}`} · ${h.designId} · ${h.status}`,
    '',
  ];
  if (sheet.productProposal !== undefined && h.productPn === undefined && h.family === undefined) out.push(`Proposed part number: ${sheet.productProposal.pn} (${sheet.productProposal.explanation})`, '');
  for (const { id, title } of BOM_SECTIONS) {
    const rows = sheet.lines.filter((l) => l.section === id);
    if (rows.length === 0) continue;
    out.push(`## ${title}`, '', '| Qty | Part | Description | Where | Refs |', '| ---: | :--- | :--- | :--- | :--- |');
    for (const line of rows) {
      const part = line.sku ?? `UNMAPPED${line.proposal === undefined ? '' : ` (proposed ${line.proposal.pn})`}`;
      // never the maker in the printed description (owner 2026-09-25/26) —
      // `line.wire.manufacturer` still carries it, for a caller that wants it
      const desc = facts([line.label, line.board?.bare === undefined ? undefined : `bare PCB ${line.board.bare}`, line.board?.build, line.board?.jumpers]);
      const where = line.variationPn ?? line.location;
      out.push(`| ${escapeMarkdownCell(qtyText(line))} | ${escapeMarkdownCell(part)} | ${escapeMarkdownCell(desc)} | ${escapeMarkdownCell(where)} | ${escapeMarkdownCell(line.instances.join(' '))} |`);
    }
    out.push('');
  }
  if (sheet.kits.length > 0) {
    out.push('## Kits (information only)', '');
    for (const k of sheet.kits) out.push(`- ${k.sku} ${k.label}: ${k.parts.join(', ')}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
