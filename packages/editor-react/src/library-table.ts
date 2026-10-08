/**
 * The Library's tables — pure: which columns a kind
 * shows, each row's cells, sort, filter and search. `panels/LibraryTable.tsx`
 * draws them; this file has no React in it so every rule is tested without a
 * DOM.
 *
 * Every kind has the same frame — **PN · Name · …its key columns… · Used ·
 * Status · Flags** — and the PN is the one `resolvePartPartNumber` answers:
 * the record's own number, a connector's body's, or a plain "—" — never a
 * guess.
 */

import {
  connectorConstruction,
  connectorMountingUsage,
  constructionTag,
  stripMakerSuffix,
  usageCounts,
  type CableDesign,
  type ComponentDefinition,
  type ConnectorDefinition,
  type Db,
  type KitDefinition,
  type MechanicalDefinition,
  type PcbaDefinition,
  type WireDefinition,
} from '@wirehub/model';

import type { DefinitionRecord, LibraryKind } from './definitions.ts';
import { CONSTRUCTION_SHORT, constructionLabel, mountingSummaryText } from './naming.ts';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface LibraryCell {
  /** what the cell reads; '' draws as "—" */
  text: string;
  /** the tooltip */
  title?: string;
  /** a muted cell: an unknown, a waiting PN, "not a product" */
  faint?: boolean;
  /** a small warning dot beside it */
  warning?: string;
  /** what the column sorts by, when not the text */
  sort?: string | number;
}

export interface LibraryColumn {
  id: string;
  /** the header, as the cable list writes it: short, caps in the CSS */
  header: string;
  title?: string;
  /** a CSS grid track / min width, px */
  width: number;
  mono?: boolean;
  numeric?: boolean;
  /** offered as a filter chip */
  facet?: boolean;
  /** off until the viewer turns it on */
  hiddenByDefault?: boolean;
  /** always shown (PN, Name) — not in the column menu */
  fixed?: boolean;
}

export type LibraryFlag = '3D' | 'Art' | 'Photo' | 'Inferred' | 'Importer' | 'Pack' | 'Make' | 'CM' | 'Buy';

export interface LibraryRow {
  kind: LibraryKind;
  id: string;
  /** the name shown (`displayLabel`) */
  label: string;
  /** the label as stored */
  stored: string;
  aliases: string[];
  record: DefinitionRecord;
  readOnly: boolean;
  pn: ResolvedPartNumber;
  used?: number;
  flags: LibraryFlag[];
  /** the installed pack this record came from (read-only here; fork to edit) */
  pack?: { pack: string; version: string };
  /** legacy / retired boards: hidden unless asked for */
  old: boolean;
  cells: Record<string, LibraryCell>;
}

/** What the rows are computed from, beyond the records themselves. */
export interface LibraryTableContext {
  db: Db;
  /**
   * Every design, for the Used column (`definitionUsage`) and a connector's
   * mounting summary (`connectorMountingUsage`, needs
   * `joints` too) — absent: the column reads "—".
   */
  designs?: readonly Pick<CableDesign, 'id' | 'label' | 'instances' | 'joints'>[];
  /** `<kind>/<id>` of every record with a 3D model */
  models?: ReadonlySet<string>;
  /** definition ids with drawn artwork (a depiction) */
  art?: ReadonlySet<string>;
  /** definition ids with a photo */
  photos?: ReadonlySet<string>;
  /** records an installed catalog pack supplied, by id (`DefinitionList.packs`) */
  packs?: Readonly<Record<string, { pack: string; version: string }>>;
}

/* ------------------------------------------------------------------ *
 * Columns
 * ------------------------------------------------------------------ */

const PN: LibraryColumn = { id: 'pn', header: 'PN', title: 'Part number — the record’s or its body’s; never a guess', width: 104, mono: true, fixed: true };
const NAME: LibraryColumn = { id: 'name', header: 'Name', width: 240, fixed: true };
const USED: LibraryColumn = { id: 'used', header: 'Used', title: 'Designs and other definitions that use it', width: 58, numeric: true };
const STATUS: LibraryColumn = { id: 'status', header: 'Status', width: 84, facet: true };
const FLAGS: LibraryColumn = { id: 'flags', header: 'Flags', title: '3D model · drawn art · photo · inferred values · from the importer · from an installed pack · made in house, by a contract manufacturer (CM) or bought in', width: 120, facet: true };
const ID: LibraryColumn = { id: 'id', header: 'Id', width: 150, mono: true, hiddenByDefault: true };

