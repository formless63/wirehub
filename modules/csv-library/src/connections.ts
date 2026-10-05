/**
 * A connection list as a design (cs-8c4): a two-column from/to CSV, one row
 * per connection, each end written `<part>.<pin>` (`J1.3`, `J2:A`). Pure and
 * deterministic; nothing is written until a person reviews the proposal.
 *
 * - **Parts.** A part is a connector instance. Its connector comes from the
 *   `parts` option (JSON: part name → connector id) or, failing that, from
 *   the part name itself when it names a library connector (its id, label or
 *   part number). A part nothing names is listed and its rows are left out —
 *   never guessed.
 * - **Pins.** A pin is the connector's pin id, or its label. One the connector
 *   does not have leaves the row out, with the reason.
 * - **Joints.** Without a `wire` option each row is a direct pin-to-pin joint
 *   (a loopback, a patch, a mating adapter). With `wire` (a library stock id)
 *   the rows are conductors of one segment of that stock: the optional `core`
 *   column names the conductor (its path, colour or 1-based number), else the
 *   next free one in order; `from` lands on end `a`, `to` on end `b`.
 * - **Duplicates** (the same two pins again, either way round) and a pin
 *   joined to itself are listed and left out.
 *
 * Columns are found by their usual names (`from`/`to`, `source`/`destination`,
 * `a`/`b`), plus `core` and `note`; the first row is the header.
 */

import { electricalPaths, resolveElementPath, validateDesign, type CableDesign, type ConnectorDefinition, type Db, type Joint, type WireDefinition } from '@wirehub/model';
import type { ImportResult } from '@wirehub/modules';

import { parseCsv } from './csv.ts';

export interface ConnectionRow {
  /** 1-based line of the file (the header is line 1) */
  row: number;
  from?: string;
  to?: string;
  status: 'joint' | 'skipped';
  problems: string[];
}

export interface ConnectionPart {
  /** the name as the file writes it */
  name: string;
  /** the instance id in the design */
  instance: string;
  /** the connector it resolved to, or undefined when nothing names one */
  connector?: string;
  /** rows that use it */
  rows: number;
}

export interface ConnectionAnalysis {
  rows: ConnectionRow[];
  parts: ConnectionPart[];
  design?: CableDesign;
  notes: string[];
}

export interface ConnectionOptions {
  /** the design's id (default: the file's name) */
  design?: string;
  label?: string;
  /** part name → connector id */
  parts?: Readonly<Record<string, string>>;
  /** a library wire stock id */
  wire?: string;
}

const FROM = /^(from|source|src|a|start|end[\s_-]*a|from[\s_-]*pin|pin[\s_-]*a)$/i;
const TO = /^(to|destination|dest|b|end|end[\s_-]*b|to[\s_-]*pin|pin[\s_-]*b)$/i;
const CORE = /^(core|wire|conductor|colou?r)$/i;
const NOTE = /^(note|notes|comment|signal)$/i;

const kebab = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** `J1.3` → part `J1`, pin `3`; `J2:A.1` splits at the colon. */
export function splitEnd(cell: string): { part: string; pin: string } | undefined {
  const text = cell.trim();
  const at = text.includes(':') ? text.indexOf(':') : text.lastIndexOf('.');
  if (at <= 0 || at === text.length - 1) return undefined;
  return { part: text.slice(0, at).trim(), pin: text.slice(at + 1).trim() };
}

function connectorNamed(db: Pick<Db, 'connectors'>, name: string): ConnectorDefinition | undefined {
  const k = name.trim().toLowerCase();
  return db.connectors.find((c) => c.id === k || c.id === kebab(name)) ?? db.connectors.find((c) => c.label.toLowerCase() === k || (c.partNumber ?? '').toLowerCase() === k);
}

function pinOf(connector: ConnectorDefinition, ref: string): string | undefined {
  return connector.pins.find((p) => p.id === ref)?.id ?? connector.pins.find((p) => p.label.toLowerCase() === ref.toLowerCase())?.id;
}

/** The conductor a `core` cell names on a stock: a path, a colour, or a 1-based number. */
function conductorOf(wire: WireDefinition, paths: readonly string[], ref: string): string | undefined {
  const k = ref.trim();
  if (paths.includes(k)) return k;
  const byColour = paths.filter((p) => {
    const el = resolveElementPath(wire.structure, p) as { color?: string } | undefined;
    return el?.color !== undefined && el.color.toLowerCase() === k.toLowerCase();
  });
  if (byColour.length === 1) return byColour[0];
  return /^\d+$/.test(k) ? paths[Number(k) - 1] : undefined;
}

