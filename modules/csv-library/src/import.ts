/**
 * Bulk library import from CSV (cs-5k1.19): connectors, wire stocks, components
 * and mechanicals, one row per record. Pure and deterministic.
 *
 * The importer reads the canonical columns of `kinds.ts` (a column-mapping step
 * in the app renames a person's own headers to them, `mapping.ts`). Every row
 * needs a `src`; a row without one, or with a bad value, is listed with its
 * reasons and left out, never half-imported. Valid rows become proposed
 * records that go through the import review and are published as one change set;
 * an id the library already has is shown as existing and skipped, never overwritten.
 */

import { isCurrencyCode, validateDb, type ComponentDefinition, type ConnectorDefinition, type Db, type MechanicalDefinition, type PartCost, type WireDefinition } from '@wirehub/model';
import type { ImportResult } from '@wirehub/modules';

import { parseCsv } from './csv.ts';
import { FIELDS, TYPE_COLUMN, detectKind, fieldFor, kindOfType, type LibraryKind } from './kinds.ts';

type Cells = Record<string, string>;
type AnyRecord = ConnectorDefinition | WireDefinition | ComponentDefinition | MechanicalDefinition;

export interface RowResult {
  /** 1-based line of the file (the header is line 1) */
  row: number;
  kind?: LibraryKind;
  id?: string;
  status: 'new' | 'exists' | 'invalid';
  problems: string[];
  /** for an existing record: the fields where the file differs from what the library has */
  differs: string[];
}

