/** Operator-supplied work times; pure estimation never changes the design. */
import type { CableDesign, Db, Issue } from '@wirehub/model';

export const MODULE_ID = 'standard-work';
const MAX_OPERATIONS = 500;
const MAX_INPUT = 1_000_000;
const MAX_MINUTES = 1_000_000_000;
const PRECISION = 1_000_000;

export interface WorkOperation {
  id: string;
  label: string;
  minutes: number;
  quantity: number;
  basis: 'per-cable' | 'per-batch';
  src: string;
}
export interface WorkSettings {
  schema: 1;
  operations: WorkOperation[];
  /** A prior explicit adoption; editing the table does not update this or labourMinutes. */
  adoption?: { builds: number; minutes: number };
}
export interface WorkEstimate {
  builds: number;
  perCableMinutes: number;
  batchMinutes: number;
  runMinutes: number;
  allocatedPerCableMinutes: number;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const validBuilds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_INPUT;

/** Missing measurements are invalid, including on a row with zero quantity. */
export function workProblems(value: unknown): string[] {
  if (!object(value)) return ['Standard work must be a settings object.'];
  const problems: string[] = [];
  if (value.schema !== 1) problems.push('Standard work needs schema 1.');
  if (!Array.isArray(value.operations)) problems.push('Standard work needs an operation table.');
  else {
    if (value.operations.length > MAX_OPERATIONS) problems.push(`Standard work supports at most ${MAX_OPERATIONS} operations.`);
    const seen = new Set<string>();
    let perCable = 0; let batch = 0;
    for (const [i, row] of value.operations.slice(0, MAX_OPERATIONS).entries()) {
      const prefix = `Operation ${i + 1}`;
      if (!object(row)) { problems.push(`${prefix} must be an operation object.`); continue; }
      if (!text(row.id, 100) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id)) problems.push(`${prefix} needs a kebab-case id.`);
      else if (seen.has(row.id)) problems.push(`${prefix} repeats id '${row.id}'.`);
      else seen.add(row.id);
      if (!text(row.label, 200)) problems.push(`${prefix} needs a label of at most 200 characters.`);
      if (!bounded(row.minutes, MAX_INPUT)) problems.push(`${prefix} needs measured minutes from 0 to ${MAX_INPUT}; blank is not zero.`);
      if (!bounded(row.quantity, MAX_INPUT)) problems.push(`${prefix} needs an explicit quantity from 0 to ${MAX_INPUT}.`);
      if (row.basis !== 'per-cable' && row.basis !== 'per-batch') problems.push(`${prefix} needs a per-cable or per-batch basis.`);
      if (!text(row.src, 2000)) problems.push(`${prefix} needs a timing source of at most 2000 characters.`);
      if (bounded(row.minutes, MAX_INPUT) && bounded(row.quantity, MAX_INPUT)) {
        const minutes = row.minutes * row.quantity;
        if (row.minutes > 0 && row.quantity > 0 && minutes === 0) problems.push(`${prefix} is too small to calculate without losing its positive time.`);
        if (row.basis === 'per-cable') perCable += minutes;
        if (row.basis === 'per-batch') batch += minutes;
      }
    }
    if (!bounded(perCable, MAX_MINUTES) || !bounded(batch, MAX_MINUTES) || !bounded(perCable + batch, MAX_MINUTES)) problems.push(`Work totals must not exceed ${MAX_MINUTES} minutes.`);
  }
  if (value.adoption !== undefined) {
    if (!object(value.adoption) || !validBuilds(value.adoption.builds) || !bounded(value.adoption.minutes, MAX_MINUTES)) problems.push('Recorded labour adoption needs a whole build count from 1 to 1000000 and finite nonnegative minutes.');
  }
  return problems;
}

/** Return a detached settings value, never mask an invalid stored measurement as blank. */
export function settingsOf(design: CableDesign): WorkSettings {
  const raw = design.extensions?.[MODULE_ID];
  if (raw === undefined) return { schema: 1, operations: [] };
  const problems = workProblems(raw);
  if (problems.length > 0) throw new Error(problems.join(' '));
  return structuredClone(raw as WorkSettings);
}

function rounded(value: number, scale = PRECISION): number {
  if (!Number.isFinite(value) || value < 0 || value * scale > Number.MAX_SAFE_INTEGER) throw new Error('The work total is too large to report safely.');
  const result = Math.round(value * scale) / scale;
  // An explicit tiny positive measurement must never turn into free zero labour.
  return value > 0 && result === 0 ? value : result;
}
function checkedMinutes(value: number): number {
  if (!bounded(value, MAX_MINUTES)) throw new Error(`The build's work total must not exceed ${MAX_MINUTES} minutes.`);
  return value;
}

