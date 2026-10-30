/**
 * Where a board record and its KiCad files disagree, per terminal: the net
 * the schematic puts each pad on, the net the board file (`.kicad_pcb`) puts
 * it on, the net the record stored at its last import, and the curated role
 * and signal. No source wins: each row says which of them differ, and a
 * person takes the file's value (Update from file) or keeps the record's.
 *
 * Inputs: the record, the board file as read (`BoardSource`, the same reader
 * the import uses, so "record vs file" is what Update from file would change),
 * and optionally the schematic's nets as the `kicad` tool pack's `netlist` op
 * reports them (`nets.json`, `KicadNets`). Two nets are the same when their
 * names are, or — both unnamed (`Net-(R1-Pad2)`) — when they join the same
 * pads of the parts both sources have.
 *
 * Pure and deterministic.
 */

import { isGroundSignal, readSignalWords, signalOfLane, voltageOfSignal, vocabEntry, type PadRoleEntry, type PcbaDefinition, type PcbaTerminal, type SignalEntry, type Vocab } from '@wirehub/model';

import { deriveBoard } from './derive.ts';
import type { BoardSource } from './kicad.ts';

export const KICAD_NETS_FORMAT = 'wirehub.kicad-nets';

/** The `kicad` pack's `netlist` output (`nets.json`). */
export interface KicadNets {
  format: string;
  version: number;
  pcb?: { file?: string; parts: Record<string, { value?: string; footprint?: string; pads: Record<string, string>; dnp?: boolean }> };
  schematic?: {
    root?: string;
    files?: string[];
    sheets?: string[];
    parts: Record<string, { value?: string; footprint?: string; pins: Record<string, string>; dnp?: boolean; notOnBoard?: boolean }>;
  };
}

/** What differs on one row. */
export type DisagreementKind =
  /** the schematic puts a pad on another net than the board file */
  | 'sch-pcb'
  /** the pad's part is on the board but not in the schematic */
  | 'not-in-sch'
  /** the record stored another net than the board file has now */
  | 'record-pcb'
  /** a terminal of the record the board file does not yield */
  | 'not-in-file'
  /** a terminal the board file yields that the record lacks */
  | 'not-in-record'
  /** the same pads under another name in the file (an alias: quiet, not a disagreement) */
  | 'renamed'
  /** the record's pads are not the pads the file gives the terminal it pairs with (or its id) */
  | 'pads-differ'
  /** the curated signal or role contradicts the board file's net name (another voltage, ground vs not) */
  | 'signal-net'
  /** a curated supply of a stated voltage on a net whose name states none and names no supply (`V_IN`) */
  | 'voltage-unstated';

export interface DisagreementRow {
  /** stable row key: the record's terminal id, else `file:<id>` */
  key: string;
  /** the record's terminal id (absent: only in the file) */
  terminal?: string;
  label?: string;
  /** the file's terminal id, when the file yields one for these pads */
  fileTerminal?: string;
  /** `ref.pad` of each pad behind it */
  pads: string[];
  /** the record's own pads, when they are not `pads` */
  recordPads?: string[];
  /** the pads the file gives this terminal's id, when the row pairs with another file terminal */
  idPads?: string[];
  /** what the signal-net contradiction is: `curated +5 V, net 1.5V` (or, for `voltage-unstated`, `curated +5 V, net V_IN`) */
  contradiction?: string;
  /** distinct nets of its pads in the schematic (undefined: no schematic; [] none) */
  schematic?: string[];
  /** distinct nets of its pads in the board file ([] none) */
  pcb: string[];
  /** the net the record stored at its import */
  record?: string;
  role?: string;
  signal?: string;
  issues: DisagreementKind[];
  /** what the row says, for "keep curated": a kept row comes back once this changes */
  fingerprint: string;
}

export interface PadDisagreement {
  pad: string;
  schematic: string;
  pcb: string;
}

export interface BoardDisagreements {
  rows: DisagreementRow[];
  /** pads behind no terminal whose nets differ between schematic and board file */
  pads: PadDisagreement[];
  /** parts in the schematic with no footprint on the board (not marked off-board) */
  onlySchematic: string[];
  /** footprints with copper on a net that the schematic does not have */
  onlyPcb: string[];
}