export interface Analysis {
  rows: RowResult[];
  records: { connectors: ConnectorDefinition[]; wires: WireDefinition[]; components: ComponentDefinition[]; mechanicals: MechanicalDefinition[] };
  notes: string[];
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slug = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const list = (text: string | undefined): string[] => (text === undefined || text.trim() === '' ? [] : text.split(';').map((s) => s.trim()).filter((s) => s !== ''));
const num = (text: string | undefined): number | undefined | 'bad' => (text === undefined || text.trim() === '' ? undefined : Number.isFinite(Number(text)) ? Number(text) : 'bad');

function costOf(c: Cells, wire: boolean, problems: string[]): PartCost | undefined {
  const unit = num(c['unit_cost']);
  const hasOther = ['currency', 'cost_per', 'cost_breaks', 'moq'].some((k) => (c[k] ?? '').trim() !== '');
  if (unit === undefined) {
    if (hasOther) problems.push('a currency, per, breaks or minimum order needs a unit price');
    return undefined;
  }
  if (unit === 'bad' || unit < 0) {
    problems.push(`unit_cost '${c['unit_cost']}' is not a number, zero or more`);
    return undefined;
  }
  const cost: PartCost = { unit };
  const cur = (c['currency'] ?? '').trim().toUpperCase();
  if (cur !== '') {
    if (isCurrencyCode(cur)) cost.currency = cur;
    else problems.push(`currency '${c['currency']}' is not a three-letter code such as USD`);
  }
  const per = (c['cost_per'] ?? '').trim().toLowerCase();
  if (per !== '') {
    if (per === 'each' || per === 'm') {
      if (per !== (wire ? 'm' : 'each')) cost.per = per;
    } else problems.push(`cost_per '${c['cost_per']}' is each or m`);
  }
  const breaks = list(c['cost_breaks']);
  if (breaks.length > 0) {
    const out: { minQty: number; unit: number }[] = [];
    for (const b of breaks) {
      const [q, p, ...more] = b.split(':');
      const minQty = Number(q);
      const price = Number(p);
      if (more.length > 0 || q === undefined || p === undefined || !(Number.isFinite(minQty) && minQty > 0) || !(Number.isFinite(price) && price >= 0)) problems.push(`cost_breaks '${b}' is not minimum-quantity:price`);
      else out.push({ minQty, unit: price });
    }
    if (out.length > 0) cost.breaks = out.sort((x, y) => x.minQty - y.minQty);
  }
  const moq = num(c['moq']);
  if (moq === 'bad' || (moq !== undefined && moq <= 0)) problems.push(`moq '${c['moq']}' is not a positive number`);
  else if (moq !== undefined) cost.moq = moq;
  return cost;
}

const withCost = <T extends object>(record: T, cost: PartCost | undefined): T => (cost === undefined ? record : { ...record, cost });
const opt = (key: string, value: string | number | undefined): Record<string, string | number> => (value === undefined || value === '' ? {} : { [key]: value });

function build(kind: LibraryKind, c: Cells, problems: string[]): AnyRecord | undefined {
  const label = (c['label'] ?? '').trim();
  const src = (c['src'] ?? '').trim();
  const id = (c['id'] ?? '').trim() === '' ? slug(label) : (c['id'] ?? '').trim();
  if (label === '') problems.push('no name');
  if (src === '') problems.push('no source (src): every record needs a citation');
  if (!KEBAB.test(id)) problems.push(`id '${id}' must be lowercase words joined by hyphens`);
  for (const spec of FIELDS[kind]) if (spec.required && spec.key !== 'label' && spec.key !== 'src' && (c[spec.key] ?? '').trim() === '') problems.push(`no ${spec.key}`);
  const cost = costOf(c, kind === 'wires', problems);
  const pn = (c['part_number'] ?? '').trim();
  switch (kind) {
    case 'connectors': {
      const raw = (c['pins'] ?? '').trim();
      let ids: string[] = [];
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        if (n < 1 || n > 500) problems.push(`pins '${raw}' is outside 1 to 500`);
        else ids = Array.from({ length: n }, (_, i) => String(i + 1));
      } else ids = list(raw);
      if (new Set(ids).size !== ids.length) problems.push('pins lists an id twice');
      const labels = list(c['pin_labels']);
      if (labels.length > 0 && labels.length !== ids.length) problems.push(`pin_labels has ${labels.length} entries for ${ids.length} pins`);
      const rating = num(c['contact_rating_a']);
      if (rating === 'bad' || (rating !== undefined && rating <= 0)) problems.push(`contact_rating_a '${c['contact_rating_a']}' is not a positive number`);
      const aliases = list(c['aliases']);
      return withCost(
        {
          id,
          label,
          family: (c['family'] ?? '').trim(),
          ...opt('gender', (c['gender'] ?? '').trim().toLowerCase()),
          ...opt('partNumber', pn),
          ...opt('construction', (c['construction'] ?? '').trim()),
          ...(typeof rating === 'number' ? { contactRatingA: rating } : {}),
          ...(aliases.length === 0 ? {} : { aliases }),
          pins: ids.map((pin, i) => ({ id: pin, label: labels[i] ?? pin })),
          src,
        } as ConnectorDefinition,
        cost,
      );
    }
    case 'wires': {
      const colours = list(c['colours']);
      const declared = num(c['conductors']);
      if (declared === 'bad' || (declared !== undefined && (!Number.isInteger(declared) || declared < 1 || declared > 200))) problems.push(`conductors '${c['conductors']}' is not a whole number from 1`);
      const n = typeof declared === 'number' ? declared : colours.length;
      if (n === 0) problems.push('no conductors: give a count or a list of colours');
      if (colours.length > 0 && typeof declared === 'number' && colours.length !== declared) problems.push(`colours lists ${colours.length} for ${declared} conductors`);
      const area = num(c['area_mm2']);
      if (area === 'bad' || (area !== undefined && area <= 0)) problems.push(`area_mm2 '${c['area_mm2']}' is not a positive number`);
      const od = num(c['od_mm']);
      if (od === 'bad' || (od !== undefined && od <= 0)) problems.push(`od_mm '${c['od_mm']}' is not a positive number`);
      const shield = (c['shield'] ?? '').trim().toLowerCase();
      if (!['', 'none', 'foil', 'braid', 'spiral', 'tape'].includes(shield)) problems.push(`shield '${c['shield']}' is none, foil, braid, spiral or tape`);
      const material = (c['material'] ?? '').trim();
      return withCost(
        {
          id,
          label,
          ...opt('partNumber', pn),
          ...opt('specRef', (c['spec_ref'] ?? '').trim()),
          ...opt('manufacturer', (c['manufacturer'] ?? '').trim()),
          structure: {
            kind: 'group',
            id,
            label,
            role: 'cable',
            children: [
              ...Array.from({ length: n }, (_, i) => ({
                kind: 'conductor' as const,
                id: `c${i + 1}`,
                ...(colours[i] === undefined ? {} : { color: colours[i] as string }),
                ...(material === '' ? {} : { material }),
                ...(typeof area === 'number' ? { areaMm2: area } : {}),
              })),
              ...(shield === '' || shield === 'none' ? [] : [{ kind: 'shield' as const, id: 'shield', construction: shield as 'foil' | 'braid' | 'spiral' | 'tape' }]),
            ],
          },
          ...(typeof od === 'number' ? { odMm: od } : {}),
          src,
        } as WireDefinition,
        cost,
      );
    }
    case 'components': {
      const raw = (c['terminals'] ?? '').trim();
      const ids = raw === '' || raw === '2' ? ['a', 'b'] : /^\d+$/.test(raw) ? Array.from({ length: Math.min(Number(raw), 500) }, (_, i) => String(i + 1)) : list(raw);
      if (raw !== '' && /^\d+$/.test(raw) && (Number(raw) < 1 || Number(raw) > 500)) problems.push(`terminals '${raw}' is outside 1 to 500`);
      if (new Set(ids).size !== ids.length) problems.push('terminals lists an id twice');
      return withCost(
        {
          id,
          label,
          kind: (c['kind'] ?? '').trim().toLowerCase(),
          ...opt('category', (c['category'] ?? '').trim().toLowerCase()),
          ...opt('value', (c['value'] ?? '').trim()),
          ...opt('partNumber', pn),
          terminals: ids.map((t) => ({ id: t })),
          ...opt('tolerance', (c['tolerance'] ?? '').trim()),
          ...opt('package', (c['package'] ?? '').trim()),
          ...opt('mpn', (c['mpn'] ?? '').trim()),
          ...opt('manufacturer', (c['manufacturer'] ?? '').trim()),
          src,
        } as ComponentDefinition,
        cost,
      );
    }
    case 'mechanicals': {
      const k = (c['kind'] ?? '').trim().toLowerCase();
      if (k !== '' && !['shell', 'fastener', 'other'].includes(k)) problems.push(`kind '${c['kind']}' is shell, fastener or other`);
      return withCost({ id, label, ...opt('partNumber', pn), ...opt('revision', (c['revision'] ?? '').trim()), kind: k as MechanicalDefinition['kind'], src } as MechanicalDefinition, cost);
    }
  }
}