export function estimateWork(settings: WorkSettings, builds = 1): WorkEstimate {
  const problems = workProblems(settings);
  if (problems.length > 0) throw new Error(problems.join(' '));
  if (!validBuilds(builds)) throw new Error('Build quantity must be a whole number from 1 to 1000000.');
  if (settings.operations.length === 0) throw new Error('Record at least one operation with an explicit time before estimating labour.');
  let perCable = 0; let batch = 0;
  for (const op of settings.operations) {
    if (op.basis === 'per-cable') perCable += op.minutes * op.quantity;
    else batch += op.minutes * op.quantity;
  }
  const run = checkedMinutes(builds * perCable + batch);
  const allocated = checkedMinutes(perCable + batch / builds);
  if (run > 0 && allocated === 0) throw new Error('Allocated labour is too small to calculate without losing its positive time.');
  return { builds, perCableMinutes: rounded(perCable), batchMinutes: rounded(batch), runMinutes: rounded(run), allocatedPerCableMinutes: rounded(allocated) };
}

/** Only an explicit user action calls this; edits and estimates preserve adopted labour. */
export function adoptLabour(design: CableDesign, settings: WorkSettings, builds = 1): CableDesign {
  const estimate = estimateWork(settings, builds);
  const copy = structuredClone(design);
  copy.labourMinutes = estimate.allocatedPerCableMinutes;
  copy.extensions = { ...copy.extensions, [MODULE_ID]: { ...structuredClone(settings), adoption: { builds, minutes: estimate.allocatedPerCableMinutes } } satisfies WorkSettings };
  return copy;
}

/** The empty table is a valid saved configuration, but has no estimate to adopt. */
export function workIssues(design: CableDesign): Issue[] {
  const raw = design.extensions?.[MODULE_ID];
  if (raw === undefined) return [];
  return workProblems(raw).map((message) => ({ code: 'invalid-work', severity: 'error', message, where: `designs/${design.id}` }));
}

function cell(value: unknown): string {
  let s = value === undefined ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

/** No labour-rate default or currency conversion; absent rate/currency leaves costs unpriced. */
export function workCsv(design: CableDesign, db: Db, settings: WorkSettings, builds = 1): string {
  const estimate = estimateWork(settings, builds);
  const costing = db.rules?.costing;
  const rate = costing?.labourRatePerHour;
  const currency = costing?.currency;
  if (rate !== undefined && !bounded(rate, MAX_INPUT)) throw new Error('The labour rate must be finite, nonnegative and at most 1000000 per hour.');
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new Error('Labour currency must be an explicit three-letter code.');
  const priced = rate !== undefined && currency !== undefined;
  const price = (minutes: number): number | undefined => priced ? rounded(minutes / 60 * rate, 100) : undefined;
  const note = rate === undefined ? 'No labour rate is set; labour is unpriced.' : currency === undefined ? 'No labour currency is set; labour is unpriced.' : 'Uses the current engineering labour rate; no exchange conversion.';
  const rows: unknown[][] = [
    ['Design', 'Row', 'Operation', 'Basis', 'Minutes per operation', 'Quantity', 'Minutes', 'Builds', 'Currency', 'Labour rate per hour', 'Labour cost', 'Source / notes'],
    ...settings.operations.map((op) => [design.id, 'operation', `${op.id}: ${op.label}`, op.basis, op.minutes, op.quantity, rounded(op.minutes * op.quantity), builds, '', '', '', op.src]),
    [design.id, 'per-cable', '', 'per-cable', '', '', estimate.perCableMinutes, builds, currency, rate, price(estimate.perCableMinutes), 'Per-cable operations, excluding batch setup.'],
    [design.id, 'batch-setup', '', 'per-batch', '', '', estimate.batchMinutes, builds, currency, rate, price(estimate.batchMinutes), 'Setup is charged once for this build.'],
    [design.id, 'build-total', '', '', '', '', estimate.runMinutes, builds, currency, rate, price(estimate.runMinutes), note],
    [design.id, 'allocated-per-cable', '', 'per-cable', '', '', estimate.allocatedPerCableMinutes, builds, currency, rate, price(estimate.allocatedPerCableMinutes), 'Per-cable work plus batch setup divided by build quantity.'],
    [design.id, 'recorded-labour', '', 'per-cable', '', '', design.labourMinutes, '', '', '', '', 'Existing design labour is unchanged by this report.'],
  ];
  if (settings.adoption) rows.push([design.id, 'prior-adoption', '', 'per-cable', '', '', settings.adoption.minutes, settings.adoption.builds, '', '', '', 'Previously adopted labour; later operation edits do not recalculate it.']);
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