/** A net KiCad names itself: `Net-(R1-Pad2)`, `unconnected-(J1-Pad3)`, `N$4`. */
export function isUnnamedNet(net: string): boolean {
  return /^(Net-\(|unconnected-|N\$|\$)/i.test(net);
}

/** A pad on no net: no name, or KiCad's `unconnected-(…)` (the import gives open connector pins that). */
function noNet(net: string | undefined): boolean {
  return net === undefined || net === '' || /^unconnected-/i.test(net);
}

/** The net for display: the root sheet's `/` dropped, no net as `''`. */
export function netText(net: string | undefined): string {
  if (noNet(net)) return '';
  return net!.startsWith('/') && net!.indexOf('/', 1) === -1 ? net!.slice(1) : net!;
}

type PadNets = Map<string, string>;

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function members(nets: PadNets): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [pad, net] of nets) {
    if (noNet(net)) continue;
    if (!out.has(net)) out.set(net, new Set());
    out.get(net)!.add(pad);
  }
  return out;
}

function refOf(pad: string): string {
  return pad.slice(0, pad.lastIndexOf('.'));
}

/** Compares nets of two sources by name, or by the pads they join when both are unnamed. */
function netComparer(a: PadNets, b: PadNets): (x: string | undefined, y: string | undefined) => boolean {
  const ma = members(a);
  const mb = members(b);
  const refsA = new Set([...a.keys()].map(refOf));
  const refsB = new Set([...b.keys()].map(refOf));
  const shared = (pads: Set<string> | undefined, refs: Set<string>): string =>
    [...(pads ?? [])].filter((p) => refs.has(refOf(p))).sort().join('|');
  return (x, y) => {
    if (noNet(x) || noNet(y)) return noNet(x) === noNet(y);
    if (x === y) return true;
    if (!isUnnamedNet(x!) || !isUnnamedNet(y!)) return false;
    return shared(ma.get(x!), refsB) === shared(mb.get(y!), refsA);
  };
}

