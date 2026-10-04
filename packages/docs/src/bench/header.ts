/**
 * The title block the bench build sheet and the BOM share: what cable this is
 * by **part number** — the product PN, or for a length family (a PN ending in
 * an `X` placeholder, `CBL-00012-XX`) its variation PNs with the family only
 * as a heading (a family is not a product) — which saved revision, released
 * or not, and the handful of facts a bench reads before anything else:
 * design, stock, destination, status, designer.
 *
 * Pure: the host passes what it knows (the drawing sidecar, the revision being
 * printed, the cable list's short names); anything it does not pass is
 * derived from the design or left blank, never invented.
 */

import { designStatus, findWire, type CableDesign, type Db } from '@cable-studio/model';

import type { DrawingMeta, LengthVariant } from '../drawing/model.ts';
import { trunkSegment } from '../drawing/model.ts';
import { escapeHtml } from '../text.ts';
import { feetAttribute, feetFromMm, lengthFromMm } from '../units.ts';

/** Short names the host already computes for its cable list (`destinationShort`, sync, stock). */
export interface DocumentFacts {
  destination?: string;
  sync?: string;
  stock?: string;
}

/** The designer printed when the drawing sidecar names none. */
export const DEFAULT_DESIGNER = '—';

/** A length family: a PN whose last group is an `X` placeholder (`CBL-00012-XX`, `…-3X`); group 1 is the stem. */
const FAMILY = /^(.+)-[0-9X]?X$/i;

export interface Variation {
  /** `CBL-00012-36` */
  pn: string;
  suffix: string;
  mm: number;
  /** `6ft` */
  feet: string;
  /** overall length when a breakout makes the trunk shorter */
  overallMm?: number;
}

export interface SheetHeader {
  /** `BENCH BUILD SHEET` */
  kind: string;
  title: string;
  /** the one product this sheet is (a concrete PN or the chosen variation) */
  productPn?: string;
  /** the family heading (`CBL-00012-XX`) — never printed as a part number */
  family?: string;
  /** every orderable variation of a family, or the concrete PN's own lengths */
  variations: Variation[];
  /** the chosen variation (a family printed for one length) */
  variation?: Variation;
  revision?: string;
  /** `RELEASED` / `UNRELEASED` / a free status from the sheet options */
  release?: string;
  designId: string;
  designLabel: string;
  stock: string;
  sync?: string;
  destination?: string;
  /** production status — `active`, `development`, `legacy`, `retired` */
  status: string;
  designer: string;
  date?: string;
  generatedAt?: string;
}

export interface HeaderInput {
  kind: string;
  title?: string;
  drawing?: DrawingMeta;
  /** a family's suffix (`-36`) to print the sheet for one variation */
  variation?: string;
  document?: { number?: string; revision?: string; status?: string };
  facts?: DocumentFacts;
  generatedAt?: string;
}

