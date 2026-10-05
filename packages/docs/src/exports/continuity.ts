/**
 * The continuity tester export: the continuity spec as data a tester, a
 * fixture generator or a script can read, with no tester's dialect in it.
 *
 * One neutral shape (`ContinuityExport`) and two renderings of it: JSON (the
 * whole thing) and CSV (one flat table of net-to-pin pairs and test pairs).
 * A module that speaks a particular tester's format reads the same shape
 * (`deriveContinuityExport`) from its own `ExporterContribution` — see
 * `docs/exports.md`.
 *
 * Point ids are `<instance>.<terminal>`: connector pins and the connector pins
 * a board carries. A board's internal pads are never test points
 * (`designPorts`).
 */

import type { CableDesign, Db } from '@wirehub/model';
import type { ContinuityData } from '@wirehub/modules';

import type { PathVerdict } from '../passages.ts';
import { deriveTestSpec, type Port, type TestSpec } from '../test-spec.ts';
import { compareStrings } from '../text.ts';
import { resolveTestParameters, type TestParameters } from './test-params.ts';
import { toCsv, type Table } from './table.ts';

export const CONTINUITY_FORMAT = 'wirehub.continuity' as const;
export const CONTINUITY_VERSION = 1 as const;

/** The neutral shape, declared in the module API so modules can name it without importing this package. */
export type ContinuityExport = ContinuityData;
export type ContinuityPoint = ContinuityData['points'][number];
export type ContinuityNet = ContinuityData['nets'][number];
export type ContinuityConnection = ContinuityData['connections'][number];
export type ContinuityIsolation = ContinuityData['isolation'][number];
export type ContinuityOpen = ContinuityData['opens'][number];

function expectOf(verdict: PathVerdict): ContinuityConnection['expect'] {
  switch (verdict) {
    case 'continuous':
      return 'continuity';
    case 'resistive':
      return 'resistance';
    case 'blocked':
    case 'active':
      return 'open-dc';
    case 'conditional':
      return 'conditional';
    default:
      return 'unverified';
  }
}

const pointId = (port: Port): string => `${port.instance}.${port.terminal}`;

/** The neutral export for a design. `parameters` are the design's own; `defaults` the organisation's. */
export function deriveContinuityExport(
  design: CableDesign,
  db: Db,
  options: { parameters?: TestParameters; defaults?: TestParameters; spec?: TestSpec } = {},
): ContinuityExport {
  const parameters = resolveTestParameters(options.parameters, options.defaults);
  const spec = options.spec ?? deriveTestSpec(design, db, { continuityOhmsMax: parameters.continuityOhmsMax });
  const points: ContinuityPoint[] = spec.ports
    .map((port) => ({
      id: pointId(port),
      instance: port.instance,
      terminal: port.terminal,
      ...(port.label === undefined ? {} : { label: port.label }),
      end: port.side,
      signal: port.signal,
      ...(port.net === undefined ? {} : { net: port.net }),
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const nets: ContinuityNet[] = spec.netChecks
    .map((check) => ({ net: check.net, signal: check.signal, points: check.ports.map(pointId).sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.net, b.net));
  const connections: ContinuityConnection[] = [
    ...spec.pathChecks.map((check): ContinuityConnection => ({
      id: check.id,
      kind: 'path',
      from: pointId(check.from),
      to: pointId(check.to),
      expect: expectOf(check.behaviour.verdict),
      ...(check.behaviour.verdict === 'resistive' && check.behaviour.ohms !== undefined ? { ohms: check.behaviour.ohms } : {}),
      ...(check.through.length === 0 ? {} : { through: check.through.join(' → ') }),
    })),
    ...spec.commoned.map((check): ContinuityConnection => ({
      id: check.id,
      kind: 'commoned',
      from: pointId(check.a),
      to: pointId(check.b),
      expect: 'continuity',
      ...(check.commoned === undefined ? {} : { through: check.commoned }),
    })),
  ];
  const isolation: ContinuityIsolation[] = spec.isolationChecks.map((check) => ({
    id: check.id,
    a: pointId(check.a),
    b: pointId(check.b),
    end: check.side,
    rule: check.rule,
    ...(check.netA === undefined ? {} : { netA: check.netA }),
    ...(check.netB === undefined ? {} : { netB: check.netB }),
  }));
  const opens: ContinuityOpen[] = spec.openChecks.map((check) => ({ id: check.id, kind: check.openKind, point: check.text, why: check.rationale }));
  return {
    format: CONTINUITY_FORMAT,
    version: CONTINUITY_VERSION,
    design: { id: design.id, label: design.label, ...(design.productRef === undefined ? {} : { productRef: design.productRef }) },
    parameters,
    points,
    nets,
    connections,
    isolation,
    opens,
  };
}

export const CONTINUITY_CSV_HEADERS = [
  'type',
  'id',
  'net',
  'signal',
  'from',
  'to',
  'expect',
  'limit',
  'unit',
  'test_volts',
  'duration_s',
  'note',
] as const;

/**
 * The flat table. `type` says what the row is:
 *
 * - `net-pin`: pin `from` is on net `net` (one row per pin; no `to`);
 * - `continuity`: `from` and `to` are connected; `expect` says how a meter reads them — `continuity`:
 *   at or below `limit` ohms · `resistance`: about `limit` ohms (series resistance) · `open-dc`: open
 *   (a capacitor or active silicon in the path) · `conditional` / `unverified`: no reading claimed;
 * - `isolation`: `from` and `to` must read at or above `limit` megohms at `test_volts` held for `duration_s`;
 * - `hipot`: only when a hipot voltage is set: the withstand test at `test_volts` held for `duration_s`, leakage above
 *   `limit` microamps fails (`from` is `*`: every pair of isolated nets);
 * - `open`: a deliberate open at `from`.
 */
export function continuityTable(data: ContinuityExport): Table {
  const p = data.parameters;
  const rows: (string | number)[][] = [];
  for (const net of data.nets) {
    for (const point of net.points) rows.push(['net-pin', `net/${net.net}/${point}`, net.net, net.signal, point, '', 'on-net', '', '', '', '', '']);
  }
  for (const c of data.connections) {
    rows.push([
      'continuity', c.id, '', '', c.from, c.to, c.expect,
      c.expect === 'continuity' ? p.continuityOhmsMax : (c.ohms ?? ''), c.expect === 'continuity' || c.ohms !== undefined ? 'ohm' : '', '', '',
      c.through ?? '',
    ]);
  }
  for (const i of data.isolation) {
    rows.push(['isolation', i.id, '', '', i.a, i.b, 'open', p.isolationMinMohm, 'Mohm', p.isolationVolts, p.isolationSeconds, `${i.rule} (${i.end})`]);
  }
  if (p.hipotVolts !== undefined) {
    rows.push([
      'hipot', 'hipot', '', '', '*', '', 'withstand', p.hipotMaxMicroamps ?? '', p.hipotMaxMicroamps === undefined ? '' : 'uA',
      p.hipotVolts, p.hipotSeconds ?? '', 'applied between every pair of isolated nets',
    ]);
  }
  for (const o of data.opens) rows.push(['open', o.id, '', '', o.point, '', 'open', '', '', '', '', `${o.kind}: ${o.why}`]);
  return { name: 'Continuity', headers: CONTINUITY_CSV_HEADERS, rows };
}

export const continuityCsv = (data: ContinuityExport): string => toCsv(continuityTable(data));
export const continuityJson = (data: ContinuityExport): string => `${JSON.stringify(data, null, 2)}\n`;
