/**
 * A board house's BOM and placement (CPL / pick-and-place) files → the
 * board's placed parts (`BoardPartsEntry`) and one component record per
 * distinct part.
 *
 * Both files are CSV (comma, semicolon or tab separated; a preamble before the
 * header row is skipped). Columns are found by their usual names — KiCad's
 * BOM and position exports, the JLCPCB templates, the common EDA exports —
 * and the review step may override any of them (`ColumnMapping`, the
 * `mapping` option). Nothing is guessed beyond the columns: a part's category
 * comes from its reference designator, its value is normalised only where it
 * is a resistance or capacitance.
 *
 * Identity: two lines are one component when they share a manufacturer part
 * number, else a supplier part number, else category + value + package. A
 * component the Library already has (same id, or the same MPN / supplier
 * number) is reused, never proposed again.
 */

import type { BoardPartsEntry, ComponentCategory, ComponentDefinition, ComponentSupplierPart, Db, PcbaDefinition, PlacedPart } from '@wirehub/model';

import { compareRefs, type BoardSource } from './kicad.ts';
import { categoryOfRef, componentKindOf, displayValue, kebab, packageOf } from './values.ts';

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLines = clean.split(/\r?\n/).slice(0, 10).join('\n');
  const count = (ch: string): number => firstLines.split(ch).length - 1;
  const delimiter = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(field.trim());
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field.trim());
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/* ------------------------------------------------------------------ *
 * Columns
 * ------------------------------------------------------------------ */

export const BOM_FIELDS = ['refs', 'value', 'footprint', 'mpn', 'manufacturer', 'supplierPart', 'quantity', 'dnp'] as const;
export const CPL_FIELDS = ['ref', 'x', 'y', 'side', 'rotation'] as const;
export type BomField = (typeof BOM_FIELDS)[number];
export type CplField = (typeof CPL_FIELDS)[number];

