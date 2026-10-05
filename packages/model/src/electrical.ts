/**
 * Electrical rules: can the copper carry what the pins carry (cs-5k1.15).
 *
 * Three checks over a design, each a **warning** and each skipped when the
 * data it needs is not there — a design that declares no currents gets no
 * output at all:
 *
 * - **gauge vs current** — a conductor's area gives an ampacity (the stock's
 *   own `ratedCurrentA`, else the cited table below); the net's current must
 *   not exceed it;
 * - **contact rating** — a connector's `contactRatingA` against the current
 *   of the net its pin lands on;
 * - **voltage drop** — `I × R × L` over a segment's conductor, `R` from the
 *   stock's `resistanceOhmPerKm`, else the conductor's material and area.
 *
 * Where a current comes from, first match wins, per terminal: the pin's own
 * `currentA`, then the default current of the signal it carries (vocab
 * `signals` `currentA`). A net's current is the largest declared on any of its
 * terminals (they are the same copper). The thresholds are an organisation's
 * to set (`Db.rules.electrical`, kept in the hub settings); the defaults are
 * here. Pure: definitions in, numbers and issues out.
 */

import type { CostingRules } from './cost.ts';
import { deriveNets, type Net } from './nets.ts';
import {
  findConnector,
  findWire,
  type CableDesign,
  type ConductorElement,
  type Db,
  type Issue,
} from './model.ts';
import { elementPaths, resolveElementPath } from './paths.ts';
import { inScope } from './breakouts.ts';
import { signalOf } from './signals.ts';
import { terminalKey } from './validate.ts';
import { vocabEntry, type SignalEntry } from './vocab.ts';

/** One row of the conductor-area to current table. */
export interface AmpacityRow {
  areaMm2: number;
  amps: number;
}

/** An organisation's thresholds; every field optional (the defaults below apply). */
export interface ElectricalRules {
  /** false turns the three checks off */
  enabled?: boolean;
  /** share of the table (or stock) ampacity a conductor may carry, 0 to 1 (default 1) */
  ampacityDerate?: number;
  /** share of a contact's rating it may carry, 0 to 1 (default 1) */
  contactDerate?: number;
  /** largest voltage drop over one conductor, volts (default 0.5) */
  maxDropV?: number;
  /** largest drop as a share of the net's declared voltage, percent (default 5; used only when a voltage is declared) */
  maxDropPct?: number;
  /** replaces the built-in table */
  ampacity?: AmpacityRow[];
}

export const DEFAULT_ELECTRICAL_RULES = {
  enabled: true,
  ampacityDerate: 1,
  contactDerate: 1,
  maxDropV: 0.5,
  maxDropPct: 5,
} as const;

/** The rules a db carries (organisation settings), as an object `Db` can hold. */
export interface DbRules {
  electrical?: ElectricalRules;
  /** currency and labour rate for the BOM cost roll-up (`cost.ts`) */
  costing?: CostingRules;
}

/**
 * Conservative chassis-wiring maximum current by conductor area (single
 * conductor, free air). Values are the commonly published chassis-wiring chart
 * per AWG, rounded, with the AWG's nominal area. INFERRED: a general rule of
 * thumb, not a standard for any one insulation; set the stock's `ratedCurrentA`
 * or replace the table in the hub settings where a datasheet says otherwise.
 */
export const AMPACITY_SRC =
  'chassis-wiring maximum current by AWG (published chart, rounded; inferred rule of thumb, not an insulation-specific rating)';

export const DEFAULT_AMPACITY: readonly AmpacityRow[] = [
  { areaMm2: 0.0507, amps: 0.86 },
  { areaMm2: 0.0804, amps: 1.4 },
  { areaMm2: 0.128, amps: 2.2 },
  { areaMm2: 0.205, amps: 3.5 },
  { areaMm2: 0.326, amps: 7 },
  { areaMm2: 0.519, amps: 11 },
  { areaMm2: 0.823, amps: 16 },
  { areaMm2: 1.31, amps: 22 },
  { areaMm2: 2.08, amps: 32 },
  { areaMm2: 3.31, amps: 41 },
  { areaMm2: 5.26, amps: 55 },
];

