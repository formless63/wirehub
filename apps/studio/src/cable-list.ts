/**
 * The cable list's per-design row, and the pure computation that produces it.
 *
 * `DesignSummary` (`@wirehub/editor-react`) is just `{ id, label }` —
 * enough for a picker, not enough for `/cables`' columns (destination, wire,
 * boards, parts, joints). This is a studio-local shape, computed here so the
 * server (`server/api.ts`, real designs) and the browser (the browser-path
 * tests' in-memory catalog) produce identical rows from the same rule.
 *
 * Pure and IO-free on purpose: both a Node server module and a Vite-bundled
 * browser module import this file directly.
 */

import {
  canonicalPartNumber,
  designStatus,
  findConnector,
  findInterface,
  findPcba,
  findWire,
  wireDisplayName,
  wireEndsOf,
  type CableDesign,
  type Db,
  type DesignStatus,
} from '@wirehub/model';

/** A design's own product PN as the list shows it, and why. */
export interface ResolvedPartNumber {
  /** absent when nothing resolves; the row shows `—`, never a guess */
  pn?: string;
  /** where it came from: `productRef`, `drawing`, `none` */
  basis: 'productRef' | 'drawing' | 'none';
  /** why, for the cell's tooltip */
  note: string;
  /** a length family the drawing names (`CBL-00012-XX`); never set alongside `pn` */
  family?: string;
}

export interface CableListEntry {
  id: string;
  label: string;
  /** production status — `active` when the design sets none (model `designStatus`) */
  status: DesignStatus;
  /** the label's text before " → " */
  source: string;
  /** the label's text after " → ", in full */
  destination: string;
  /** `destination`'s first comma-separated token — the chip/column value */
  destinationMain: string;
  /**
   * The destination end's short name: a bare plug's interface short name
   * (`RJ45`), else the label's own when short. `destination` is the tooltip.
   */
  destinationShort: string;
  /**
   * The trunk stock(s), short — **never the manufacturer name**
   * (`wireDisplayName`). `vendor` carries the maker for search only — never
   * rendered.
   */
  wires: { name: string; vendor?: string; title: string }[];
  /** derived feature chips: `+ Breakout`, `+ 2 legs` */
  features: { text: string; title: string }[];
  /** a board sits at the source end of the trunk; absent when the design has no trunk */
  sourceBoard?: boolean;
  /** one human name per distinct wire stock used, in instance order */
  wireLabels: string[];
  /** one "`partNumber` r`revision`" per distinct board used, in instance order */
  boardLabels: string[];
  partCount: number;
  jointCount: number;
  /** the saved revision the working copy is based on; absent when none is saved */
  rev?: number;
  /** the working copy differs from the revision it is based on (or nothing is saved yet) */
  unreleased?: boolean;
  /**
   * Every part number the cable answers to, for the list's and Quick open's
   * search: the design's own, the drawing's PN as written (a family too),
   * each length's variation PN, and the PN of every part it is built from.
   */
  partNumbers: string[];
  /** the design's own product PN — `designPartNumber` */
  partNumber: ResolvedPartNumber;
}

/** What a cable's part numbers come from besides the design: its drawing sidecar. */
export interface CableListPnContext {
  /** the drawing sidecar's title-block PN and lengths (`DrawingMeta`) */
  drawing?: { partNumber?: string; lengths?: readonly { suffix: string }[]; materials?: Readonly<Record<string, string>> };
}

