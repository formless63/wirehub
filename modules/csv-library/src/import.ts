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

import { isCurrencyCode, KIT_PART_KINDS, validateDb, type ComponentDefinition, type ConnectorDefinition, type Db, type KitDefinition, type KitLine, type KitPartKind, type MechanicalDefinition, type PartCost, type PcbaDefinition, type PcbaInternalLink, type WireDefinition } from '@wirehub/model';
import type { ImportResult } from '@wirehub/modules';

import { parseCsv } from './csv.ts';
import { FIELDS, TYPE_COLUMN, detectKind, fieldFor, kindOfType, type LibraryKind } from './kinds.ts';

type Cells = Record<string, string>;
type AnyRecord = ConnectorDefinition | WireDefinition | ComponentDefinition | MechanicalDefinition | PcbaDefinition | KitDefinition;

export interface RowResult {
  /** 1-based line of the file (the header is line 1) */
  row: number;
  kind?: LibraryKind;
  id?: string;
  /** `update`: update mode, the id exists and the file changes it; `exists`: left as it is */
  status: 'new' | 'exists' | 'update' | 'invalid';
  problems: string[];
  /** for an existing record: the fields where the file differs from what the library has */
  differs: string[];
  /** update mode: each changed field, what the library has now and what the file would make it */
  changes?: { field: string; before: unknown; after: unknown }[];
}

type Records = { connectors: ConnectorDefinition[]; wires: WireDefinition[]; components: ComponentDefinition[]; mechanicals: MechanicalDefinition[]; pcbas: PcbaDefinition[]; kits: KitDefinition[] };

export interface Analysis {
  rows: RowResult[];
  /** new records */
  records: Records;
  /** update mode: the whole record as it would be after the file is applied, for ids the library has */
  updates: Records;
  notes: string[];
}

export interface AnalyseOptions {
  batchSrc?: string;
  kind?: LibraryKind;
  /** diff-and-apply: a row for an id the library has changes that record (blank cells keep what it has) instead of being skipped */
  update?: boolean;
}

const emptyRecords = (): Records => ({ connectors: [], wires: [], components: [], mechanicals: [], pcbas: [], kits: [] });

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