/** Resistivity in ohm mm2 / m at 20 C. Annealed copper per IEC 60028; aluminium per its usual 61 percent IACS. */
const RESISTIVITY: readonly [RegExp, number][] = [
  [/alumin/i, 0.0282],
  [/cu|copper|ofc|ofhc/i, 0.017241],
];

function resistivityOf(material: string | undefined): number | undefined {
  // no material named: a wire conductor is copper unless the stock says otherwise
  if (material === undefined || material.trim() === '') return 0.017241;
  return RESISTIVITY.find(([pattern]) => pattern.test(material))?.[1];
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The ampacity the table gives a conductor of `areaMm2`: the next smaller row (conservative), scaled down below the first. */
export function ampacityOfArea(areaMm2: number, table: readonly AmpacityRow[] = DEFAULT_AMPACITY): number | undefined {
  const rows = [...table].filter((r) => positive(r.areaMm2) && positive(r.amps)).sort((a, b) => a.areaMm2 - b.areaMm2);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined || !positive(areaMm2)) return undefined;
  if (areaMm2 < first.areaMm2 * 0.98) return (first.amps * areaMm2) / first.areaMm2;
  if (areaMm2 > last.areaMm2 * 1.02) return undefined; // beyond the table: not guessed
  let chosen = first;
  for (const row of rows) if (row.areaMm2 <= areaMm2 * 1.02) chosen = row;
  return chosen.amps;
}

/** One conductor run carrying a declared current. */
export interface ElectricalRow {
  segment: string;
  conductor: string;
  net: string;
  currentA: number;
  /** the net's declared voltage, when one is */
  voltageV?: number;
  areaMm2?: number;
  lengthMm?: number;
  /** what the conductor may carry (stock rating, or the table, times the derate) */
  ampacityA?: number;
  ampacitySrc?: string;
  /** volts lost over this conductor */
  dropV?: number;
  dropPct?: number;
  ohms?: number;
}

export interface ContactRow {
  connector: string;
  pin: string;
  net: string;
  currentA: number;
  ratingA: number;
}

export interface ElectricalReport {
  rows: ElectricalRow[];
  contacts: ContactRow[];
  issues: Issue[];
}

const EMPTY: ElectricalReport = { rows: [], contacts: [], issues: [] };

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function terminalCurrent(db: Db, kind: 'connector' | 'pcba', def: string, terminal: string): { amps?: number; volts?: number } {
  let amps: number | undefined;
  let volts: number | undefined;
  if (kind === 'connector') {
    const pin = findConnector(db, def)?.pins.find((p) => p.id === terminal);
    if (positive(pin?.currentA)) amps = pin.currentA;
  }
  const signal = signalOf(db, kind, def, terminal)?.signal;
  if (typeof signal === 'string') {
    const entry = vocabEntry<SignalEntry>(db.vocab, 'signals', signal);
    if (amps === undefined && positive(entry?.currentA)) amps = entry.currentA;
    if (positive(entry?.voltageV)) volts = entry.voltageV;
  }
  return { ...(amps === undefined ? {} : { amps }), ...(volts === undefined ? {} : { volts }) };
}

interface NetLoad {
  net: Net;
  amps: number;
  volts?: number;
}

function netLoads(design: CableDesign, db: Db): Map<string, NetLoad> {
  const loads = new Map<string, NetLoad>();
  for (const net of deriveNets(design, db)) {
    let amps: number | undefined;
    let volts: number | undefined;
    for (const t of net.terminals) {
      if (t.instanceKind !== 'connector' && t.instanceKind !== 'pcba') continue;
      const got = terminalCurrent(db, t.instanceKind, t.def, t.terminal);
      if (got.amps !== undefined) amps = Math.max(amps ?? 0, got.amps);
      if (got.volts !== undefined) volts = Math.max(volts ?? 0, got.volts);
    }
    if (amps === undefined) continue;
    const load: NetLoad = { net, amps, ...(volts === undefined ? {} : { volts }) };
    for (const t of net.terminals) loads.set(t.key, load);
  }
  return loads;
}