const KIND_COLUMNS: Record<LibraryKind, LibraryColumn[]> = {
  connectors: [
    { id: 'family', header: 'Family', width: 110, facet: true },
    { id: 'gender', header: 'Gender', width: 64, facet: true },
    { id: 'construction', header: 'Construction', title: 'How it is terminated — solder cup, PCB mount …', width: 118, facet: true },
    { id: 'pins', header: 'Pins', width: 44, numeric: true },
    { id: 'body', header: 'Body', width: 150, mono: true },
    { id: 'pinout', header: 'Pinout', width: 170 },
  ],
  components: [
    { id: 'ckind', header: 'Kind', width: 80, facet: true },
    { id: 'value', header: 'Value', width: 80 },
    { id: 'package', header: 'Package', width: 100, facet: true },
    { id: 'terminals', header: 'Terms', title: 'Terminals', width: 50, numeric: true, hiddenByDefault: true },
  ],
  wires: [
    { id: 'tag', header: 'Construction', title: 'The construction tag the design list shows (6+2C, 8C …)', width: 96, facet: true },
    { id: 'conductors', header: 'Cores', title: 'Conductors (cores and groups, bare drains not counted)', width: 52, numeric: true },
    { id: 'od', header: 'OD', title: 'Outside diameter, mm (figure-8: width × height)', width: 84, numeric: true },
    { id: 'lay', header: 'Lay', width: 50, hiddenByDefault: true },
  ],
  pcbas: [
    { id: 'rev', header: 'Rev', width: 50, mono: true },
    { id: 'build', header: 'Build', title: 'The populated build variant', width: 140 },
    { id: 'released', header: 'Released', title: 'The released revision of this board number', width: 80, mono: true },
    { id: 'builds', header: 'Builds', title: 'Build variants of this board revision in the catalog', width: 64, numeric: true },
    { id: 'pads', header: 'Pads', width: 46, numeric: true, hiddenByDefault: true },
  ],
  mechanicals: [
    { id: 'mkind', header: 'Kind', width: 70, facet: true },
    { id: 'rev', header: 'Rev', width: 50, mono: true },
    { id: 'fits', header: 'Fits', title: 'The stock it is printed for', width: 84, facet: true },
  ],
  kits: [{ id: 'parts', header: 'Parts', width: 48, numeric: true }],
};

/** Component fields the table already has a column for (or that are not a column's business). */
const COMPONENT_KNOWN = new Set(['id', 'label', 'kind', 'value', 'partNumber', 'terminals', 'src', 'package', 'footprint', 'aliases']);

/**
 * The columns a kind shows. Components are generic over whatever scalar
 * fields the records carry (the PCBA component import adds its own), each
 * offered in the column menu, off by default.
 */
export function libraryColumns(kind: LibraryKind, records: readonly DefinitionRecord[] = []): LibraryColumn[] {
  const own = [...KIND_COLUMNS[kind]];
  if (kind === 'components') {
    const extra = new Set<string>();
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (!COMPONENT_KNOWN.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) extra.add(key);
      }
    }
    for (const key of [...extra].sort()) own.push({ id: `x:${key}`, header: key, width: 90, hiddenByDefault: true, facet: false });
  }
  // a status only boards have (active / development / legacy / retired / imported)
  return [PN, NAME, ...own, USED, ...(kind === 'pcbas' ? [STATUS] : []), FLAGS, ID];
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** A part's number as the PN column shows it, and why. */
export interface ResolvedPartNumber {
  pn?: string;
  /** why, for the cell's tooltip */
  note: string;
  warning?: string;
  notProduct?: true;
}