const BOM_NAMES: Record<BomField, RegExp> = {
  refs: /^(designators?|references?|refs?|ref\s*des|part\s*designators?|parts)$/i,
  value: /^(value|comment|val|description|part)$/i,
  footprint: /^(footprint|package|pattern|case|footprint\s*name)$/i,
  mpn: /^(mpn|manufacturer[\s_]*part([\s_]*(number|no\.?|#))?|mfr\.?[\s_]*part([\s_]*(number|no\.?|#))?|mfg[\s_]*part([\s_]*(number|no\.?|#))?|part[\s_]*number|mp)$/i,
  manufacturer: /^(manufacturer|mfr\.?|mfg|manufacturer[\s_]*name|vendor)$/i,
  supplierPart: /^(lcsc([\s_]*(part|#|part[\s_]*(number|#)))?|jlcpcb[\s_]*part([\s_]*#)?|supplier[\s_]*part([\s_]*(number|#))?|mouser([\s_]*(part|#|no))*|digi-?key([\s_]*(part|#|no))*|spn)$/i,
  quantity: /^(qty|quantity|count)$/i,
  dnp: /^(dnp|do\s*not\s*(populate|place)|populate|fitted)$/i,
};

const CPL_NAMES: Record<CplField, RegExp> = {
  ref: /^(designator|ref|reference|refdes|part)$/i,
  x: /^(mid\s*x|posx|pos\s*x|center-?x|x|x\s*\(mm\)|ref\s*x)$/i,
  y: /^(mid\s*y|posy|pos\s*y|center-?y|y|y\s*\(mm\)|ref\s*y)$/i,
  side: /^(layer|side|tb|top\/bottom)$/i,
  rotation: /^(rotation|rot|angle)$/i,
};

/** Which header names which field: `{ refs: 'Designator', value: 'Comment' }`. */
export type ColumnMapping<F extends string> = Partial<Record<F, string>>;

export interface Table {
  header: string[];
  rows: { cells: string[]; line: number }[];
}

/** The header row (the first row naming at least two known columns) and the rows below it. */
export function tableOf(text: string, kind: 'bom' | 'cpl', mapped: readonly string[] = []): Table {
  const rows = parseCsv(text);
  const names = Object.values(kind === 'bom' ? BOM_NAMES : CPL_NAMES);
  // the row naming every mapped column, else the first naming two known ones
  let at = mapped.length === 0 ? -1 : rows.findIndex((r) => mapped.every((m) => r.includes(m)));
  if (at < 0) at = rows.findIndex((r) => r.filter((cell) => names.some((re) => re.test(cell))).length >= 2);
  if (at < 0) {
    // no known names: the first of the widest rows near the top (a title line is narrower than the header)
    const head = rows.slice(0, 20);
    const widest = Math.max(0, ...head.map((r) => r.length));
    at = Math.max(0, head.findIndex((r) => r.length === widest));
  }
  const header = rows[at] ?? [];
  return { header, rows: rows.slice(at + 1).map((cells, k) => ({ cells, line: at + 2 + k })) };
}

export function detectColumns<F extends string>(header: readonly string[], kind: 'bom' | 'cpl'): ColumnMapping<F> {
  const names = (kind === 'bom' ? BOM_NAMES : CPL_NAMES) as Record<string, RegExp>;
  const out: Record<string, string> = {};
  for (const [field, re] of Object.entries(names)) {
    const found = header.find((h) => re.test(h.trim()) && !Object.values(out).includes(h));
    if (found !== undefined) out[field] = found;
  }
  return out as ColumnMapping<F>;
}

/** Is this file a placement file (it has X and Y columns)? */
export function isPlacement(text: string): boolean {
  const { header } = tableOf(text, 'cpl');
  const cols = detectColumns<CplField>(header, 'cpl');
  return cols.x !== undefined && cols.y !== undefined && cols.ref !== undefined;
}

function cell(table: Table, row: { cells: string[] }, column: string | undefined): string | undefined {
  if (column === undefined) return undefined;
  const index = table.header.indexOf(column);
  if (index < 0) return undefined;
  const value = row.cells[index]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `R1, R2, R5-R7` / `R1 R2` → `[R1, R2, R5, R6, R7]`. */
export function splitRefs(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter((p) => p !== '')) {
    const range = /^([A-Za-z_]+)(\d+)[-–]\1?(\d+)$/.exec(part);
    if (range !== null && Number(range[3]) >= Number(range[2]) && Number(range[3]) - Number(range[2]) < 1000) {
      for (let k = Number(range[2]); k <= Number(range[3]); k++) out.push(`${range[1]}${k}`);
    } else out.push(part);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

export interface BomLine {
  refs: string[];
  value?: string;
  footprint?: string;
  mpn?: string;
  manufacturer?: string;
  supplierPart?: string;
  /** the supplier the part-number column names (`LCSC`, `Mouser` …) */
  supplier?: string;
  dnp: boolean;
  line: number;
  /** where the line was read, for a record's `src` (default `line <n>`) */
  where?: string;
  /** KiCad leaves it out of the fab BOM (a footprint attribute) */
  excludeFromBom?: boolean;
}

export interface Placement {
  ref: string;
  x?: number;
  y?: number;
  side?: 'top' | 'bottom';
  rotation?: number;
  line: number;
}

function supplierOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (/lcsc|jlc/i.test(header)) return 'LCSC';
  if (/mouser/i.test(header)) return 'Mouser';
  if (/digi-?key/i.test(header)) return 'Digi-Key';
  return 'Supplier';
}

export function readBom(text: string, mapping: ColumnMapping<BomField> = {}): { lines: BomLine[]; columns: ColumnMapping<BomField>; header: string[] } {
  const table = tableOf(text, 'bom', Object.values(mapping).filter((c): c is string => c !== undefined));
  const columns = { ...detectColumns<BomField>(table.header, 'bom'), ...mapping };
  if (columns.refs === undefined) throw new Error(`No reference-designator column was found in the BOM (its columns: ${table.header.join(', ') || 'none'}); map one in the review step.`);
  const lines: BomLine[] = [];
  for (const row of table.rows) {
    const refs = splitRefs(cell(table, row, columns.refs) ?? '');
    if (refs.length === 0) continue;
    const dnpText = cell(table, row, columns.dnp);
    // a "Populate"/"Fitted" column says no for a part left off; a "DNP" column says yes
    const inverted = /populate|fitted/i.test(columns.dnp ?? '') && !/not/i.test(columns.dnp ?? '');
    const dnp = dnpText !== undefined && (inverted ? /^(no|n|false|0)$/i.test(dnpText) : /^(dnp|yes|y|true|1|x)$/i.test(dnpText));
    const value = cell(table, row, columns.value);
    const footprint = cell(table, row, columns.footprint);
    const mpn = cell(table, row, columns.mpn);
    const manufacturer = cell(table, row, columns.manufacturer);
    const supplierPart = cell(table, row, columns.supplierPart);
    const supplier = supplierOf(columns.supplierPart);
    lines.push({
      refs,
      ...(value === undefined ? {} : { value }),
      ...(footprint === undefined ? {} : { footprint }),
      ...(mpn === undefined ? {} : { mpn }),
      ...(manufacturer === undefined ? {} : { manufacturer }),
      ...(supplierPart === undefined ? {} : { supplierPart }),
      ...(supplier === undefined || supplierPart === undefined ? {} : { supplier }),
      dnp: dnp || /\bDNP\b|do not (populate|place)/i.test(value ?? ''),
      line: row.line,
    });
  }
  return { lines, columns, header: table.header };
}

function number(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const v = Number(text.replace(/mm$|mil$/i, '').trim());
  return Number.isFinite(v) ? (/mil$/i.test(text) ? v * 0.0254 : v) : undefined;
}

export function readPlacement(text: string, mapping: ColumnMapping<CplField> = {}): { placements: Placement[]; columns: ColumnMapping<CplField>; header: string[] } {
  const table = tableOf(text, 'cpl', Object.values(mapping).filter((c): c is string => c !== undefined));
  const columns = { ...detectColumns<CplField>(table.header, 'cpl'), ...mapping };
  if (columns.ref === undefined) throw new Error(`No designator column was found in the placement file (its columns: ${table.header.join(', ') || 'none'}); map one in the review step.`);
  const placements: Placement[] = [];
  for (const row of table.rows) {
    const ref = cell(table, row, columns.ref);
    if (ref === undefined) continue;
    const sideText = cell(table, row, columns.side);
    const side = sideText === undefined ? undefined : /^(b|bot|bottom|back)/i.test(sideText) ? 'bottom' : 'top';
    const x = number(cell(table, row, columns.x));
    const y = number(cell(table, row, columns.y));
    const rotation = number(cell(table, row, columns.rotation));
    placements.push({ ref, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), ...(side === undefined ? {} : { side }), ...(rotation === undefined ? {} : { rotation }), line: row.line });
  }
  return { placements, columns, header: table.header };
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

export interface FabFile {
  fileName: string;
  sha256: string;
  text: string;
}

export interface BoardPartsProposal {
  components: ComponentDefinition[];
  /** components the Library already has that this board places (not proposed again) */
  reused: string[];
  entry: BoardPartsEntry;
  notes: string[];
}

const CATEGORY_WORD: Record<ComponentCategory, string> = {
  resistor: 'resistor',
  capacitor: 'capacitor',
  ic: 'IC',
  regulator: 'regulator',
  jack: 'jack',
  connector: 'connector',
  switch: 'switch',
  jumper: 'jumper',
  diode: 'diode',
  inductor: 'inductor',
  transistor: 'transistor',
  other: 'part',
};

function twoLegs(category: ComponentCategory): boolean {
  return ['resistor', 'capacitor', 'inductor', 'diode', 'jumper'].includes(category);
}

export function boardParts(
  pcba: PcbaDefinition,
  bom: FabFile | undefined,
  cpl: FabFile | undefined,
  db: Pick<Db, 'components'>,
  mapping: { bom?: ColumnMapping<BomField>; cpl?: ColumnMapping<CplField> } = {},
): BoardPartsProposal {
  if (bom === undefined && cpl === undefined) throw new Error('Send a BOM, a placement file, or both.');
  const notes: string[] = [];
  const read = bom === undefined ? undefined : readBom(bom.text, mapping.bom);
  const placed = cpl === undefined ? undefined : readPlacement(cpl.text, mapping.cpl);
  if (read !== undefined) notes.push(`BOM ${bom!.fileName}: ${read.lines.length} line(s); columns ${Object.entries(read.columns).map(([f, c]) => `${f}=${c}`).join(', ')}.`);
  if (placed !== undefined) notes.push(`Placement ${cpl!.fileName}: ${placed.placements.length} part(s); columns ${Object.entries(placed.columns).map(([f, c]) => `${f}=${c}`).join(', ')}.`);
  const placement = new Map((placed?.placements ?? []).map((p) => [p.ref, p]));
  const lines: BomLine[] = read?.lines ?? (placed?.placements ?? []).map((p) => ({ refs: [p.ref], dnp: false, line: p.line }));
  const sources = [
    ...(bom === undefined ? [] : [{ path: bom.fileName, sha256: bom.sha256, role: 'bom' as const }]),
    ...(cpl === undefined ? [] : [{ path: cpl.fileName, sha256: cpl.sha256, role: 'cpl' as const }]),
  ];
  const origin = bom ?? cpl!;
  const proposal = proposeParts(pcba, { lines, placement, sources, notes, origin: { fileName: origin.fileName, sha256: origin.sha256, what: bom === undefined ? 'fab placement file' : 'fab BOM' }, ...(cpl === undefined ? {} : { cplName: cpl.fileName }), hasBom: bom !== undefined }, db);
  if (placed !== undefined && read !== undefined) {
    const inBom = new Set(lines.flatMap((l) => l.refs));
    const extra = placed.placements.filter((p) => !inBom.has(p.ref)).map((p) => p.ref);
    if (extra.length > 0) proposal.notes.push(`${extra.length} part(s) are placed but not in the BOM: ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ' …' : ''}.`);
    const unplaced = [...inBom].filter((r) => !placement.has(r));
    if (unplaced.length > 0) proposal.notes.push(`${unplaced.length} BOM part(s) have no placement: ${unplaced.slice(0, 10).join(', ')}${unplaced.length > 10 ? ' …' : ''} (hand-fitted, or a different revision).`);
  }
  return proposal;
}

/** What `proposeParts` reads: BOM-shaped lines, where each part sits, and where it all came from. */
interface PartsInput {
  lines: BomLine[];
  placement: Map<string, Placement>;
  sources: BoardPartsEntry['sources'];
  notes: string[];
  origin: { fileName: string; sha256: string; what: string };
  /** the placement file's name, when one was read (a part it places carries it) */
  cplName?: string;
  hasBom: boolean;
}

/** One component record per distinct part, and the board's placed parts — the identity rules above, whatever the lines came from. */
function proposeParts(pcba: PcbaDefinition, input: PartsInput, db: Pick<Db, 'components'>): BoardPartsProposal {
  const { lines, placement, sources, notes, origin } = input;
  const bom = input.hasBom ? origin : undefined;
  const cpl = input.cplName === undefined ? undefined : { fileName: input.cplName };
  const components = new Map<string, ComponentDefinition>();
  const reused = new Set<string>();
  const identity = new Map<string, string>();
  const known = (key: string | undefined): ComponentDefinition | undefined => {
    if (key === undefined) return undefined;
    const k = key.toLowerCase();
    return db.components.find((c) => c.mpn?.toLowerCase() === k || (c.suppliers ?? []).some((s) => s.number.toLowerCase() === k));
  };
  const parts: PlacedPart[] = [];
  const boardWord = `${pcba.partNumber} ${pcba.revision}`;
  for (const line of lines) {
    const category = categoryOfRef(line.refs[0]!);
    const value = displayValue(category, line.value);
    const pkg = packageOf(line.footprint);
    const key = line.mpn !== undefined ? `mpn:${line.mpn.toLowerCase()}` : line.supplierPart !== undefined ? `spn:${line.supplierPart.toLowerCase()}` : `cat:${category}|${value ?? ''}|${pkg ?? ''}`;
    let id = identity.get(key);
    if (id === undefined) {
      const existing = known(line.mpn) ?? known(line.supplierPart);
      const compact = value?.replace(/\s+/g, '').replace(/([kMG])Ω/u, '$1').replace(/Ω/u, 'r');
      const fresh = (kebab(line.mpn ?? [category, compact, pkg].filter((w) => w !== undefined).join(' ')).slice(0, 80).replace(/-$/, '') || `part-${line.line}`).replace(/^(\d)/, 'p$1');
      id = existing?.id ?? fresh;
      // two different parts on one id: tell them apart by the line
      if (existing === undefined && [...identity.values()].includes(id)) id = `${id}-${line.line}`;
      identity.set(key, id);
      if (existing !== undefined || db.components.some((c) => c.id === id)) reused.add(id);
      else {
        const suppliers: ComponentSupplierPart[] = line.supplierPart === undefined ? [] : [{ supplier: line.supplier ?? 'Supplier', number: line.supplierPart }];
        const label = [value, CATEGORY_WORD[category], pkg].filter((w) => w !== undefined && w !== '').join(' ');
        components.set(id, {
          id,
          label: line.mpn !== undefined && label === CATEGORY_WORD[category] ? `${line.mpn} ${label}` : label || line.mpn || id,
          kind: componentKindOf(category),
          category,
          ...(value === undefined ? {} : { value }),
          ...(pkg === undefined ? {} : { package: pkg }),
          ...(line.mpn === undefined ? {} : { mpn: line.mpn }),
          ...(line.manufacturer === undefined ? {} : { manufacturer: line.manufacturer }),
          ...(suppliers.length === 0 ? {} : { suppliers }),
          ...(line.footprint === undefined ? {} : { footprint: line.footprint }),
          terminals: twoLegs(category) ? [{ id: 'a' }, { id: 'b' }] : [],
          usedOn: [],
          review: `imported from ${boardWord}'s ${origin.fileName} — review`,
          src: `${origin.fileName} ${line.where ?? `line ${line.line}`} (${origin.what}, sha256 ${origin.sha256.slice(0, 16)}…), read by the board-import module; category from the reference designator — inferred`,
        });
      }
    }
    const record = components.get(id);
    if (record !== undefined) {
      const uses = record.usedOn!;
      const use = uses.find((u) => u.board === pcba.partNumber && u.revision === pcba.revision) ?? (uses.push({ board: pcba.partNumber, revision: pcba.revision, refs: [] }), uses[uses.length - 1]!);
      for (const ref of line.refs) if (!use.refs.includes(ref)) use.refs.push(ref);
      use.refs.sort(compareRefs);
    }
    for (const ref of line.refs) {
      const at = placement.get(ref);
      parts.push({
        ref,
        component: id,
        ...(line.value === undefined ? {} : { value: line.value }),
        ...(line.footprint === undefined ? {} : { footprint: line.footprint }),
        ...(at?.side === undefined ? {} : { side: at.side }),
        ...(line.dnp ? { dnp: true } : {}),
        ...(line.excludeFromBom === true ? { excludeFromBom: true } : {}),
        ...(at === undefined || cpl === undefined ? {} : { cpl: [cpl.fileName] }),
        src: `${origin.fileName}:${line.where ?? line.line}${at === undefined || bom === undefined || cpl === undefined ? '' : `; ${cpl.fileName}:${at.line}`}`,
      });
    }
  }
  if (reused.size > 0) notes.push(`${reused.size} part(s) are already in the Library and are reused: ${[...reused].sort().join(', ')}.`);
  parts.sort((a, b) => compareRefs(a.ref, b.ref));
  return {
    components: [...components.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    reused: [...reused].sort(),
    entry: {
      board: pcba.partNumber,
      revision: pcba.revision,
      sources,
      parts,
      src: `${sources.map((s) => s.path).join(' and ')}, read by the board-import module for ${pcba.id}`,
    },
    notes,
  };
}


/* ------------------------------------------------------------------ *
 * From a KiCad board's footprints
 * ------------------------------------------------------------------ */

const PROPERTY_FIELDS = ['mpn', 'manufacturer', 'supplierPart'] as const;

/** The footprint's property whose name is that of a BOM column (`MPN`, `Manufacturer`, `LCSC Part #` …). */
function propertyOf(properties: Record<string, string>, field: (typeof PROPERTY_FIELDS)[number]): { value: string; name: string } | undefined {
  for (const [name, value] of Object.entries(properties)) {
    if (value.trim() !== '' && value.trim() !== '~' && BOM_NAMES[field].test(name.trim())) return { value: value.trim(), name };
  }
  return undefined;
}

/**
 * A `.kicad_pcb`'s (or `.net`'s) footprints as BOM lines and placements — the
 * same parts a fab BOM would list, for a board with no fab BOM. A footprint
 * flagged board-only (a fiducial, a mounting hole) is not a part; one that is
 * Do Not Populate or left out of the BOM is kept and says so. The part's
 * MPN, manufacturer and supplier number come from the footprint's properties
 * named as a BOM column is.
 */
export function footprintLines(source: BoardSource): { lines: BomLine[]; placement: Map<string, Placement>; skipped: string[] } {
  const lines: BomLine[] = [];
  const placement = new Map<string, Placement>();
  const skipped: string[] = [];
  source.footprints.forEach((fp, index) => {
    if (fp.ref === '' || fp.ref.startsWith('#')) return;
    if (fp.boardOnly) {
      skipped.push(fp.ref);
      return;
    }
    const mpn = propertyOf(fp.properties, 'mpn');
    const manufacturer = propertyOf(fp.properties, 'manufacturer');
    const supplierPart = propertyOf(fp.properties, 'supplierPart');
    const supplier = supplierPart === undefined ? undefined : supplierOf(supplierPart.name);
    const value = fp.value === undefined || fp.value.trim() === '' || fp.value.trim() === '~' ? undefined : fp.value.trim();
    lines.push({
      refs: [fp.ref],
      ...(value === undefined ? {} : { value }),
      ...(fp.lib === '' ? {} : { footprint: fp.lib }),
      ...(mpn === undefined ? {} : { mpn: mpn.value }),
      ...(manufacturer === undefined ? {} : { manufacturer: manufacturer.value }),
      ...(supplierPart === undefined ? {} : { supplierPart: supplierPart.value }),
      ...(supplier === undefined ? {} : { supplier }),
      dnp: fp.dnp || /\bDNP\b|do not (populate|place)/i.test(value ?? ''),
      ...(fp.excludeFromBom ? { excludeFromBom: true } : {}),
      line: index + 1,
      where: `footprint ${fp.ref}`,
    });
    placement.set(fp.ref, {
      ref: fp.ref,
      ...(fp.x === undefined ? {} : { x: fp.x }),
      ...(fp.y === undefined ? {} : { y: fp.y }),
      side: fp.side,
      ...(fp.rotation === undefined ? {} : { rotation: fp.rotation }),
      line: index + 1,
    });
  });
  return { lines, placement, skipped };
}

/**
 * Components and the board's placed parts from a KiCad file's footprints
 * (the `kicad-board` importer's `parts` option): `boardParts`' identity rules
 * over footprint lines — one record per MPN, else supplier number, else
 * category + value + package; one the Library already has is reused.
 */
export function boardPartsFromKicad(pcba: PcbaDefinition, source: BoardSource, file: { fileName: string; sha256: string }, db: Pick<Db, 'components'>): BoardPartsProposal {
  const { lines, placement, skipped } = footprintLines(source);
  if (lines.length === 0) throw new Error(`${file.fileName} has no footprints to read parts from.`);
  const notes = [`Footprints of ${file.fileName}: ${lines.length} part(s)${skipped.length === 0 ? '' : `, ${skipped.length} board-only footprint(s) left out (${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''})`}.`];
  const dnp = lines.filter((l) => l.dnp).length;
  if (dnp > 0) notes.push(`${dnp} part(s) are marked Do Not Populate.`);
  const proposal = proposeParts(
    pcba,
    {
      lines,
      placement,
      sources: [{ path: file.fileName, sha256: file.sha256, role: 'kicad' }],
      notes,
      origin: { ...file, what: `KiCad ${source.format === 'kicad-pcb' ? 'board' : 'netlist'}` },
      hasBom: false,
    },
    db,
  );
  proposal.notes.push('Read from the footprints, not a fab BOM: a part without an MPN is told apart by category, value and package only. Import the fab BOM to replace this with the board house\'s own list.');
  return proposal;
}
