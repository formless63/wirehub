/**
 * Commissioning records (WF-FW, `docs/firmware.md`): an operator flashed one compiled artifact onto
 * one unit and says what they saw. Compiling never implies this: WireHub does not reach devices,
 * so a commission is a recorded operator step, authorised separately from compiling (owners, and
 * the people an owner names), and append-only — a correction is a new record that supersedes one.
 *
 * Shared by the server (`server/firmware/commission.ts`) and the browser; no runtime dependencies.
 */

export const COMMISSION_METHODS = ['usb', 'uf2', 'ota', 'debug-probe', 'other'] as const;
export type CommissionMethod = (typeof COMMISSION_METHODS)[number];
export const METHOD_LABEL: Record<CommissionMethod, string> = {
  usb: 'USB serial bootloader',
  uf2: 'UF2 drive copy',
  ota: 'Over the air',
  'debug-probe': 'Debug probe (SWD / JTAG / ISP)',
  other: 'Other',
};

export const COMMISSION_RESULTS = ['ok', 'partial', 'failed'] as const;
export type CommissionResult = (typeof COMMISSION_RESULTS)[number];
export const RESULT_LABEL: Record<CommissionResult, string> = {
  ok: 'Works as expected',
  partial: 'Flashed, not fully verified',
  failed: 'Failed',
};

/**
 * The unit, by a loose reference: a serial, an asset tag or a built-unit id. `inventoryUnit` is
 * the inventory's built-unit id once that link exists (filled when the reference matches one).
 */
export interface CommissionUnit {
  ref: string;
  serial?: string;
  inventoryUnit?: string;
}

export interface FirmwareCommission {
  id: string;
  project: string;
  /** when the operator did it (they may record it later) */
  performedAt: string;
  /** who did it at the bench, as they want to be named */
  operator: string;
  /** when and by whom the record was made (the signed-in person) */
  recordedAt: string;
  recordedBy: string;
  unit: CommissionUnit;
  /** the build the artifact came from, and the placement it was compiled for */
  build: string;
  occurrence?: { design: string; instance: string };
  /** exactly what was put on the unit; kept here so the record outlives the build list */
  artifact: { path: string; sha256: string; role: string; bytes: number };
  toolchain: { target: string; pack?: string; packVersion?: string; imageId?: string };
  method: CommissionMethod;
  result: CommissionResult;
  /** what was observed: boot messages, LEDs, a self-test, a measured value */
  observed: string;
  note?: string;
  /** an earlier record of this project that this one corrects */
  supersedes?: string;
}

/** What `POST /api/firmware/:id/commissions` takes. */
export interface CommissionInput {
  build: string;
  artifact: string;
  unit: { ref: string; serial?: string };
  method: CommissionMethod;
  result: CommissionResult;
  /** optional: the result already says how it went */
  observed?: string;
  operator?: string;
  performedAt?: string;
  note?: string;
  supersedes?: string;
}

/** Who may record commissioning beyond owners (`data/settings/commissioning.json`, owner-only). */
export interface CommissioningAuthority {
  /** emails of people (editors) allowed to record commissioning */
  operators: string[];
}

export const UNIT_REF = /^[A-Za-z0-9][A-Za-z0-9 ._:/#+-]{0,119}$/;
const SHORT_TEXT = 120;
const LONG_TEXT = 2000;

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** Problems with a commission request, in words; empty when it can be recorded. */
export function commissionInputProblems(input: unknown, now = Date.now()): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ['Send the commissioning record as an object.'];
  const r = input as Partial<Record<keyof CommissionInput, unknown>>;
  const out: string[] = [];
  if (typeof r.build !== 'string' || !/^[0-9]{14}-[0-9a-f]{6}$/.test(r.build)) out.push('build: the id of a compiled build of this project.');
  if (typeof r.artifact !== 'string' || !/^[0-9a-f]{64}$/.test(r.artifact)) out.push('artifact: the sha256 of the build output that was flashed.');
  const unit = r.unit as { ref?: unknown; serial?: unknown } | undefined;
  if (unit === undefined || typeof unit !== 'object' || typeof unit.ref !== 'string' || !UNIT_REF.test(unit.ref.trim())) out.push('unit.ref: which unit — a serial, an asset tag or a built-unit id (letters, digits, space and . _ : / # + -, up to 120).');
  if (unit?.serial !== undefined && !(typeof unit.serial === 'string' && unit.serial.length <= SHORT_TEXT)) out.push(`unit.serial: text up to ${SHORT_TEXT}.`);
  if (!COMMISSION_METHODS.includes(r.method as CommissionMethod)) out.push(`method: one of ${COMMISSION_METHODS.join(', ')}.`);
  if (!COMMISSION_RESULTS.includes(r.result as CommissionResult)) out.push(`result: one of ${COMMISSION_RESULTS.join(', ')}.`);
  if (r.observed !== undefined && !(typeof r.observed === 'string' && r.observed.length <= LONG_TEXT)) out.push(`observed: text up to ${LONG_TEXT}.`);
  if (r.operator !== undefined && !text(r.operator, SHORT_TEXT)) out.push(`operator: a name up to ${SHORT_TEXT}.`);
  if (r.note !== undefined && !(typeof r.note === 'string' && r.note.length <= LONG_TEXT)) out.push(`note: text up to ${LONG_TEXT}.`);
  if (r.supersedes !== undefined && !(typeof r.supersedes === 'string' && /^cm-[0-9a-f]{12}$/.test(r.supersedes))) out.push('supersedes: the id of an earlier commissioning record.');
  if (r.performedAt !== undefined) {
    const t = typeof r.performedAt === 'string' ? Date.parse(r.performedAt) : Number.NaN;
    if (!Number.isFinite(t)) out.push('performedAt: a date and time (ISO 8601).');
    else if (t > now + 5 * 60_000) out.push('performedAt: cannot be in the future.');
  }
  return out;
}