/**
 * The electrical report of a design: the rows with their numbers (what the
 * continuity spec prints) and the warnings. Empty when no current is declared
 * anywhere or the rules are switched off.
 */
export function electricalReport(design: CableDesign, db: Db): ElectricalReport {
  const rules = { ...DEFAULT_ELECTRICAL_RULES, ...(db.rules?.electrical ?? {}) };
  if (rules.enabled === false) return EMPTY;
  const loads = netLoads(design, db);
  if (loads.size === 0) return EMPTY;
  const table = rules.ampacity !== undefined && rules.ampacity.length > 0 ? rules.ampacity : DEFAULT_AMPACITY;
  const customTable = table !== DEFAULT_AMPACITY;
  const derate = positive(rules.ampacityDerate) ? Math.min(1, rules.ampacityDerate) : 1;
  const contactDerate = positive(rules.contactDerate) ? Math.min(1, rules.contactDerate) : 1;
  const rows: ElectricalRow[] = [];
  const contacts: ContactRow[] = [];
  const issues: Issue[] = [];

  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const entry of elementPaths(wire.structure)) {
      const element = entry.element;
      if (element.kind !== 'conductor' || element.bare === true || !inScope(segment, entry.path)) continue;
      const load = loads.get(terminalKey({ instance: segment.id, terminal: entry.path, end: 'a' })) ?? loads.get(terminalKey({ instance: segment.id, terminal: entry.path, end: 'b' }));
      if (load === undefined) continue;
      const conductor = resolveElementPath(wire.structure, entry.path) as ConductorElement;
      const where = `${segment.id}:${entry.path}`;
      const row: ElectricalRow = { segment: segment.id, conductor: entry.path, net: load.net.id, currentA: load.amps };
      if (load.volts !== undefined) row.voltageV = load.volts;
      if (positive(conductor.areaMm2)) row.areaMm2 = conductor.areaMm2;
      if (positive(segment.lengthMm)) row.lengthMm = segment.lengthMm;

      // gauge vs current
      const stock = positive(conductor.ratedCurrentA) ? conductor.ratedCurrentA : undefined;
      const tabled = stock ?? (row.areaMm2 === undefined ? undefined : ampacityOfArea(row.areaMm2, table));
      if (tabled !== undefined) {
        row.ampacityA = tabled * derate;
        row.ampacitySrc = stock !== undefined ? `the stock's rated current (${wire.id})` : customTable ? 'the hub ampacity table' : AMPACITY_SRC;
        if (load.amps > row.ampacityA + 1e-9) {
          issues.push({
            code: 'conductor-ampacity',
            severity: 'warning',
            where,
            message: `conductor '${entry.path}' of segment '${segment.id}' carries ${fmt(load.amps)} A (${load.net.id}) but ${row.areaMm2 === undefined ? 'the stock is rated' : `${fmt(row.areaMm2)} mm2 is rated`} for ${fmt(row.ampacityA)} A${derate < 1 ? ` (derated to ${Math.round(derate * 100)} percent)` : ''} — ${row.ampacitySrc}`,
          });
        }
      }

      // voltage drop
      const perKm = positive(conductor.resistanceOhmPerKm) ? conductor.resistanceOhmPerKm : undefined;
      const rho = resistivityOf(conductor.material);
      const ohmsPerM = perKm !== undefined ? perKm / 1000 : rho !== undefined && row.areaMm2 !== undefined ? rho / row.areaMm2 : undefined;
      if (ohmsPerM !== undefined && row.lengthMm !== undefined) {
        row.ohms = (ohmsPerM * row.lengthMm) / 1000;
        row.dropV = load.amps * row.ohms;
        if (load.volts !== undefined) row.dropPct = (row.dropV / load.volts) * 100;
        const over: string[] = [];
        if (row.dropV > rules.maxDropV + 1e-9) over.push(`over the ${fmt(rules.maxDropV)} V limit`);
        if (row.dropPct !== undefined && row.dropPct > rules.maxDropPct + 1e-9) over.push(`${fmt(row.dropPct)} percent of ${fmt(load.volts as number)} V, over the ${fmt(rules.maxDropPct)} percent limit`);
        if (over.length > 0) {
          issues.push({
            code: 'voltage-drop',
            severity: 'warning',
            where,
            message: `conductor '${entry.path}' of segment '${segment.id}' drops ${fmt(row.dropV)} V at ${fmt(load.amps)} A over ${fmt(row.lengthMm)} mm (${fmt(row.ohms)} ohm, ${perKm !== undefined ? "the stock's resistance" : `${fmt(rho as number)} ohm mm2/m at 20 C`}): ${over.join('; ')}`,
          });
        }
      }
      rows.push(row);
    }
  }

  // contact rating
  for (const instance of design.instances.connectors) {
    const connector = findConnector(db, instance.def);
    if (!positive(connector?.contactRatingA)) continue;
    for (const pin of connector.pins) {
      const load = loads.get(terminalKey({ instance: instance.id, terminal: pin.id }));
      if (load === undefined) continue;
      const rating = connector.contactRatingA * contactDerate;
      contacts.push({ connector: instance.id, pin: pin.id, net: load.net.id, currentA: load.amps, ratingA: rating });
      if (load.amps > rating + 1e-9) {
        issues.push({
          code: 'contact-rating',
          severity: 'warning',
          where: `${instance.id}:${pin.id}`,
          message: `pin ${pin.id} of '${instance.id}' (${connector.id}) carries ${fmt(load.amps)} A (${load.net.id}) but its contact is rated ${fmt(rating)} A${contactDerate < 1 ? ` (derated to ${Math.round(contactDerate * 100)} percent)` : ''}`,
        });
      }
    }
  }
  return { rows, contacts, issues };
}