function build(kind: LibraryKind, c: Cells, problems: string[], existing?: AnyRecord): AnyRecord | undefined {
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
          // update mode keeps what a pin carries beyond its label (signal, role, notes); blank labels keep the old ones
          pins: ids.map((pin, i) => {
            const old = (existing as ConnectorDefinition | undefined)?.pins.find((p) => p.id === pin);
            return old === undefined ? { id: pin, label: labels[i] ?? pin } : labels[i] === undefined ? old : { ...old, label: labels[i] as string };
          }),
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
      const keep = raw === '' ? (existing as ComponentDefinition | undefined)?.terminals : undefined;
      const ids = keep !== undefined ? keep.map((t) => t.id) : raw === '' || raw === '2' ? ['a', 'b'] : /^\d+$/.test(raw) ? Array.from({ length: Math.min(Number(raw), 500) }, (_, i) => String(i + 1)) : list(raw);
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
          terminals: ids.map((t) => (existing as ComponentDefinition | undefined)?.terminals.find((o) => o.id === t) ?? { id: t }),
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
    case 'pcbas': {
      const raw = (c['terminals'] ?? '').trim();
      let ids: string[];
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        if (n < 1 || n > 500) problems.push(`terminals '${raw}' is outside 1 to 500`);
        ids = n < 1 || n > 500 ? [] : Array.from({ length: n }, (_, i) => String(i + 1));
      } else ids = list(raw);
      if (new Set(ids).size !== ids.length) problems.push('terminals lists an id twice');
      const labels = list(c['terminal_labels']);
      if (labels.length > 0 && labels.length !== ids.length) problems.push(`terminal_labels has ${labels.length} entries for ${ids.length} terminals`);
      const status = (c['status'] ?? '').trim().toLowerCase();
      if (!['', 'active', 'development', 'legacy', 'retired'].includes(status)) problems.push(`status '${c['status']}' is active, development, legacy or retired`);
      const old = existing as PcbaDefinition | undefined;
      const links: PcbaInternalLink[] = [];
      for (const item of list(c['links'])) {
        const [pair, ...viaParts] = item.split(':');
        const via = viaParts.join(':').trim();
        const ends = (pair ?? '').split('>').map((e) => e.trim());
        if (ends.length !== 2 || ends.some((e) => e === '')) {
          problems.push(`links '${item}' is not from>to or from>to:via`);
          continue;
        }
        const link: PcbaInternalLink = { from: ends[0] as string, to: ends[1] as string, ...(via === '' ? {} : { via }) };
        // an unchanged link keeps its structured path and note
        links.push(old?.internalLinks.find((o) => o.from === link.from && o.to === link.to && o.via === link.via) ?? link);
      }
      return withCost(
        {
          id,
          label,
          partNumber: pn,
          revision: (c['revision'] ?? '').trim(),
          ...opt('build', (c['build'] ?? '').trim()),
          ...opt('kicadProject', (c['kicad_project'] ?? '').trim()),
          terminals: ids.map((t, i) => {
            const was = old?.terminals.find((o) => o.id === t);
            return was === undefined ? { id: t, ...(labels[i] === undefined ? {} : { label: labels[i] as string }) } : labels[i] === undefined ? was : { ...was, label: labels[i] as string };
          }),
          internalLinks: (c['links'] ?? '').trim() === '' && old !== undefined ? old.internalLinks : links,
          ...(status === '' ? {} : { status: status as NonNullable<PcbaDefinition['status']> }),
          src,
        } as PcbaDefinition,
        cost,
      );
    }
    case 'kits': {
      const sku = (c['sku'] ?? '').trim();
      const old = existing as KitDefinition | undefined;
      const contents: KitLine[] = [];
      for (const item of list(c['contents'])) {
        const [partKind, def, qtyText, ...more] = item.split(':').map((s) => s.trim());
        const qty = qtyText === undefined || qtyText === '' ? 1 : Number(qtyText);
        if (more.length > 0 || partKind === undefined || def === undefined || def === '' || !KIT_PART_KINDS.includes(partKind as KitPartKind) || !Number.isInteger(qty) || qty < 1) {
          problems.push(`contents '${item}' is not kind:id or kind:id:quantity (kind is ${KIT_PART_KINDS.join(', ')}; quantity a whole number)`);
          continue;
        }
        const was = old?.contents.find((l) => l.part.kind === partKind && l.part.def === def);
        contents.push(was === undefined ? { part: { kind: partKind as KitPartKind, def }, qty } : { ...was, qty });
      }
      return withCost({ id, label, sku, contents, src } as KitDefinition, cost);
    }
  }
}

const COLLECTION: Record<LibraryKind, 'connectors' | 'wires' | 'components' | 'mechanicals' | 'pcbas' | 'kits'> = { connectors: 'connectors', wires: 'wires', components: 'components', mechanicals: 'mechanicals', pcbas: 'pcbas', kits: 'kits' };

const FLAT_WIRE_KINDS = new Set(['conductor', 'shield']);

/** A stock the columns can describe whole: one cable group of conductors and at most a shield (no pairs, nested groups or drains). */
function isFlatWire(wire: WireDefinition): boolean {
  const s = wire.structure as { kind?: string; children?: { kind?: string }[] };
  return s.kind === 'group' && Array.isArray(s.children) && s.children.every((child) => FLAT_WIRE_KINDS.has(child.kind ?? ''));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The record as it would be once the file's row is applied: the library's record under the fields the row gives. */
function applyRow(kind: LibraryKind, existing: AnyRecord, incoming: AnyRecord, note: (text: string) => void): AnyRecord {
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  if (kind === 'wires' && !isFlatWire(existing as WireDefinition)) {
    merged['structure'] = (existing as WireDefinition).structure;
    note('its structure (pairs, nested groups or a drain wire) is more than the conductor, colour, area, material and shield columns can say, so those columns were left alone.');
  }
  // a changed src alone is not a change; with one, the file's citation replaces the old
  if (Object.keys(merged).every((key) => key === 'src' || same(merged[key], (existing as unknown as Record<string, unknown>)[key]))) merged['src'] = (existing as { src: string }).src;
  return merged as unknown as AnyRecord;
}

function changesOf(existing: AnyRecord, merged: AnyRecord): { field: string; before: unknown; after: unknown }[] {
  const have = existing as unknown as Record<string, unknown>;
  const next = merged as unknown as Record<string, unknown>;
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const key of Object.keys(next)) if (key !== 'src' && !same(have[key], next[key])) out.push({ field: key, before: have[key], after: next[key] });
  if (out.length > 0 && !same(have['src'], next['src'])) out.push({ field: 'src', before: have['src'], after: next['src'] });
  return out;
}

