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

import { designStatus, findWire, type CableDesign, type Db } from '@wirehub/model';

import type { DrawingMeta, LengthVariant } from '../drawing/model.ts';
import { trunkSegment } from '../drawing/model.ts';
import { registeredTitleBlock } from '../drawing/assets.ts';
import { flowFooter, frameCss, frameSpecFor, titleBlockHtml, type PaperId, type SheetFrameSpec, type TitleBlockStandard } from '../frame/index.ts';
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
  /** the organisation the sheet is issued by, when the deployment names one */
  organisation?: string;
  /** a rights / confidentiality line, when the deployment sets one */
  rights?: string;
  date?: string;
  generatedAt?: string;
  /** what the shared frame is drawn with: the paper, the layout, the checker */
  frame: { paper?: PaperId; titleBlock?: TitleBlockStandard; checked?: string };
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
  paper?: PaperId;
  titleBlock?: TitleBlockStandard;
  checked?: string;
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
  const registered = registeredTitleBlock();
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
    designer: drawing.designer ?? registered.designer ?? DEFAULT_DESIGNER,
    ...(registered.organisation === undefined ? {} : { organisation: registered.organisation }),
    ...(registered.rights === undefined ? {} : { rights: registered.rights }),
    ...(drawing.date === undefined ? {} : { date: drawing.date }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    frame: {
      ...(input.paper === undefined ? {} : { paper: input.paper }),
      ...(input.titleBlock === undefined ? {} : { titleBlock: input.titleBlock }),
      ...(input.checked === undefined ? {} : { checked: input.checked }),
    },
  };
}

/** The trunk length(s) the header's product is cut to, in words. */
export function lengthWords(header: SheetHeader, designMm: number | undefined): string {
  if (header.variation !== undefined) return lengthFromMm(header.variation.mm).text;
  if (header.variations.length > 0) return header.variations.map((v) => `${v.suffix} = ${v.mm} mm`).join(' · ');
  return designMm === undefined ? '—' : lengthFromMm(designMm).text;
}

/**
 * The shared frame this sheet is printed in (`frame/`): the same border, title
 * block, strip and state stamp as every other sheet, filled from the header.
 * On the sheet's paper, in the orientation the document prints in.
 */
export function headerFrame(header: SheetHeader, variant: 'full' | 'strip' = 'full', orientation: 'portrait' | 'landscape' = 'portrait'): SheetFrameSpec {
  const pn = header.productPn ?? (header.family === undefined ? undefined : `${header.family} family`);
  return frameSpecFor({
    kind: header.kind,
    title: header.title,
    orientation,
    variant,
    ...(header.frame.paper === undefined ? {} : { paper: header.frame.paper }),
    ...(header.frame.titleBlock === undefined ? {} : { standard: header.frame.titleBlock }),
    ...(header.organisation === undefined ? {} : { org: header.organisation }),
    ...(pn === undefined ? {} : { pn }),
    ...(header.revision === undefined ? {} : { rev: header.revision }),
    ...(header.release === undefined ? {} : { state: header.release }),
    ...(header.designer === DEFAULT_DESIGNER ? {} : { drawn: header.designer }),
    ...(header.frame.checked === undefined ? {} : { checked: header.frame.checked }),
    ...((header.date ?? header.generatedAt) === undefined ? {} : { date: (header.date ?? header.generatedAt) as string }),
  });
}

function fact(label: string, value: string, mono = false): string {
  return `<span class="cs-fact"><span class="cs-fact__k">${escapeHtml(label)}</span><span class="cs-fact__v${mono ? ' cs-mono' : ''}">${escapeHtml(value)}</span></span>`;
}

/**
 * The top of a sheet's first page: the frame's title block, then the facts a
 * bench reads before anything else (design, stock, destination, status) on one
 * line, and the part numbers of a length family.
 */
export function headerHtml(header: SheetHeader): string {
  const spec = headerFrame(header);
  const status = header.status === 'active' ? undefined : header.status.toUpperCase();
  const line = [
    fact('Design', header.designId, true),
    fact('Stock', header.stock),
    ...(header.sync === undefined ? [] : [fact('Sync', header.sync)]),
    ...(header.destination === undefined ? [] : [fact('Destination', header.destination)]),
    ...(status === undefined ? [] : [`<span class="cs-fact cs-is-flag"><span class="cs-fact__k">Status</span><span class="cs-fact__v">${escapeHtml(status)}</span></span>`]),
    ...(header.productPn === undefined && header.family !== undefined && header.variations.length > 0
      ? [fact('Part numbers', header.variations.map((v) => v.pn).join(' · '), true)]
      : []),
    ...(header.productPn !== undefined && header.family !== undefined && header.variation !== undefined ? [fact('Family', `${header.family} · ${header.variation.feet}`, true)] : []),
  ].join('');
  return `<header class="cs-head">${titleBlockHtml(spec)}<div class="cs-facts">${line}</div>${
    header.rights === undefined ? '' : `<div class="cs-rights">${escapeHtml(header.rights)}</div>`
  }</header>`;
}

/** The stylesheet of the frame for this header's sheet: class rules only (`@page` belongs to the whole document). */
export function headerFrameCss(header: SheetHeader): string {
  return frameCss(headerFrame(header));
}

/** The sheet's foot: the strip and stamp of the frame, the last children of the sheet's root. */
export function footHtml(header: SheetHeader): string {
  return flowFooter(headerFrame(header, 'strip'));
}