export function analyseConnections(fileName: string, input: string | Uint8Array, db: Db, options: ConnectionOptions = {}): ConnectionAnalysis {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const table = parseCsv(text);
  const notes: string[] = [];
  const header = table[0] ?? [];
  const find = (re: RegExp): number => header.findIndex((h) => re.test(h.trim()));
  const fromAt = find(FROM);
  const toAt = find(TO);
  if (fromAt < 0 || toAt < 0) throw new Error(`${fileName} needs a from column and a to column (its header: ${header.join(', ') || 'none'}).`);
  const coreAt = find(CORE);
  const noteAt = find(NOTE);

  const wire = options.wire === undefined ? undefined : db.wires.find((w) => w.id === options.wire);
  if (options.wire !== undefined && wire === undefined) throw new Error(`There is no wire stock '${options.wire}' in the library.`);
  const paths = wire === undefined ? [] : electricalPaths(wire.structure);

  const parts = new Map<string, ConnectionPart & { def?: ConnectorDefinition }>();
  const instanceIds = new Set<string>();
  const part = (name: string): ConnectionPart & { def?: ConnectorDefinition } => {
    const known = parts.get(name);
    if (known !== undefined) return known;
    let instance = kebab(name) || 'part';
    for (let n = 2; instanceIds.has(instance); n += 1) instance = `${kebab(name) || 'part'}-${n}`;
    instanceIds.add(instance);
    const wanted = options.parts?.[name];
    const def = wanted === undefined ? connectorNamed(db, name) : db.connectors.find((c) => c.id === wanted);
    const made = { name, instance, rows: 0, ...(def === undefined ? {} : { connector: def.id, def }) };
    parts.set(name, made);
    return made;
  };

  const rows: ConnectionRow[] = [];
  const joints: Joint[] = [];
  const seen = new Set<string>();
  const usedPaths = new Set<string>();
  const usedInstances: string[] = [];
  const touch = (instance: string): void => {
    if (!usedInstances.includes(instance)) usedInstances.push(instance);
  };

  table.slice(1).forEach((cells, index) => {
    if (cells.every((c) => c.trim() === '')) return;
    const line = index + 2;
    const fromText = (cells[fromAt] ?? '').trim();
    const toText = (cells[toAt] ?? '').trim();
    const result: ConnectionRow = { row: line, ...(fromText === '' ? {} : { from: fromText }), ...(toText === '' ? {} : { to: toText }), status: 'skipped', problems: [] };
    rows.push(result);
    const ends = [fromText, toText].map((t) => (t === '' ? undefined : splitEnd(t)));
    if (ends[0] === undefined || ends[1] === undefined) {
      result.problems.push(`${ends[0] === undefined ? 'from' : 'to'} '${ends[0] === undefined ? fromText : toText}' is not <part>.<pin> (for example J1.3)`);
      return;
    }
    const resolved = ends.map((end) => {
      const p = part(end!.part);
      p.rows += 1;
      if (p.def === undefined) {
        result.problems.push(`part '${end!.part}' is not a library connector: name its connector in the parts option`);
        return undefined;
      }
      const pin = pinOf(p.def, end!.pin);
      if (pin === undefined) {
        result.problems.push(`${p.def.id} has no pin '${end!.pin}'`);
        return undefined;
      }
      return { instance: p.instance, terminal: pin };
    });
    if (resolved[0] === undefined || resolved[1] === undefined) return;
    const [a, b] = resolved as [{ instance: string; terminal: string }, { instance: string; terminal: string }];
    if (a.instance === b.instance && a.terminal === b.terminal) {
      result.problems.push(`${fromText} is joined to itself`);
      return;
    }
    const key = [`${a.instance}.${a.terminal}`, `${b.instance}.${b.terminal}`].sort().join('|');
    if (seen.has(key)) {
      result.problems.push('the same two pins are already joined');
      return;
    }
    const note = (noteAt < 0 ? '' : (cells[noteAt] ?? '')).trim();
    if (wire === undefined) {
      joints.push({ a, b, ...(note === '' ? {} : { note }) });
    } else {
      const coreText = (coreAt < 0 ? '' : (cells[coreAt] ?? '')).trim();
      let path = coreText === '' ? paths.find((p) => !usedPaths.has(p)) : conductorOf(wire, paths, coreText);
      if (path === undefined) {
        result.problems.push(coreText === '' ? `${wire.id} has no conductor left (it has ${paths.length})` : `${wire.id} has no conductor '${coreText}'`);
        return;
      }
      if (usedPaths.has(path)) {
        result.problems.push(`conductor '${path}' of ${wire.id} is already used`);
        return;
      }
      usedPaths.add(path);
      path = path as string;
      joints.push({ a, b: { instance: 'w1', terminal: path, end: 'a' }, ...(note === '' ? {} : { note }) });
      joints.push({ a: { instance: 'w1', terminal: path, end: 'b' }, b });
    }
    seen.add(key);
    touch(a.instance);
    touch(b.instance);
    result.status = 'joint';
  });

  const partList = [...parts.values()].map(({ def: _def, ...rest }) => rest);
  const unresolved = partList.filter((p) => p.connector === undefined).map((p) => p.name);
  if (unresolved.length > 0) notes.push(`${unresolved.length} part(s) name no library connector, so their rows were left out: ${unresolved.join(', ')}.`);
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  if (skipped > 0) {
    notes.push(`${skipped} of ${rows.length} row(s) were left out:`);
    for (const r of rows.filter((x) => x.status === 'skipped').slice(0, 25)) notes.push(`line ${r.row} (${[r.from, r.to].filter((v) => v !== undefined).join(' → ')}) was not imported: ${r.problems.join('; ')}.`);
    if (skipped > 25) notes.push(`… and ${skipped - 25} more.`);
  }
  if (wire === undefined && joints.length > 0) notes.push('The joints are direct pin to pin; name a wire stock (the wire option) to carry them on its conductors.');
  if (joints.length === 0) return { rows, parts: partList, notes };

  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const id = kebab(options.design ?? '') || kebab(stem) || 'connection-list';
  const byInstance = new Map([...parts.values()].filter((p) => p.def !== undefined).map((p) => [p.instance, p]));
  const design: CableDesign = {
    schemaVersion: 4,
    id,
    label: (options.label ?? '').trim() || stem,
    instances: {
      connectors: usedInstances.map((instance) => ({ id: instance, def: byInstance.get(instance)!.connector! })),
      segments: wire === undefined ? [] : [{ id: 'w1', def: wire.id }],
      components: [],
      pcbas: [],
    },
    joints,
    src: `imported from the connection list ${fileName.replace(/^.*[\\/]/, '')} (CSV, from/to pins; parts and pins as the file names them)`,
  };
  for (const issue of validateDesign(design, db)) notes.push(`${issue.severity === 'error' ? 'the design has a problem' : 'design warning'}: ${issue.message}`);
  return { rows, parts: partList, design, notes };
}