const COLLECTION: Record<LibraryKind, 'connectors' | 'wires' | 'components' | 'mechanicals'> = { connectors: 'connectors', wires: 'wires', components: 'components', mechanicals: 'mechanicals' };

function differsFrom(existing: unknown, incoming: AnyRecord): string[] {
  const have = (existing ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'src') continue;
    if (JSON.stringify(have[key]) !== JSON.stringify(value)) out.push(key);
  }
  return out;
}

/** Read a canonical CSV against the library: per-row results and the proposed records. */
export function analyseCsv(text: string, db: Db, options: { batchSrc?: string; kind?: LibraryKind } = {}): Analysis {
  const rows = parseCsv(text);
  const notes: string[] = [];
  const out: Analysis = { rows: [], records: { connectors: [], wires: [], components: [], mechanicals: [] }, notes };
  const header = rows[0];
  if (header === undefined) {
    notes.push('the file is empty.');
    return out;
  }
  const typeIndex = header.findIndex((h) => h.trim().toLowerCase() === TYPE_COLUMN);
  const fileKind = options.kind ?? (typeIndex < 0 ? detectKind(header) : undefined);
  if (typeIndex < 0 && fileKind === undefined) {
    notes.push('the file has no type column and its headers do not say which kind of record it holds: add a type column (connector, wire, component or mechanical), or use one of the templates.');
    return out;
  }
  const ids = new Map<string, number>();
  const taken = new Set<string>([...db.connectors, ...db.wires, ...db.components, ...db.pcbas, ...(db.mechanicals ?? [])].map((r) => r.id));
  const proposed: { row: RowResult; record: AnyRecord; kind: LibraryKind }[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.every((cell) => cell.trim() === '')) return;
    const result: RowResult = { row: line, status: 'invalid', problems: [], differs: [] };
    out.rows.push(result);
    const kind = typeIndex >= 0 ? kindOfType(cells[typeIndex] ?? '') : fileKind;
    if (kind === undefined) {
      result.problems.push(`type '${cells[typeIndex] ?? ''}' is not connector, wire, component or mechanical`);
      return;
    }
    result.kind = kind;
    const c: Cells = {};
    header.forEach((h, index) => {
      const spec = fieldFor(kind, h);
      if (spec !== undefined && c[spec.key] === undefined) c[spec.key] = cells[index] ?? '';
    });
    if ((c['src'] ?? '').trim() === '' && options.batchSrc !== undefined && options.batchSrc.trim() !== '') c['src'] = options.batchSrc.trim();
    const record = build(kind, c, result.problems);
    result.id = record?.id ?? (c['id'] ?? '');
    if (record === undefined || result.problems.length > 0) return;
    const firstAt = ids.get(record.id);
    if (firstAt !== undefined) {
      result.problems.push(`id '${record.id}' is already used on line ${firstAt}`);
      return;
    }
    ids.set(record.id, line);
    if (taken.has(record.id)) {
      const existing = (db[COLLECTION[kind]] as { id: string }[] | undefined)?.find((r) => r.id === record.id);
      result.status = 'exists';
      if (existing === undefined) result.problems.push(`id '${record.id}' is taken by a record of another kind`);
      else result.differs = differsFrom(existing, record);
      return;
    }
    result.status = 'new';
    proposed.push({ row: result, record, kind });
  });

  // the rule checks the library applies to every record, on the library with the new ones laid in
  const merged: Db = {
    ...db,
    connectors: [...db.connectors, ...proposed.filter((p) => p.kind === 'connectors').map((p) => p.record as ConnectorDefinition)],
    wires: [...db.wires, ...proposed.filter((p) => p.kind === 'wires').map((p) => p.record as WireDefinition)],
    components: [...db.components, ...proposed.filter((p) => p.kind === 'components').map((p) => p.record as ComponentDefinition)],
    mechanicals: [...(db.mechanicals ?? []), ...proposed.filter((p) => p.kind === 'mechanicals').map((p) => p.record as MechanicalDefinition)],
  };
  // a part number two records share is only a warning in the library, but a bulk import must not add the second
  const issues = validateDb(merged).filter((i) => i.severity === 'error' || i.code === 'pn-duplicate');
  for (const p of proposed) {
    const mine = issues.filter((i) => i.where === `${p.kind}/${p.record.id}` || i.where === p.record.id);
    // a duplicate part number or id names both records; only the new one is refused
    if (mine.length > 0) {
      p.row.status = 'invalid';
      p.row.problems.push(...mine.map((i) => i.message));
    } else (out.records[p.kind] as AnyRecord[]).push(p.record);
  }
  return out;
}