function signalText(t: PcbaTerminal | undefined): string | undefined {
  const s = t?.signal as unknown;
  if (s === undefined || s === null) return undefined;
  if (typeof s === 'string') return s;
  if (typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string') return (s as { id: string }).id;
  return undefined;
}

function distinct(list: (string | undefined)[]): string[] {
  return [...new Set(list.filter((n) => !noNet(n)) as string[])].sort(natural);
}

/** The record's pads as `ref.pad`: a pad number from its note (`pad 3`), a footprint the note names (`landing pad H6`), the pin its id ends in (`j1.6` on `J1`), else every copper pad of the footprint. */
function recordPads(t: PcbaTerminal, pcb: PadNets, byRef: Map<string, string[]>, alias: (prefix: string) => string | undefined): string[] {
  const out: string[] = [];
  const pin = t.id.includes('.') ? t.id.slice(t.id.lastIndexOf('.') + 1) : undefined;
  for (const p of t.pads ?? []) {
    const n = /(?:^|\s)pad\s+(\S+)/i.exec(p.note ?? '')?.[1];
    if (n !== undefined && (pcb.has(`${p.ref}.${n}`) || !byRef.has(n))) out.push(`${p.ref}.${n}`);
    else if (n !== undefined) out.push(...(byRef.get(n) ?? []));
    else if (pin !== undefined && (byRef.get(p.ref)?.length ?? 0) > 1) out.push(`${p.ref}.${pin}`);
    else out.push(...(byRef.get(p.ref) ?? []));
  }
  // an integrated connector's pin `<prefix>.<pin>`: the footprint whose reference reads as the prefix (or its one alias)
  if (out.length === 0 && pin !== undefined) {
    const prefix = t.id.slice(0, t.id.lastIndexOf('.')).toLowerCase();
    const ref = [...byRef.keys()].find((r) => r.toLowerCase() === prefix) ?? alias(prefix);
    if (ref !== undefined) out.push(`${ref}.${pin}`);
  }
  return [...new Set(out)].sort(natural);
}

/** A voltage a net name gives: `+5V`, `1.5V`, `3V3`, `-12V` → `+5`, `+1.5`, `+3.3`, `-12`. */
function netVoltage(net: string): string | undefined {
  const text = netText(net).toLowerCase();
  const split = /(?:^|[^0-9.])([+-]?)(\d+)v(\d+)(?![0-9])/.exec(text);
  if (split !== null) return `${split[1] === '-' ? '-' : '+'}${Number(`${split[2]}.${split[3]}`)}`;
  const whole = /(?:^|[^0-9.])([+-]?)(\d+(?:\.\d+)?)\s*v(?![a-z0-9])/.exec(text);
  return whole === null ? undefined : `${whole[1] === '-' ? '-' : '+'}${Number(whole[2])}`;
}

const voltText = (v: string): string => `${v} V`;

/**
 * Where the curated signal (or the role's lane signal, read through the vocabulary) contradicts the
 * board file's named net: a supply of one voltage on a net named for another, a ground on a named
 * net that is no ground, a supply or signal on a ground net. Unnamed nets say nothing.
 */
export function signalNetContradiction(vocab: Vocab | undefined, signal: string | undefined, role: string | undefined, nets: readonly string[]): string | undefined {
  const lane = role === undefined ? undefined : vocabEntry<PadRoleEntry>(vocab, 'pad-roles', role)?.lane;
  const curated = signal ?? (lane === undefined ? undefined : signalOfLane(vocab, lane));
  if (curated === undefined) return undefined;
  const named = nets.filter((n) => !noNet(n) && !isUnnamedNet(n));
  if (named.length === 0) return undefined;
  const curatedVolts = voltageOfSignal(vocab, curated);
  const curatedGround = isGroundSignal(vocab, curated);
  for (const net of named) {
    const volts = netVoltage(net);
    const read = readSignalWords(vocab, netText(net));
    const netGround = (read !== undefined && isGroundSignal(vocab, read)) || volts === '+0';
    if (curatedVolts !== undefined && volts !== undefined && volts !== '+0' && volts !== curatedVolts) return `curated ${voltText(curatedVolts)}, net ${netText(net)}`;
    if (curatedGround && !netGround && (volts !== undefined || read !== undefined)) return `curated ground, net ${netText(net)}`;
    if (!curatedGround && netGround) return `curated ${curatedVolts === undefined ? curated : voltText(curatedVolts)}, net ${netText(net)}`;
  }
  return undefined;
}

/** A conventional supply rail name that states no voltage itself: `VCC`, `AVDD`, `VCCIO`, `VBUS`. */
const SUPPLY_RAIL = /^[ad]?v(cc|dd|bus)/i;

/**
 * Where a curated supply of a stated voltage (`+5 V`, from the signal or the role's lane) sits only
 * on nets whose names state no voltage and name no supply the vocabulary or convention knows
 * (`V_IN`, `Net-(U1-Pad4)`): KiCad does not confirm the voltage. Quieter than a contradiction;
 * `undefined` when any net states a voltage or names a supply, or the terminal is on no net.
 */
export function signalNetUnstated(vocab: Vocab | undefined, signal: string | undefined, role: string | undefined, nets: readonly string[]): string | undefined {
  const lane = role === undefined ? undefined : vocabEntry<PadRoleEntry>(vocab, 'pad-roles', role)?.lane;
  const curated = signal ?? (lane === undefined ? undefined : signalOfLane(vocab, lane));
  if (curated === undefined || isGroundSignal(vocab, curated)) return undefined;
  const curatedVolts = voltageOfSignal(vocab, curated);
  if (curatedVolts === undefined) return undefined;
  const on = nets.filter((n) => !noNet(n));
  if (on.length === 0) return undefined;
  for (const net of on) {
    if (isUnnamedNet(net)) continue;
    const name = netText(net);
    if (netVoltage(net) !== undefined || SUPPLY_RAIL.test(name.slice(name.lastIndexOf('/') + 1))) return undefined;
    const read = readSignalWords(vocab, name);
    if (read !== undefined && (vocabEntry<SignalEntry>(vocab, 'signals', read)?.kind === 'power' || isGroundSignal(vocab, read))) return undefined;
  }
  return `curated ${voltText(curatedVolts)}, net ${on.map(netText).join(', ')}`;
}

/** The disagreements between `def` and its board file (and schematic, when given). */
export function boardDisagreements(def: PcbaDefinition, board: BoardSource, nets?: KicadNets, vocab?: Vocab): BoardDisagreements {
  const read = deriveBoard(board, { sha256: '0'.repeat(64), id: def.id });
  const derived = read.pcba;
  const filePads = read.pads;

  // every pad of the board file and of the schematic, `ref.pad` → net
  const pcb: PadNets = new Map();
  const byRef = new Map<string, string[]>();
  for (const fp of board.footprints) {
    if (fp.ref === '' || fp.ref.startsWith('#')) continue;
    for (const pad of fp.pads) {
      if (pad.number === '' || pad.kind === 'np_thru_hole') continue;
      const key = `${fp.ref}.${pad.number}`;
      if (!pcb.has(key) || noNet(pcb.get(key))) pcb.set(key, pad.net ?? '');
      if (!(byRef.get(fp.ref) ?? []).includes(key)) byRef.set(fp.ref, [...(byRef.get(fp.ref) ?? []), key]);
    }
  }
  const schParts = nets?.schematic?.parts;
  const sch: PadNets | undefined = schParts === undefined ? undefined : new Map();
  if (schParts !== undefined) for (const [ref, part] of Object.entries(schParts)) for (const [pin, net] of Object.entries(part.pins)) sch!.set(`${ref}.${pin}`, net);
  const sameSchPcb = sch === undefined ? undefined : netComparer(sch, pcb);

  const fileNet = derived.netlist?.terminals ?? {};
  const fileTerminalPads = (id: string): string[] => [...new Set((filePads.get(id) ?? []).map((p) => `${p.ref}.${p.pad}`))].sort(natural);
  const fileIds = new Set(derived.terminals.map((d) => d.id));

  // a curated connector prefix no footprint reads as (`j`, `jag` for `J1`): the one connector footprint starting with its letter
  const pinRefs = [...new Set(derived.terminals.filter((d) => d.id.includes('.')).flatMap((d) => fileTerminalPads(d.id).map(refOf)))];
  const alias = (prefix: string): string | undefined => {
    const hits = pinRefs.filter((r) => r[0]?.toLowerCase() === prefix[0]);
    return hits.length === 1 ? hits[0] : undefined;
  };
  const padsOfRecord = new Map(def.terminals.map((t) => [t.id, recordPads(t, pcb, byRef, alias)]));
  const padsOfFile = new Map(derived.terminals.map((d) => [d.id, fileTerminalPads(d.id)]));
  const key = (pads: readonly string[]): string => pads.join('|');

  // pair record and file terminals: the same pads first (whatever the ids), then the same id, then the one file terminal sharing a pad
  const fileOf = new Map<string, string>();
  const taken = new Set<string>();
  const pair = (t: string, f: string): void => {
    fileOf.set(t, f);
    taken.add(f);
  };
  for (const t of def.terminals) {
    const mine = key(padsOfRecord.get(t.id)!);
    if (mine === '') continue;
    const same = derived.terminals.filter((d) => !taken.has(d.id) && key(padsOfFile.get(d.id)!) === mine);
    const hit = same.find((d) => d.id === t.id) ?? (same.length === 1 ? same[0] : undefined);
    if (hit !== undefined) pair(t.id, hit.id);
  }
  for (const t of def.terminals) if (!fileOf.has(t.id) && fileIds.has(t.id) && !taken.has(t.id)) pair(t.id, t.id);
  for (const t of def.terminals) {
    if (fileOf.has(t.id)) continue;
    const mine = new Set(padsOfRecord.get(t.id)!);
    const overlap = derived.terminals.filter((d) => !taken.has(d.id) && padsOfFile.get(d.id)!.some((p) => mine.has(p)));
    if (overlap.length === 1) pair(t.id, overlap[0]!.id);
  }

  const covered = new Set<string>();
  const row = (t: PcbaTerminal | undefined, fileId: string | undefined): DisagreementRow => {
    const own = t === undefined ? [] : padsOfRecord.get(t.id)!;
    const pads = fileId !== undefined && padsOfFile.get(fileId)!.length > 0 ? padsOfFile.get(fileId)! : own;
    for (const p of pads) covered.add(p);
    const pcbNets = pads.length > 0 ? distinct(pads.map((p) => pcb.get(p))) : distinct([fileId === undefined ? undefined : fileNet[fileId]]);
    const schNets = sch === undefined ? undefined : distinct(pads.map((p) => sch.get(p)));
    const record = t === undefined ? undefined : def.netlist?.terminals[t.id];
    // the file gives this id to other pads than the record's
    const idPads = t !== undefined && fileId !== t.id && fileIds.has(t.id) ? padsOfFile.get(t.id)! : undefined;
    const recordDiffers = t !== undefined && own.length > 0 && fileId !== undefined && key(own) !== key(pads);
    const issues: DisagreementKind[] = [];
    const signal = signalText(t);
    const contradicts = t === undefined ? undefined : signalNetContradiction(vocab, signal, t.role, pcbNets);
    const unstated = t === undefined || contradicts !== undefined ? undefined : signalNetUnstated(vocab, signal, t.role, pcbNets);
    const contradiction = contradicts ?? unstated;
    if (contradicts !== undefined) issues.push('signal-net');
    if (unstated !== undefined) issues.push('voltage-unstated');
    if (t === undefined) issues.push('not-in-record');
    else if (fileId === undefined && pads.every((p) => !pcb.has(p))) issues.push('not-in-file');
    else if (fileId !== undefined && fileId !== t.id) issues.push('renamed');
    if (recordDiffers || (idPads !== undefined && idPads.length > 0)) issues.push('pads-differ');
    if (sch !== undefined && pads.length > 0) {
      const onBoard = pads.filter((p) => pcb.has(p));
      if (onBoard.some((p) => !sch.has(p) && schParts![refOf(p)] === undefined)) issues.push('not-in-sch');
      else if (onBoard.some((p) => !sameSchPcb!(sch.get(p), pcb.get(p)))) issues.push('sch-pcb');
    }
    // the record's net came from an earlier file: names compare; two unnamed nets cannot be told apart
    if (record !== undefined && !noNet(record) && pcbNets.length > 0 && !pcbNets.some((n) => n === record || (isUnnamedNet(n) && isUnnamedNet(record)))) issues.push('record-pcb');
    const fingerprint = [issues.join(','), (schNets ?? ['-']).join('+'), pcbNets.join('+'), record ?? '', fileId ?? '', own.join('+'), signal ?? '', t?.role ?? ''].join('|');
    return {
      key: t?.id ?? `file:${fileId}`,
      ...(t === undefined ? {} : { terminal: t.id }),
      ...(t?.label === undefined || t.label === t.id ? {} : { label: t.label }),
      ...(fileId === undefined ? {} : { fileTerminal: fileId }),
      pads,
      ...(recordDiffers ? { recordPads: own } : {}),
      ...(idPads === undefined || idPads.length === 0 ? {} : { idPads }),
      ...(contradiction === undefined ? {} : { contradiction }),
      ...(schNets === undefined ? {} : { schematic: schNets }),
      pcb: pcbNets,
      ...(record === undefined ? {} : { record }),
      ...(t?.role === undefined ? {} : { role: t.role }),
      ...(signal === undefined ? {} : { signal }),
      issues,
      fingerprint,
    };
  };

  const rows: DisagreementRow[] = def.terminals.map((t) => row(t, fileOf.get(t.id)));
  for (const d of derived.terminals) if (!taken.has(d.id)) rows.push(row(undefined, d.id));
  // a contradiction between the curated signal and the net comes first, then a voltage the net does not state
  const rank = (r: DisagreementRow): number => (r.issues.includes('signal-net') ? 2 : r.issues.includes('voltage-unstated') ? 1 : 0);
  rows.sort((a, b) => rank(b) - rank(a));

  const pads: PadDisagreement[] = [];
  const onlySchematic: string[] = [];
  const onlyPcb: string[] = [];
  if (sch !== undefined && schParts !== undefined) {
    for (const [pad, net] of pcb) {
      if (covered.has(pad) || !sch.has(pad)) continue;
      if (!sameSchPcb!(sch.get(pad), net)) pads.push({ pad, schematic: sch.get(pad)!, pcb: net });
    }
    pads.sort((a, b) => natural(a.pad, b.pad));
    for (const [ref, part] of Object.entries(schParts)) if (!byRef.has(ref) && part.notOnBoard !== true && Object.keys(part.pins).length > 0) onlySchematic.push(ref);
    for (const [ref, list] of byRef) if (schParts[ref] === undefined && list.some((p) => !noNet(pcb.get(p)))) onlyPcb.push(ref);
    onlySchematic.sort(natural);
    onlyPcb.sort(natural);
  }
  return { rows, pads, onlySchematic, onlyPcb };
}

/** The rows a person can take from the board file one at a time: a new terminal, a rename, the file's net. */
export function fileRowAction(row: DisagreementRow): 'add' | 'rename' | 'net' | undefined {
  if (row.issues.includes('not-in-record')) return 'add';
  if (row.issues.includes('record-pcb')) return 'net';
  if (row.issues.includes('renamed')) return 'rename';
  return undefined;
}

/**
 * `def` with one row of its KiCad check taken from the board file, the rest of the record as it
 * is: a terminal only in the file is added (with its net and the file's links to terminals the
 * record has); a renamed terminal takes the file's id and pads (its label, role and signal stay,
 * links and the stored net follow it); a stale stored net becomes the file's. `undefined` when the
 * row is not one of those or no longer differs.
 */
export function boardWithFileRow(def: PcbaDefinition, board: BoardSource, key: string): PcbaDefinition | undefined {
  const derived = deriveBoard(board, { sha256: '0'.repeat(64), id: def.id }).pcba;
  // pair the terminals as the check does: file id → record id, for the other end of a link
  const rows = boardDisagreements(def, board).rows;
  const recordOf = new Map<string, string>();
  for (const r of rows) if (r.terminal !== undefined && r.fileTerminal !== undefined) recordOf.set(r.fileTerminal, r.terminal);
  const target = rows.find((r) => r.key === key);
  const fileNet = derived.netlist?.terminals ?? {};
  const withNet = (terminals: Record<string, string> | undefined, id: string, net: string | undefined): Record<string, string> | undefined => {
    if (terminals === undefined) return undefined;
    const next = { ...terminals };
    if (net === undefined) delete next[id];
    else next[id] = net;
    return next;
  };
  const netlist = (terminals: Record<string, string> | undefined): Pick<PcbaDefinition, 'netlist'> =>
    def.netlist === undefined || terminals === undefined ? {} : { netlist: { ...def.netlist, terminals } };
  // the file's links at `fileId`, in the record's ids (links to terminals the record lacks are left out)
  const linksAt = (fileId: string, recordId: string): PcbaDefinition['internalLinks'] => {
    const ids = new Map(recordOf);
    ids.set(fileId, recordId);
    return derived.internalLinks
      .filter((l) => l.from === fileId || l.to === fileId)
      .flatMap((l) => {
        const from = ids.get(l.from);
        const to = ids.get(l.to);
        return from === undefined || to === undefined ? [] : [{ ...l, from, to }];
      });
  };
  const replaceLinks = (recordId: string, fileId: string): PcbaDefinition['internalLinks'] => [
    ...def.internalLinks.filter((l) => l.from !== recordId && l.to !== recordId),
    ...linksAt(fileId, recordId),
  ];

  if (target === undefined) return undefined;
  if (key.startsWith('file:')) {
    const fileId = key.slice('file:'.length);
    if (!target.issues.includes('not-in-record') || def.terminals.some((t) => t.id === fileId)) return undefined;
    const fresh = derived.terminals.find((t) => t.id === fileId);
    if (fresh === undefined) return undefined;
    return { ...def, terminals: [...def.terminals, fresh], internalLinks: replaceLinks(fileId, fileId), ...netlist(withNet(def.netlist?.terminals, fileId, fileNet[fileId])) };
  }
  if (target.issues.includes('renamed') && target.fileTerminal !== undefined && !def.terminals.some((t) => t.id === target.fileTerminal)) {
    const from = key;
    const to = target.fileTerminal;
    const fresh = derived.terminals.find((t) => t.id === to)!;
    const terminals = def.terminals.map((t) => {
      if (t.id !== from) return t;
      const { pads: _pads, ...rest } = t;
      return { ...rest, id: to, ...(fresh.pads === undefined ? {} : { pads: fresh.pads }), ...(t.label === undefined || t.label === t.id ? (fresh.label === undefined ? {} : { label: fresh.label }) : {}) };
    });
    const internalLinks = def.internalLinks.map((l) => (l.from === from || l.to === from ? { ...l, from: l.from === from ? to : l.from, to: l.to === from ? to : l.to } : l));
    const stored = def.netlist?.terminals;
    const nets = stored === undefined ? undefined : withNet(withNet(stored, from, undefined), to, fileNet[to] ?? stored[from]);
    return { ...def, terminals, internalLinks, ...netlist(nets) };
  }
  const own = def.terminals.find((t) => t.id === key);
  const fileId = target.fileTerminal ?? key;
  const net = fileNet[fileId];
  if (own === undefined || net === undefined || def.netlist === undefined || def.netlist.terminals[key] === net) return undefined;
  return { ...def, internalLinks: replaceLinks(key, fileId), ...netlist(withNet(def.netlist.terminals, key, net)) };
}