/** Just the warnings (`validateDesign` folds these in). */
export function electricalIssues(design: CableDesign, db: Db): Issue[] {
  return electricalReport(design, db).issues;
}

/** Problems with a rules document (settings validation); empty = fine. */
export function electricalRulesProblems(rules: unknown): string[] {
  if (rules === undefined) return [];
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return ['electrical rules must be an object.'];
  const r = rules as Record<string, unknown>;
  const problems: string[] = [];
  const known = ['enabled', 'ampacityDerate', 'contactDerate', 'maxDropV', 'maxDropPct', 'ampacity'];
  for (const key of Object.keys(r)) if (!known.includes(key)) problems.push(`electrical.${key} is not a rule setting.`);
  if (r['enabled'] !== undefined && typeof r['enabled'] !== 'boolean') problems.push('electrical.enabled is true or false.');
  for (const key of ['ampacityDerate', 'contactDerate'] as const) {
    const v = r[key];
    if (v !== undefined && !(positive(v) && v <= 1)) problems.push(`electrical.${key} is a number above 0 and at most 1.`);
  }
  for (const key of ['maxDropV', 'maxDropPct'] as const) {
    const v = r[key];
    if (v !== undefined && !positive(v)) problems.push(`electrical.${key} is a positive number.`);
  }
  if (r['ampacity'] !== undefined) {
    const list = r['ampacity'];
    if (!Array.isArray(list) || list.some((row) => typeof row !== 'object' || row === null || !positive((row as AmpacityRow).areaMm2) || !positive((row as AmpacityRow).amps))) {
      problems.push('electrical.ampacity is a list of { areaMm2, amps } rows with positive numbers.');
    }
  }
  return problems;
}