/** The record's own number (a kit's SKU), else its connector body's, else none. */
export function resolvePartPartNumber(
  record: { id: string; partNumber?: string; sku?: string },
  options: { bodyPartNumber?: string; bodyId?: string } = {},
): ResolvedPartNumber {
  const own = record.partNumber ?? record.sku;
  if (own !== undefined && own.trim() !== '') return { pn: own.trim(), note: 'the record\'s own part number' };
  if (options.bodyPartNumber !== undefined) return { pn: options.bodyPartNumber, note: `the connector body's (${options.bodyId ?? 'body'}) part number` };
  return { note: 'no part number recorded' };
}

/** The PN cell's text and tone — the cable list's `partNumberDisplay`, for a part. */
export function partNumberCell(resolved: ResolvedPartNumber): LibraryCell {
  if (resolved.pn !== undefined) return { text: resolved.pn, title: resolved.note, ...(resolved.warning === undefined ? {} : { warning: resolved.warning }) };
  if (resolved.notProduct === true) return { text: 'not a product', title: resolved.note, faint: true, sort: '~not a product' };
  return { text: '', title: resolved.note, faint: true, sort: '~', ...(resolved.warning === undefined ? {} : { warning: resolved.warning }) };
}

const text = (value: string | undefined): LibraryCell => ({ text: value ?? '' });
const count = (n: number): LibraryCell => ({ text: String(n), sort: n });

const PN_TEXT = String.raw`[A-Z0-9]{1,8}-\d{3,}(?:-[A-Z0-9]{1,3})?`;

/**
 * The name a table row shows: the stored label without
 * the part number repeated in it — the PN is its own column — and, for a
 * wire stock, without the maker (never the manufacturer in
 * a list). Display only: the record, and everything printed from it, keep
 * the stored label, and a search for it still matches.
 */
export function displayLabel(kind: LibraryKind, record: DefinitionRecord): string {
  let label = record.label;
  // a board's " — PCA-00012 Rev4" (the revision has its own column too)
  label = label.replace(new RegExp(String.raw`\s+—\s+${PN_TEXT}\s+(?:Rev\s*\d+|PT\d+)\s*$`, 'i'), '');
  // a parenthetical that is only a PN: " (SHL-00008)"
  label = label.replace(new RegExp(String.raw`\s*\(\s*${PN_TEXT}\s*\)`, 'g'), '');
  // a PN closing a parenthetical: "(bonded stock only, SHL-00021)" → "(bonded stock only)"
  label = label.replace(new RegExp(String.raw`,\s*${PN_TEXT}\s*\)`, 'g'), ')');
  if (kind === 'wires') label = stripMakerSuffix(label, (record as WireDefinition).manufacturer);
  return label.trim() === '' ? record.label : label.trim();
}

/** A record's src says it holds an inferred value (the catalog's convention: flagged inside the src text). */
export function isInferred(src: string | undefined): boolean {
  return src !== undefined && /\binferred\b/i.test(src);
}

function connectorCells(db: Db, c: ConnectorDefinition, designs?: LibraryTableContext['designs']): Record<string, LibraryCell> {
  const body = (db.bodies ?? []).find((b) => b.id === c.body);
  const iface = (db.interfaces ?? []).find((i) => i.id === c.interface);
  const construction = connectorConstruction(c, db.bodies);
  const fromBody = c.construction === undefined && construction !== undefined;
  const inferred = /Construction \([^)]*\):[^.]*INFERRED/.test(`${c.src} ${fromBody ? (body?.src ?? '') : ''}`);
  // mounting summary: how the designs using it are
  // mounted — direct-solder vs board-straddle — beside its construction
  const mounting = designs === undefined ? undefined : connectorMountingUsage(db, designs, c.id);
  return {
    family: text(c.family),
    gender: text(c.gender),
    construction:
      construction === undefined
        ? { text: '', faint: true, title: 'Not known — pick it on the connector (or its body)', sort: '~' }
        : {
            text: CONSTRUCTION_SHORT[construction] ?? constructionLabel(db.vocab, construction),
            title: `${mounting === undefined ? constructionLabel(db.vocab, construction) : mountingSummaryText(constructionLabel(db.vocab, construction), mounting.straddle.length, mounting.direct.length)}${fromBody ? ` — from its body ${c.body}` : ''}${inferred ? ' — inferred' : ''}`,
          },
    pins: count(c.pins.length),
    body: { text: c.body ?? '', ...(body === undefined ? {} : { title: body.label }) },
    pinout: { text: iface?.label ?? c.interface ?? '', ...(c.interface === undefined ? {} : { title: c.interface }) },
  };
}