/** Everything a list row reads besides the design and the db — all optional: a row degrades to the label's text. */
export interface CableListContext extends CableListPnContext {
  /** stock id → vendor label, for search only */
  wireVendors?: Readonly<Record<string, string>>;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function splitLabel(label: string): { source: string; destination: string } {
  const at = label.indexOf(' → ');
  if (at === -1) return { source: label, destination: '' };
  return { source: label.slice(0, at), destination: label.slice(at + 3) };
}

/** "Shielded 4-core (WIR-00012)" → "Shielded 4-core" — the part number is in its own column. */
function shortWireName(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** "PCA-00007", "Rev0" → "PCA-00007 r0". */
function boardName(partNumber: string, revision: string): string {
  return `${partNumber} r${revision.replace(/^rev/i, '')}`;
}

/** A length family: the PN's last group is an `X` placeholder (`CBL-00012-XX`, `…-3X`). */
const FAMILY = /^(.+)-[0-9X]?X$/i;

/**
 * A drawing's variation PNs: its family stem with each length's suffix
 * (`CBL-00012-XX` + `-06` → `CBL-00012-06`). The family is notation only —
 * each length is the published number.
 */
export function variationPartNumbers(partNumber: string | undefined, lengths: readonly { suffix: string }[] | undefined): string[] {
  const m = FAMILY.exec(partNumber?.trim() ?? '');
  if (m === null || lengths === undefined) return [];
  return lengths
    .map((l) => l.suffix.trim())
    .filter((s) => /^-?[A-Z0-9]{1,3}$/i.test(s))
    .map((s) => `${(m[1] as string).toUpperCase()}-${s.replace(/^-/, '').toUpperCase()}`);
}

/**
 * The design's own product PN: its `productRef`, else a fully specified
 * drawing title-block PN (a family notation does not count — it is reported
 * as `family`), else none.
 */
export function designPartNumber(design: Pick<CableDesign, 'id' | 'productRef'>, context: CableListPnContext = {}): ResolvedPartNumber {
  const own = design.productRef?.trim();
  if (own !== undefined && own !== '') return { pn: canonicalPartNumber(own) ?? own, basis: 'productRef', note: 'the design’s productRef' };
  const drawing = context.drawing?.partNumber?.trim();
  if (drawing !== undefined && drawing !== '') {
    if (FAMILY.test(drawing)) return { basis: 'none', note: 'the drawing names a length family; each length is its own number', family: drawing.toUpperCase() };
    return { pn: canonicalPartNumber(drawing) ?? drawing, basis: 'drawing', note: 'the drawing title block' };
  }
  return { basis: 'none', note: 'no part number recorded' };
}

/** Every PN a design answers to — see `CableListEntry.partNumbers`. */
export function designPartNumbers(design: CableDesign, db: Db, context: CableListPnContext = {}): string[] {
  const out: string[] = [];
  const add = (pn: string | undefined): void => {
    const t = pn?.trim();
    if (t !== undefined && t !== '') out.push(t.toUpperCase());
  };
  add(designPartNumber(design, context).pn);
  add(context.drawing?.partNumber);
  for (const pn of variationPartNumbers(context.drawing?.partNumber, context.drawing?.lengths)) add(pn);
  for (const text of Object.values(context.drawing?.materials ?? {})) if (/\d/.test(text) && !/\s/.test(text.trim())) add(text);
  for (const c of design.instances.connectors) add(db.connectors.find((d) => d.id === c.def)?.partNumber);
  for (const s of design.instances.segments) add(db.wires.find((d) => d.id === s.def)?.partNumber);
  for (const c of design.instances.components) add(db.components.find((d) => d.id === c.def)?.partNumber);
  for (const p of design.instances.pcbas) add(findPcba(db, p.def)?.partNumber);
  for (const m of design.instances.mechanical ?? []) add((db.mechanicals ?? []).find((d) => d.id === m.def)?.partNumber);
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ *
 * Derived columns
 * ------------------------------------------------------------------ */

/** The trunk: the longest segment (ties: the first); none for a design with no segments. */
function trunkSegments(design: CableDesign): string[] {
  let best: { id: string; mm: number } | undefined;
  for (const s of design.instances.segments) {
    const mm = s.lengthMm ?? 0;
    if (best === undefined || mm > best.mm) best = { id: s.id, mm };
  }
  return best === undefined ? [] : [best.id];
}

/** Those of `ids` soldered to the trunk's `end` end. */
function onTrunkEnd(design: CableDesign, trunk: readonly string[], ids: readonly string[], end: 'a' | 'b'): string[] {
  return ids.filter((id) => wireEndsOf(design, id).some((w) => w.end === end && trunk.includes(w.segment)));
}

/** A connector's interface short name. */
function interfaceShort(db: Db, connectorDef: string): string | undefined {
  const connector = findConnector(db, connectorDef);
  if (connector?.interface === undefined) return undefined;
  return findInterface(db, connector.interface)?.short;
}

function destinationShortOf(design: CableDesign, db: Db, destination: string, trunk: readonly string[]): string {
  if (destination !== '' && destination.length <= 16) return destination;
  for (const id of onTrunkEnd(design, trunk, design.instances.connectors.map((c) => c.id), 'b')) {
    const def = design.instances.connectors.find((c) => c.id === id)?.def;
    const short = def === undefined ? undefined : interfaceShort(db, def);
    if (short !== undefined) return short;
  }
  return destination;
}

function wiresOf(design: CableDesign, db: Db, ctx: CableListContext, trunk: readonly string[]): CableListEntry['wires'] {
  const defs = dedupe(design.instances.segments.filter((s) => trunk.includes(s.id)).map((s) => s.def));
  return defs.map((def) => {
    const wire = findWire(db, def);
    const name = wire === undefined ? def : wireDisplayName(db, def);
    const vendor = ctx.wireVendors?.[def];
    const title = [wire === undefined ? def : shortWireName(wire.label), wire?.partNumber].filter((t) => t !== undefined).join(' · ');
    return { name, ...(vendor === undefined ? {} : { vendor }), title };
  });
}

function featuresOf(design: CableDesign, trunk: readonly string[]): CableListEntry['features'] {
  const out: CableListEntry['features'] = [];
  const breakouts = design.instances.breakouts ?? [];
  if (breakouts.length > 0) out.push({ text: '+ Breakout', title: `${breakouts.length} breakout${breakouts.length === 1 ? '' : 's'}: ${breakouts.map((b) => b.role ?? b.id).join(', ')}` });
  const legs = design.instances.segments.filter((s) => !trunk.includes(s.id));
  if (legs.length > 0 && breakouts.length === 0) out.push({ text: `+ ${legs.length} leg${legs.length === 1 ? '' : 's'}`, title: legs.map((s) => s.role ?? s.id).join(', ') });
  const subs = design.instances.subassemblies ?? [];
  if (subs.length > 0) {
    out.push({
      text: `+ ${subs.length} sub-assembl${subs.length === 1 ? 'y' : 'ies'}`,
      title: subs.map((s) => `${s.id}: ${s.def}${s.rev === undefined ? '' : ` Rev ${s.rev}`}`).join(', '),
    });
  }
  return out;
}

/** The "where used" chip: the designs that place this one as a sub-assembly. */
export function usedInFeature(parents: readonly { id: string; instances: readonly string[] }[]): CableListEntry['features'][number] | undefined {
  if (parents.length === 0) return undefined;
  return {
    text: `used in ${parents.length}`,
    title: `placed as a sub-assembly in ${parents.map((p) => `${p.id} (${p.instances.join(', ')})`).join(', ')}`,
  };
}

export function cableListEntry(design: CableDesign, db: Db, context: CableListContext = {}): CableListEntry {
  const { source, destination } = splitLabel(design.label);
  const destinationMain = (destination.split(',')[0] ?? destination).trim();

  const wireLabels = dedupe(design.instances.segments.map((segment) => segment.def)).map((def) => {
    const wire = findWire(db, def);
    return wire === undefined ? def : shortWireName(wire.label);
  });
  const boardLabels = dedupe(design.instances.pcbas.map((pcba) => pcba.def)).map((def) => {
    const pcba = findPcba(db, def);
    return pcba === undefined ? def : boardName(pcba.partNumber, pcba.revision);
  });

  const partCount =
    design.instances.connectors.length +
    design.instances.segments.length +
    design.instances.components.length +
    design.instances.pcbas.length;

  const trunk = trunkSegments(design);
  const sourceBoards = onTrunkEnd(design, trunk, design.instances.pcbas.map((p) => p.id), 'a');

  return {
    id: design.id,
    label: design.label,
    status: designStatus(design),
    source,
    destination,
    destinationMain,
    destinationShort: destinationShortOf(design, db, destinationMain, trunk),
    wires: wiresOf(design, db, context, trunk),
    features: featuresOf(design, trunk),
    ...(trunk.length === 0 ? {} : { sourceBoard: sourceBoards.length > 0 }),
    wireLabels,
    boardLabels,
    partCount,
    jointCount: design.joints.length,
    partNumbers: designPartNumbers(design, db, context),
    partNumber: designPartNumber(design, context),
  };
}