function shortStock(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** A design's variations: a family's `-NN` lengths as PNs, else the concrete PN's lengths. */
export function variationsOf(partNumber: string | undefined, lengths: readonly LengthVariant[] | undefined): { family?: string; variations: Variation[] } {
  const raw = (partNumber ?? '').trim();
  const family = FAMILY.exec(raw);
  const out: Variation[] = [];
  for (const length of lengths ?? []) {
    const pn = family === null ? raw : /^-\d{2}$/.test(length.suffix) ? `${(family[1] as string).toUpperCase()}${length.suffix}` : '';
    if (pn === '') continue;
    out.push({
      pn,
      suffix: length.suffix,
      mm: length.mm,
      feet: feetAttribute(feetFromMm(length.mm)),
      ...(length.overallMm === undefined ? {} : { overallMm: length.overallMm }),
    });
  }
  return { ...(family === null ? {} : { family: raw.toUpperCase() }), variations: out };
}

export function sheetHeader(design: CableDesign, db: Db, input: HeaderInput): SheetHeader {
  const drawing = input.drawing ?? {};
  // one PN everywhere: the sheet options' own document number for this print
  // (when it is not just the drawing's PN or the productRef), else the
  // design's productRef, else the drawing's PN
  const docNumber = input.document?.number;
  const explicitDoc = docNumber !== undefined && docNumber !== drawing.partNumber && docNumber !== design.productRef ? docNumber : undefined;
  const pnRaw = explicitDoc ?? design.productRef ?? drawing.partNumber ?? docNumber;
  const { family, variations } = variationsOf(pnRaw, drawing.lengths);
  const chosen = input.variation === undefined ? undefined : variations.find((v) => v.suffix === input.variation);
  const productPn = family === undefined ? (pnRaw === undefined || pnRaw.trim() === '' ? undefined : pnRaw.trim()) : chosen?.pn;
  const trunk = trunkSegment(design, db);
  const wire = trunk === undefined ? undefined : findWire(db, trunk.def);
  const stock = input.facts?.stock ?? (wire === undefined ? '—' : shortStock(wire.label));
  const sync = input.facts?.sync;
  const destination = input.facts?.destination ?? design.label.split(' → ')[1]?.split(',')[0]?.trim();
  const revision = input.document?.revision ?? drawing.revision;
  return {
    kind: input.kind,
    title: input.title ?? drawing.title ?? design.label,
    ...(productPn === undefined ? {} : { productPn }),
    ...(family === undefined ? {} : { family }),
    variations,
    ...(chosen === undefined ? {} : { variation: chosen }),
    ...(revision === undefined || revision === '' ? {} : { revision }),
    ...(input.document?.status === undefined ? {} : { release: input.document.status }),
    designId: design.id,
    designLabel: design.label,
    stock,
    ...(sync === undefined || sync === '' ? {} : { sync }),
    ...(destination === undefined || destination === '' ? {} : { destination }),
    status: designStatus(design),
    designer: drawing.designer ?? DEFAULT_DESIGNER,
    ...(drawing.date === undefined ? {} : { date: drawing.date }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
  };
}

/** The trunk length(s) the header's product is cut to, in words. */
export function lengthWords(header: SheetHeader, designMm: number | undefined): string {
  if (header.variation !== undefined) return lengthFromMm(header.variation.mm).text;
  if (header.variations.length > 0) return header.variations.map((v) => `${v.suffix} = ${v.mm} mm`).join(' · ');
  return designMm === undefined ? '—' : lengthFromMm(designMm).text;
}

function cell(label: string, value: string, cls = '', raw = false): string {
  return `<div class="cs-tb__cell${cls === '' ? '' : ` ${cls}`}"><span class="cs-tb__k">${escapeHtml(label)}</span><span class="cs-tb__v">${raw ? value : escapeHtml(value)}</span></div>`;
}

/**
 * The title block, in the drawing-sheet language: a ruled grid of
 * small upper-case labels over large values. `sheet` = `n of m` for a
 * multi-page document.
 */
export function headerHtml(header: SheetHeader, options: { sheet?: string } = {}): string {
  const release = header.release;
  const releaseCls = release === undefined ? '' : /UNRELEASED|DRAFT|PRELIM/i.test(release) ? ' cs-is-unreleased' : /RELEASED/i.test(release) ? ' cs-is-released' : '';
  const pnValue =
    header.productPn !== undefined
      ? `<span class="cs-tb__pn">${escapeHtml(header.productPn)}</span>${
          header.family === undefined ? '' : `<span class="cs-tb__sub">${escapeHtml(`${header.family} family · ${header.variation?.feet ?? ''}`)}</span>`
        }`
      : header.family !== undefined
        ? `<span class="cs-tb__sub">${escapeHtml(`${header.family} family`)}</span><span class="cs-tb__pns">${header.variations
            .map((v) => `<span>${escapeHtml(v.pn)}</span>`)
            .join('')}</span>`
        : '<span class="cs-tb__none">no part number</span>';
  const rev = `<span class="cs-tb__pn">${escapeHtml(header.revision ?? '—')}</span>${
    release === undefined ? '' : `<span class="cs-badge${releaseCls}">${escapeHtml(release)}</span>`
  }`;
  const status = header.status === 'active' ? 'Active' : header.status.toUpperCase();
  return [
    '<header class="cs-tb">',
    '<div class="cs-tb__row cs-tb__row--top">',
    `<div class="cs-tb__kind">${escapeHtml(header.kind)}</div>`,
    cell('Title', header.title, 'cs-tb__title'),
    cell(header.productPn === undefined && header.family !== undefined ? 'Part numbers' : 'Part number', pnValue, 'cs-tb__pncell', true),
    cell('Revision', rev, 'cs-tb__rev', true),
    '</div>',
    '<div class="cs-tb__row">',
    cell('Design', header.designId, 'cs-tb__mono'),
    cell('Stock', header.stock),
    cell('Sync', header.sync ?? '—'),
    cell('Destination', header.destination ?? '—'),
    cell('Status', status, header.status === 'active' ? '' : 'cs-is-flag'),
    cell('Designer', header.designer),
    ...(header.generatedAt === undefined ? [] : [cell('Printed', header.generatedAt)]),
    ...(options.sheet === undefined ? [] : [cell('Sheet', options.sheet)]),
    '</div>',
    '</header>',
  ].join('');
}

/** The running header on every page after the first: PN · rev · design · sheet. */
export function runningHeaderHtml(header: SheetHeader, stage: string, sheet: string): string {
  const pn = header.productPn ?? (header.family === undefined ? header.designId : `${header.family} family`);
  return `<div class="cs-run"><span class="cs-run__pn">${escapeHtml(pn)}</span><span>Rev ${escapeHtml(header.revision ?? '—')}${
    header.release === undefined ? '' : ` · ${escapeHtml(header.release)}`
  }</span><span class="cs-run__stage">${escapeHtml(stage)}</span><span>${escapeHtml(header.designId)}</span><span>Sheet ${escapeHtml(sheet)}</span></div>`;
}
