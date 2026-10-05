/**
 * The production tables: BOM, wire list and cut list.
 *
 * Every row is a fold of the same derivations the printed sheets use
 * (`deriveBomSheet`, `deriveBench`, the trunk's length variations), so a CSV
 * can never disagree with the sheet it sits beside. Column order is fixed and
 * documented in `docs/exports.md`; nothing here is shop-specific (a module
 * exporter adds columns of its own).
 */

import { findWire, inScope, type CableDesign, type Db } from '@wirehub/model';

import { deriveBench, stockElements, type Landing } from '../bench/model.ts';
import { benchOptions, type BuildSheetOptions } from '../build-sheet.ts';
import { deriveBomSheet, BOM_SECTIONS } from '../bom-sheet.ts';
import { sheetHeader } from '../bench/header.ts';
import { trunkSegment } from '../drawing/model.ts';
import { suppliedEnds } from '../supplied.ts';
import { compareStrings } from '../text.ts';
import { num } from '../units.ts';
import type { Table } from './table.ts';

export type ExportOptions = BuildSheetOptions;

/* ------------------------------------------------------------------ *
 * BOM
 * ------------------------------------------------------------------ */

export const BOM_HEADERS = ['section', 'part_number', 'description', 'quantity', 'unit', 'location', 'instances', 'variation_pn', 'notes'] as const;

/** One row per printed BOM line (a length family's trunk: one per variation). */
export function bomTable(design: CableDesign, db: Db, options: ExportOptions = {}): Table {
  const sheet = deriveBomSheet(design, db, benchOptions(options));
  const title = new Map(BOM_SECTIONS.map((s) => [s.id, s.title]));
  return {
    name: 'BOM',
    headers: BOM_HEADERS,
    rows: sheet.lines.map((line) => [
      title.get(line.section) ?? line.section,
      line.sku ?? '',
      line.label,
      Number(line.quantity),
      line.unit === 'ft' ? 'ft' : 'ea',
      line.location,
      line.instances.join(' '),
      line.variationPn ?? '',
      line.notes,
    ]),
  };
}

/* ------------------------------------------------------------------ *
 * Wire list
 * ------------------------------------------------------------------ */

export const WIRE_LIST_HEADERS = [
  'segment',
  'stock_part_number',
  'stock',
  'element',
  'kind',
  'colour',
  'a_landing',
  'a_pad',
  'b_landing',
  'b_pad',
  'length_mm',
  'notes',
] as const;

function landingText(landing: Landing | undefined): [string, string] {
  if (landing === undefined) return ['', ''];
  return [`${landing.target.instance}.${landing.target.terminal}`, landing.target.pad ?? ''];
}

/**
 * One row per conductor, screen and drain of every wire segment, plus one per
 * pigtail: which terminal each end lands on (blank = not landed: cut back).
 */
export function wireListTable(design: CableDesign, db: Db): Table {
  const bench = deriveBench(design, db);
  const landings = new Map<string, Landing>();
  for (const end of bench.ends) {
    for (const termination of end.terminations) {
      for (const landing of termination.landings) {
        const key = landing.element.kind === 'pigtail' ? `pigtail:${landing.element.id}` : landing.element.path;
        landings.set(`${landing.segment}|${landing.segEnd}|${key}`, landing);
      }
    }
  }
  const rows: (string | number)[][] = [];
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const row = (element: string, kind: string, colour: string, notes: string): (string | number)[] => {
      const a = landingText(landings.get(`${segment.id}|a|${element}`));
      const b = landingText(landings.get(`${segment.id}|b|${element}`));
      return [segment.id, wire.partNumber ?? '', wire.label, element, kind, colour, a[0], a[1], b[0], b[1], segment.lengthMm ?? '', notes];
    };
    for (const element of stockElements(wire)) {
      if (!inScope(segment, element.path)) continue;
      rows.push(row(element.path, element.kind, element.colour ?? '', element.label ?? ''));
    }
    for (const pigtail of segment.pigtails ?? []) {
      const key = `pigtail:${pigtail.id}`;
      const end = pigtail.end;
      const landing = landings.get(`${segment.id}|${end}|${key}`);
      const [text, pad] = landingText(landing);
      rows.push([
        segment.id, wire.partNumber ?? '', wire.label, key, 'pigtail', '',
        end === 'a' ? text : '', end === 'a' ? pad : '', end === 'b' ? text : '', end === 'b' ? pad : '',
        segment.lengthMm ?? '',
        landing?.element.kind === 'pigtail' ? landing.element.name : '',
      ]);
    }
  }
  return { name: 'Wire list', headers: WIRE_LIST_HEADERS, rows };
}

/* ------------------------------------------------------------------ *
 * Cut list
 * ------------------------------------------------------------------ */

export const CUT_LIST_HEADERS = ['stock_part_number', 'stock', 'piece', 'length_mm', 'length_in', 'quantity', 'variation_pn', 'segments'] as const;

const MM_PER_INCH = 25.4;

/**
 * One row per stock, piece and length: the trunk once per orderable length
 * variation, every other piece at its own length, equal pieces folded into a
 * quantity. A segment the contract manufacturer supplies is not cut here.
 */
export function cutListTable(design: CableDesign, db: Db, options: ExportOptions = {}): Table {
  const header = sheetHeader(design, db, {
    kind: 'CUT LIST',
    ...(options.drawing === undefined ? {} : { drawing: options.drawing }),
    ...(options.variation === undefined ? {} : { variation: options.variation }),
    ...(options.document === undefined ? {} : { document: options.document }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  });
  const trunk = trunkSegment(design, db);
  const covered = new Set(suppliedEnds(design, db).flatMap((s) => [...s.covers]));
  interface Fold { key: string; cells: (string | number)[]; quantity: number; segments: string[] }
  const folds = new Map<string, Fold>();
  for (const segment of design.instances.segments) {
    if (covered.has(segment.id)) continue;
    const wire = findWire(db, segment.def);
    const isTrunk = segment.id === trunk?.id;
    const piece = isTrunk ? 'trunk' : (segment.role ?? segment.id).replace(/\s*\(.*$/, '');
    const lengths =
      isTrunk && header.variation !== undefined
        ? [{ pn: header.variation.pn, mm: header.variation.mm as number | undefined }]
        : isTrunk && header.variations.length > 0
          ? header.variations.map((v) => ({ pn: v.pn, mm: v.mm as number | undefined }))
          : [{ pn: '', mm: segment.lengthMm }];
    for (const length of lengths) {
      const key = [wire?.id ?? segment.def, piece, length.mm ?? '', length.pn].join('|');
      const found = folds.get(key);
      if (found !== undefined) {
        found.quantity += 1;
        found.segments.push(segment.id);
        continue;
      }
      folds.set(key, {
        key,
        quantity: 1,
        segments: [segment.id],
        cells: [
          wire?.partNumber ?? '',
          wire?.label ?? segment.def,
          piece,
          length.mm === undefined ? '' : Math.round(length.mm * 10) / 10,
          length.mm === undefined ? '' : Number(num(length.mm / MM_PER_INCH, 1)),
        ],
      });
    }
  }
  const sorted = [...folds.values()].sort((a, b) => compareStrings(a.key, b.key));
  return {
    name: 'Cut list',
    headers: CUT_LIST_HEADERS,
    rows: sorted.map((f) => [...f.cells, f.quantity, f.key.split('|')[3] as string, f.segments.join(' ')]),
  };
}