/** The importer: proposed records and one note per problem row. */
export function importLibraryCsv(fileName: string, bytes: Uint8Array, db: Db, options: { batchSrc?: string } = {}): ImportResult {
  const analysis = analyseCsv(new TextDecoder().decode(bytes), db, options);
  const notes = [...analysis.notes];
  const invalid = analysis.rows.filter((r) => r.status === 'invalid');
  for (const r of invalid) notes.push(`line ${r.row}${r.id === undefined || r.id === '' ? '' : ` (${r.id})`} was not imported: ${r.problems.join('; ')}.`);
  for (const r of analysis.rows.filter((x) => x.status === 'exists')) {
    notes.push(`line ${r.row} (${r.id}) is already in the library and is left as it is${r.differs.length === 0 ? '' : `; the file differs in ${r.differs.join(', ')}`}.`);
  }
  const counts = countsOf(analysis);
  notes.unshift(`${fileName}: ${analysis.rows.length} rows, ${counts.new} new, ${counts.exists} already in the library, ${invalid.length} invalid.`);
  const defs: NonNullable<ImportResult['definitions']> = {};
  for (const kind of Object.keys(analysis.records) as LibraryKind[]) if (analysis.records[kind].length > 0) (defs as Record<string, unknown>)[kind] = analysis.records[kind];
  return { definitions: defs, notes };
}

function countsOf(a: Analysis): { new: number; exists: number } {
  return { new: a.rows.filter((r) => r.status === 'new').length, exists: a.rows.filter((r) => r.status === 'exists').length };
}