/** Read a canonical CSV against the library: per-row results and the proposed records. */
export function analyseCsv(text: string, db: Db, options: AnalyseOptions = {}): Analysis {
  const rows = parseCsv(text);
  const notes: string[] = [];
  const out: Analysis = { rows: [], records: emptyRecords(), updates: emptyRecords(), notes };
  const header = rows[0];
  if (header === undefined) {
    notes.push('the file is empty.');
    return out;
  }
  const typeIndex = header.findIndex((h) => h.trim().toLowerCase() === TYPE_COLUMN);
  const fileKind = options.kind ?? (typeIndex < 0 ? detectKind(header) : undefined);
  if (typeIndex < 0 && fileKind === undefined) {
    notes.push('the file has no type column and its headers do not say which kind of record it holds: add a type column (connector, wire, component, mechanical, pcba or kit), or use one of the templates.');
    return out;
  }
  const ids = new Map<string, number>();
  const parts = [...db.connectors, ...db.wires, ...db.components, ...db.pcbas, ...(db.mechanicals ?? [])];
  /** the parts share one id space; kits have their own */
  const taken = (kind: LibraryKind, id: string): boolean => (kind === 'kits' ? (db.kits ?? []).some((r) => r.id === id) : parts.some((r) => r.id === id));
  const proposed: { row: RowResult; record: AnyRecord; kind: LibraryKind; existing?: AnyRecord }[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.every((cell) => cell.trim() === '')) return;
    const result: RowResult = { row: line, status: 'invalid', problems: [], differs: [] };
    out.rows.push(result);
    const kind = typeIndex >= 0 ? kindOfType(cells[typeIndex] ?? '') : fileKind;
    if (kind === undefined) {
      result.problems.push(`type '${cells[typeIndex] ?? ''}' is not connector, wire, component, mechanical, pcba or kit`);
      return;
    }
    result.kind = kind;
    const c: Cells = {};
    header.forEach((h, index) => {
      const spec = fieldFor(kind, h);
      if (spec !== undefined && c[spec.key] === undefined) c[spec.key] = cells[index] ?? '';
    });
    if ((c['src'] ?? '').trim() === '' && options.batchSrc !== undefined && options.batchSrc.trim() !== '') c['src'] = options.batchSrc.trim();
    const wanted = (c['id'] ?? '').trim() === '' ? slug((c['label'] ?? '').trim()) : (c['id'] ?? '').trim();
    const existing = options.update === true ? ((db[COLLECTION[kind]] as { id: string }[] | undefined)?.find((r) => r.id === wanted) as AnyRecord | undefined) : undefined;
    const record = build(kind, c, result.problems, existing);
    result.id = record?.id ?? (c['id'] ?? '');
    if (record === undefined || result.problems.length > 0) return;
    const firstAt = ids.get(`${kind === 'kits' ? 'kit' : 'part'}/${record.id}`);
    if (firstAt !== undefined) {
      result.problems.push(`id '${record.id}' is already used on line ${firstAt}`);
      return;
    }
    ids.set(`${kind === 'kits' ? 'kit' : 'part'}/${record.id}`, line);
    if (taken(kind, record.id)) {
      const have = (db[COLLECTION[kind]] as { id: string }[] | undefined)?.find((r) => r.id === record.id) as AnyRecord | undefined;
      if (have === undefined) {
        result.status = 'exists';
        result.problems.push(`id '${record.id}' is taken by a record of another kind`);
        return;
      }
      if (options.update !== true) {
        result.status = 'exists';
        result.differs = differsFrom(have, record);
        return;
      }
      const merged = applyRow(kind, have, record, (note) => notes.push(`line ${line} (${record.id}): ${note}`));
      const changes = changesOf(have, merged);
      result.differs = changes.map((ch) => ch.field);
      if (changes.length === 0) {
        result.status = 'exists';
        return;
      }
      result.status = 'update';
      result.changes = changes;
      proposed.push({ row: result, record: merged, kind, existing: have });
      return;
    }
    result.status = 'new';
    proposed.push({ row: result, record, kind });
  });

  // the rule checks the library applies to every record, on the library with the new ones laid in and the updated ones replaced
  const next = <T extends { id: string }>(current: readonly T[] | undefined, kind: LibraryKind): T[] => {
    const replace = new Map(proposed.filter((p) => p.kind === kind && p.existing !== undefined).map((p) => [p.record.id, p.record as unknown as T]));
    return [...(current ?? []).map((r) => replace.get(r.id) ?? r), ...proposed.filter((p) => p.kind === kind && p.existing === undefined).map((p) => p.record as unknown as T)];
  };
  const merged: Db = {
    ...db,
    connectors: next(db.connectors, 'connectors'),
    wires: next(db.wires, 'wires'),
    components: next(db.components, 'components'),
    mechanicals: next(db.mechanicals, 'mechanicals'),
    pcbas: next(db.pcbas, 'pcbas'),
    kits: next(db.kits, 'kits'),
  };
  // a part number two records share is only a warning in the library, but a bulk import must not add the second
  const issues = validateDb(merged).filter((i) => i.severity === 'error' || i.code === 'pn-duplicate');
  // problems the library already has are not this file's: only an update that does not clear them is held to them
  const before = new Set(validateDb(db).map((i) => `${i.code}|${i.where}|${i.message}`));
  for (const p of proposed) {
    const mine = issues.filter((i) => (i.where === `${p.kind}/${p.record.id}` || (i.where ?? '').startsWith(`${p.kind}/${p.record.id}/`) || i.where === p.record.id) && (p.existing === undefined || !before.has(`${i.code}|${i.where}|${i.message}`)));
    // a duplicate part number or id names both records; only the new one is refused
    if (mine.length > 0) {
      p.row.status = 'invalid';
      p.row.problems.push(...mine.map((i) => i.message));
      delete p.row.changes;
    } else ((p.existing === undefined ? out.records : out.updates)[p.kind] as AnyRecord[]).push(p.record);
  }
  return out;
}

