/**
 * The continuity spec's "through board nets" section: for a design placing a
 * board read from its board file (`PcbaDefinition.netlist`), what each probe
 * point reaches across the board's own nets, how (copper or through passive
 * parts), and what the trace could not claim — active parts it stopped at,
 * missing facts, and declared facts the board file contradicts.
 *
 * Everything folds out of core's `traceConductor`; nothing is decided here.
 */

import { traceConductor, type CableDesign, type Db, type TraceFindingKind } from '@wirehub/model';

import type { Port } from './test-spec.ts';
import { byKeys, compareStrings } from './text.ts';

export interface BoardPathRow {
  from: string;
  to: string;
  kind: 'copper' | 'passive' | 'active';
  /** the parts passed, in order (`u1 R1 120 Ω`) */
  through: string[];
  /** board occurrences crossed */
  boards: string[];
  /** every hop on the way, in order, with its kind (the exports carry these) */
  hops: { kind: 'copper' | 'passive' | 'active' | 'unknown'; carrier: string; description: string }[];
}

export interface BoardFindingRow {
  kind: TraceFindingKind;
  code: string;
  where: string;
  message: string;
}

export interface BoardTraceSection {
  paths: BoardPathRow[];
  findings: BoardFindingRow[];
}

/** The section, or `undefined` when no placed board has native nets. */
export function deriveBoardTrace(design: CableDesign, db: Db, ports: readonly Port[]): BoardTraceSection | undefined {
  const netlisted = design.instances.pcbas.some((instance) => db.pcbas.find((p) => p.id === instance.def)?.netlist !== undefined);
  if (!netlisted) return undefined;
  const portByKey = new Map(ports.map((port) => [port.key, port]));
  const paths = new Map<string, BoardPathRow>();
  const findings = new Map<string, BoardFindingRow>();
  for (const from of ports) {
    const result = traceConductor(design, db, { instance: from.instance, terminal: from.terminal });
    for (const end of result.reached) {
      const to = portByKey.get(end.terminal.key);
      if (to === undefined || compareStrings(from.key, to.key) >= 0) continue;
      const boards = [...new Set(end.hops.filter((h) => h.carrier === 'board-net' || h.carrier === 'board-part').map((h) => h.instance ?? ''))].filter((b) => b !== '').sort(compareStrings);
      if (boards.length === 0) continue;
      paths.set(`${from.key}|${to.key}`, {
        from: from.text,
        to: to.text,
        kind: end.kind,
        through: end.hops.filter((h) => h.kind !== 'copper').map((h) => h.description),
        boards,
        hops: end.hops.map((h) => ({ kind: h.kind, carrier: h.carrier, description: h.description })),
      });
    }
    for (const finding of result.findings) {
      const where = finding.ref === undefined ? finding.instance ?? '' : `${finding.instance ?? ''} ${finding.ref}`.trim();
      const key = `${finding.code}|${where}|${finding.message}`;
      if (!findings.has(key)) findings.set(key, { kind: finding.kind, code: finding.code, where, message: finding.message });
    }
  }
  return {
    paths: [...paths.values()].sort(byKeys<BoardPathRow>((row) => row.from, (row) => row.to)),
    findings: [...findings.values()].sort(byKeys<BoardFindingRow>((row) => row.where, (row) => row.code, (row) => row.message)),
  };
}