function optionsOf(input: { options?: Readonly<Record<string, string>> }): ConnectionOptions {
  const raw = input.options ?? {};
  const text = (name: string): string | undefined => (raw[name]?.trim() === '' ? undefined : raw[name]?.trim());
  let parts: Record<string, string> | undefined;
  if (text('parts') !== undefined) {
    try {
      parts = JSON.parse(text('parts') as string) as Record<string, string>;
    } catch {
      throw new Error('The parts option is not JSON (part name → connector id).');
    }
  }
  return {
    ...(text('design') === undefined ? {} : { design: text('design') as string }),
    ...(text('label') === undefined ? {} : { label: text('label') as string }),
    ...(parts === undefined ? {} : { parts }),
    ...(text('wire') === undefined ? {} : { wire: text('wire') as string }),
  };
}

export function importConnectionList(input: { fileName: string; bytes: Uint8Array; options?: Readonly<Record<string, string>> }, db: Db): ImportResult {
  const analysis = analyseConnections(input.fileName, input.bytes, db, optionsOf(input));
  if (analysis.design === undefined) throw new Error(`${input.fileName} has no usable connection. ${analysis.notes.join(' ')}`.trim());
  return { designs: [analysis.design], notes: [`${analysis.design.joints.length} joint(s) from ${analysis.rows.filter((r) => r.status === 'joint').length} connection(s).`, ...analysis.notes] };
}