function differsFrom(existing: unknown, incoming: AnyRecord): string[] {
  const have = (existing ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'src') continue;
    if (JSON.stringify(have[key]) !== JSON.stringify(value)) out.push(key);
  }
  return out;
}

/** The importer: proposed records (and, in update mode, the updated ones) and one note per problem row. */
export function importLibraryCsv(fileName: string, bytes: Uint8Array, db: Db, options: Pick<AnalyseOptions, 'batchSrc' | 'update'> = {}): ImportResult {
  return importLibraryText(fileName, new TextDecoder().decode(bytes), db, options);
}

/** `importLibraryCsv` for text already read (a CSV, or the rows of an XLSX sheet written back as CSV). */
export function importLibraryText(fileName: string, text: string, db: Db, options: Pick<AnalyseOptions, 'batchSrc' | 'update'> = {}): ImportResult {
  const analysis = analyseCsv(text, db, options);
  const notes = [...analysis.notes];
  const invalid = analysis.rows.filter((r) => r.status === 'invalid');
  for (const r of invalid) notes.push(`line ${r.row}${r.id === undefined || r.id === '' ? '' : ` (${r.id})`} was not imported: ${r.problems.join('; ')}.`);
  for (const r of analysis.rows.filter((x) => x.status === 'exists')) {
    notes.push(
      options.update === true
        ? `line ${r.row} (${r.id}) is already in the library and the file changes nothing in it.`
        : `line ${r.row} (${r.id}) is already in the library and is left as it is${r.differs.length === 0 ? '' : `; the file differs in ${r.differs.join(', ')}`}.`,
    );
  }
  for (const r of analysis.rows.filter((x) => x.status === 'update')) notes.push(`line ${r.row} (${r.id}) updates ${r.differs.join(', ')}.`);
  const counts = { new: analysis.rows.filter((r) => r.status === 'new').length, exists: analysis.rows.filter((r) => r.status === 'exists').length, update: analysis.rows.filter((r) => r.status === 'update').length };
  notes.unshift(`${fileName}: ${analysis.rows.length} rows, ${counts.new} new, ${options.update === true ? `${counts.update} to update, ${counts.exists} unchanged` : `${counts.exists} already in the library`}, ${invalid.length} invalid.`);
  const defs: NonNullable<ImportResult['definitions']> = {};
  const updates: NonNullable<ImportResult['updates']> = {};
  for (const kind of Object.keys(analysis.records) as LibraryKind[]) {
    if (analysis.records[kind].length > 0) (defs as Record<string, unknown>)[kind] = analysis.records[kind];
    if (analysis.updates[kind].length > 0) (updates as Record<string, unknown>)[kind] = analysis.updates[kind];
  }
  return { definitions: defs, ...(Object.keys(updates).length === 0 ? {} : { updates }), notes };
}