function componentCells(c: ComponentDefinition): Record<string, LibraryCell> {
  const loose = c as unknown as Record<string, unknown>;
  const pkg = typeof loose['package'] === 'string' ? (loose['package'] as string) : typeof loose['footprint'] === 'string' ? (loose['footprint'] as string) : '';
  const out: Record<string, LibraryCell> = {
    ckind: text(c.kind),
    value: text(c.value),
    package: text(pkg),
    terminals: count(c.terminals.length),
  };
  for (const [key, value] of Object.entries(loose)) {
    if (!COMPONENT_KNOWN.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      out[`x:${key}`] = typeof value === 'number' ? { text: String(value), sort: value } : text(String(value));
    }
  }
  return out;
}

function wireCells(db: Db, w: WireDefinition): Record<string, LibraryCell> {
  void db;
  const tag = constructionTag(w);
  const cores = w.structure.children.filter((child) => child.kind === 'group' || (child.kind === 'conductor' && child.bare !== true)).length;
  const od =
    w.profile !== undefined
      ? { text: `${w.profile.widthMm} × ${w.profile.heightMm}`, sort: w.profile.widthMm, title: 'figure-8, mm' }
      : w.odMm === undefined
        ? { text: '', faint: true, sort: -1 }
        : { text: `Ø ${w.odMm}`, sort: w.odMm, title: 'mm' };
  return {
    tag: tag === undefined ? { text: '', faint: true, title: 'No lay order recorded' } : { text: tag },
    conductors: count(cores),
    od,
    lay: text(w.layOrder === undefined ? '' : w.layOrder.direction.toUpperCase()),
  };
}

function pcbaCells(p: PcbaDefinition, all: readonly PcbaDefinition[]): Record<string, LibraryCell> {
  const same = all.filter((q) => q.partNumber === p.partNumber);
  const released = same.filter((q) => (q.status ?? 'active') === 'active').map((q) => q.revision);
  const releasedRev = [...new Set(released)].sort().at(-1);
  const builds = same.filter((q) => q.revision === p.revision).length;
  return {
    rev: text(p.revision),
    build: text(p.build),
    released: releasedRev === undefined ? { text: '', faint: true, title: 'No active revision in the catalog' } : { text: releasedRev, ...(releasedRev === p.revision ? {} : { title: `This record is ${p.revision}; ${releasedRev} is released` }) },
    builds: count(builds),
    pads: count(p.terminals.length),
  };
}

/** The stock a shell is printed for, from its id / name (`-coax`, `-bonded`). */
export function shellFits(m: MechanicalDefinition): string {
  const t = `${m.id} ${m.label}`.toLowerCase();
  const coax = /-coax\b|— coax|\bcoax\b/.test(t);
  const bonded = /-bonded\b|\bbonded\b/.test(t);
  if (m.kind !== 'shell') return '';
  return coax && bonded ? 'coax / bonded' : coax ? 'coax' : bonded ? 'bonded multi-core' : '';
}

function mechanicalCells(m: MechanicalDefinition): Record<string, LibraryCell> {
  const fits = shellFits(m);
  return {
    mkind: text(m.kind),
    rev: text(m.revision),
    fits: fits === '' ? { text: '', faint: true } : text(fits),
  };
}

function kitCells(k: KitDefinition): Record<string, LibraryCell> {
  return { parts: count(k.contents.length) };
}

function statusOf(kind: LibraryKind, record: DefinitionRecord): string {
  return kind === 'pcbas' ? ((record as PcbaDefinition).status ?? 'active') : '';
}

/**
 * Every row of one kind: `records` (editable) then `generated` (the
 * importer's boards, read-only).
 */
export function libraryRows(
  kind: LibraryKind,
  records: readonly DefinitionRecord[],
  generated: readonly DefinitionRecord[],
  ctx: LibraryTableContext,
): LibraryRow[] {
  const all = [...records.map((r) => ({ record: r, readOnly: false })), ...generated.map((r) => ({ record: r, readOnly: true }))];
  const usageKind = kind;
  const used = ctx.designs === undefined ? undefined : usageCounts(ctx.db, ctx.designs, usageKind, all.map((r) => r.record.id));
  const boards = kind === 'pcbas' ? (all.map((r) => r.record) as PcbaDefinition[]) : [];
  return all.map(({ record, readOnly }) => {
    const connector = kind === 'connectors' ? (record as ConnectorDefinition) : undefined;
    const body = connector === undefined ? undefined : (ctx.db.bodies ?? []).find((b) => b.id === connector.body);
    const pn = resolvePartPartNumber(record as { id: string; partNumber?: string; sku?: string }, {
      ...(body?.partNumber === undefined ? {} : { bodyPartNumber: body.partNumber, bodyId: body.id }),
    });
    const flags: LibraryFlag[] = [];
    if (ctx.models?.has(`${kind}/${record.id}`) === true || (body !== undefined && ctx.models?.has(`bodies/${body.id}`) === true)) flags.push('3D');
    if (ctx.art?.has(record.id) === true) flags.push('Art');
    if (ctx.photos?.has(record.id) === true) flags.push('Photo');
    if (isInferred(record.src)) flags.push('Inferred');
    // how it is sourced (`products.ts` routes): in house, a contract manufacturer, bought in
    const route = (record as { route?: string }).route;
    if (route === 'make') flags.push('Make');
    else if (route === 'contract') flags.push('CM');
    else if (route === 'buy') flags.push('Buy');
    if (readOnly) flags.push('Importer');
    const pack = ctx.packs?.[record.id];
    // first: the narrow Flags column clips from the right, and this one explains why the record is read-only
    if (pack !== undefined) flags.unshift('Pack');
    const status = statusOf(kind, record);
    const own =
      kind === 'connectors'
        ? connectorCells(ctx.db, record as ConnectorDefinition, ctx.designs)
        : kind === 'components'
          ? componentCells(record as ComponentDefinition)
          : kind === 'wires'
            ? wireCells(ctx.db, record as WireDefinition)
            : kind === 'pcbas'
              ? pcbaCells(record as PcbaDefinition, boards)
              : kind === 'mechanicals'
                ? mechanicalCells(record as MechanicalDefinition)
                : kitCells(record as KitDefinition);
    const usedCount = used?.get(record.id);
    const aliases = ((record as { aliases?: unknown }).aliases as string[] | undefined)?.filter((a) => typeof a === 'string') ?? [];
    const shown = displayLabel(kind, record);
    return {
      kind,
      id: record.id,
      label: shown,
      stored: record.label,
      aliases,
      record,
      readOnly,
      pn,
      ...(usedCount === undefined ? {} : { used: usedCount }),
      flags,
      ...(pack === undefined ? {} : { pack }),
      old: kind === 'pcbas' && (status === 'legacy' || status === 'retired'),
      cells: {
        pn: partNumberCell(pn),
        name: { text: shown, title: [record.label, ...(aliases.length === 0 ? [] : [`also: ${aliases.join(' · ')}`])].join('\n') },
        ...own,
        used: usedCount === undefined ? { text: '', faint: true, title: 'Where-used needs the designs', sort: -1 } : { text: String(usedCount), sort: usedCount, faint: usedCount === 0 },
        status: text(status),
        flags: { text: flags.join(' '), sort: flags.length },
        id: text(record.id),
      },
    };
  });
}

/* ------------------------------------------------------------------ *
 * Sort, filter, search
 * ------------------------------------------------------------------ */

export type SortDir = 'asc' | 'desc';
export interface LibrarySort {
  column: string;
  dir: SortDir;
}

/** Blanks last either way; numbers as numbers; text in the reader's collation. */
export function sortRows(rows: readonly LibraryRow[], sort: LibrarySort | undefined): LibraryRow[] {
  if (sort === undefined) return [...rows];
  const key = (row: LibraryRow): string | number | undefined => {
    const cell = row.cells[sort.column];
    if (cell === undefined) return undefined;
    if (cell.sort !== undefined) return cell.sort;
    return cell.text === '' ? undefined : cell.text;
  };
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: key(row) }))
    .sort((a, b) => {
      const blankA = a.key === undefined || a.key === '~' || a.key === -1;
      const blankB = b.key === undefined || b.key === '~' || b.key === -1;
      if (blankA !== blankB) return blankA ? 1 : -1;
      if (blankA && blankB) return a.index - b.index;
      const cmp =
        typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' });
      return cmp === 0 ? a.index - b.index : sign * cmp;
    })
    .map((entry) => entry.row);
}

/** The value a row files under for a facet column (flags: each flag). */
export function facetValues(row: LibraryRow, column: string): string[] {
  if (column === 'flags') return row.flags.length === 0 ? ['none'] : [...row.flags];
  const cell = row.cells[column];
  return [cell === undefined || cell.text === '' ? '—' : cell.text];
}

/** Every value a facet column holds, for its chip's checklist. */
export function facetOptions(rows: readonly LibraryRow[], column: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const value of facetValues(row, column)) seen.add(value);
  return [...seen].sort((a, b) => (a === '—' ? 1 : b === '—' ? -1 : a.localeCompare(b)));
}

/** Search: PN, name, aliases and id — case and spacing ignored. */
export function rowMatches(row: LibraryRow, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (needle === '') return true;
  const hay = [row.pn.pn ?? '', row.label, row.stored, ...row.aliases, row.id].join('\n').toLowerCase().replace(/\s+/g, ' ');
  // every word must be found somewhere
  return needle.split(' ').every((word) => hay.includes(word));
}

/** Rows that pass the search and every facet with something ticked. */
export function filterRows(rows: readonly LibraryRow[], query: string, facets: Readonly<Record<string, readonly string[]>>): LibraryRow[] {
  const active = Object.entries(facets).filter(([, picked]) => picked.length > 0);
  return rows.filter(
    (row) => rowMatches(row, query) && active.every(([column, picked]) => facetValues(row, column).some((value) => picked.includes(value))),
  );
}

/* ------------------------------------------------------------------ *
 * The viewer's column choice — remembered per kind, in this browser
 * ------------------------------------------------------------------ */

const PREFS_KEY = 'cs.library.columns.v1';

export interface ColumnPrefs {
  /** columns turned off (of those on by default) */
  hidden: string[];
  /** columns turned on (of those off by default) */
  shown: string[];
}

export function loadColumnPrefs(kind: LibraryKind): ColumnPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(`${PREFS_KEY}.${kind}`);
    if (raw == null) return { hidden: [], shown: [] };
    const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((x): x is string => typeof x === 'string') : [],
      shown: Array.isArray(parsed.shown) ? parsed.shown.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return { hidden: [], shown: [] };
  }
}

export function saveColumnPrefs(kind: LibraryKind, prefs: ColumnPrefs): void {
  try {
    globalThis.localStorage?.setItem(`${PREFS_KEY}.${kind}`, JSON.stringify(prefs));
  } catch {
    // a private window or blocked storage: the choice lasts this page only
  }
}

/** The columns shown, in order, under the viewer's choice. */
export function visibleColumns(columns: readonly LibraryColumn[], prefs: ColumnPrefs): LibraryColumn[] {
  return columns.filter((c) => c.fixed === true || (c.hiddenByDefault === true ? prefs.shown.includes(c.id) : !prefs.hidden.includes(c.id)));
}

/** Toggle one column in the viewer's choice. */
export function toggleColumn(prefs: ColumnPrefs, column: LibraryColumn): ColumnPrefs {
  if (column.fixed === true) return prefs;
  if (column.hiddenByDefault === true) {
    return prefs.shown.includes(column.id) ? { ...prefs, shown: prefs.shown.filter((x) => x !== column.id) } : { ...prefs, shown: [...prefs.shown, column.id] };
  }
  return prefs.hidden.includes(column.id) ? { ...prefs, hidden: prefs.hidden.filter((x) => x !== column.id) } : { ...prefs, hidden: [...prefs.hidden, column.id] };
}
