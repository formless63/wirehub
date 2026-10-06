import { costLineOf, deriveBomSheet } from '@wirehub/docs';
import { placedDesign, type CableDesign, type Db } from '@wirehub/model';
import type { FxSettings, FxSnapshot } from './types.ts';

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const currency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}

/** Saved content is validated whenever it is used; invalid metadata is never silently repaired. */
export function snapshotProblems(value: unknown): string[] {
  const snapshot = object(value);
  if (snapshot === undefined) return ['No FX snapshot is present.'];
  const problems: string[] = [];
  if (snapshot.base !== 'EUR') problems.push('The FX snapshot base must be EUR.');
  if (!date(snapshot.date)) problems.push('The FX snapshot needs a valid observation date.');
  if (!timestamp(snapshot.retrievedAt)) problems.push('The FX snapshot needs a valid UTC retrieval time.');
  if (date(snapshot.date) && timestamp(snapshot.retrievedAt) && snapshot.date > snapshot.retrievedAt.slice(0, 10)) problems.push('The FX observation date is after its retrieval time.');
  if (typeof snapshot.source !== 'string' || snapshot.source.trim() === '' || snapshot.source.length > 1000 || /[\u0000-\u001f\u007f]/.test(snapshot.source)) problems.push('The FX snapshot needs its source.');
  const rates = object(snapshot.rates);
  if (rates === undefined || Object.keys(rates).length === 0 || Object.keys(rates).length > 200) problems.push('The FX snapshot needs a bounded currency-rate table.');
  else if (Object.entries(rates).some(([code, rate]) => !currency(code) || !finite(rate) || rate <= 0 || (code === 'EUR' && rate !== 1))) problems.push('FX rates must have currency codes and finite positive values; EUR is one.');
  return problems;
}

export function settingsOf(design: Pick<CableDesign, 'extensions'>): FxSettings | undefined {
  const value = object(design.extensions?.['fx-rates']);
  if (value === undefined || value.schema !== 1 || !currency(value.target) || snapshotProblems(value.snapshot).length > 0 || (value.builds !== undefined && (!Number.isSafeInteger(value.builds) || (value.builds as number) <= 0 || (value.builds as number) > 1_000_000))) return undefined;
  return value as unknown as FxSettings;
}

/** Returns undefined when source currency/rates are unknown; identity conversion needs no feed. */
export function convertAmount(amount: number, source: string | undefined, target: string, snapshot: FxSnapshot | undefined): number | undefined {
  if (!finite(amount) || !currency(source) || !currency(target)) return undefined;
  if (source === target) return amount;
  if (snapshotProblems(snapshot).length > 0 || snapshot === undefined) return undefined;
  const from = source === snapshot.base ? 1 : snapshot.rates[source];
  const to = target === snapshot.base ? 1 : snapshot.rates[target];
  if (!finite(from) || from <= 0 || !finite(to) || to <= 0) return undefined;
  const converted = amount / from * to;
  return Number.isFinite(converted) ? converted : undefined;
}

function cell(value: unknown): string {
  let text = value === undefined ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** A derived report: source prices and saved designs are never rewritten. */
export function costReportCsv(design: CableDesign, db: Db, settings: FxSettings, builds = settings.builds ?? 1): string {
  if (settings.schema !== 1 || !currency(settings.target) || snapshotProblems(settings.snapshot).length > 0) throw new Error('A valid saved FX snapshot and target currency are required.');
  if (!Number.isSafeInteger(builds) || builds <= 0 || builds > 1_000_000) throw new Error('Build quantity must be a positive whole number up to 1000000.');
  const rows: unknown[][] = [[
    'Design / subassembly', 'Category', 'Definition', 'Description', 'Quantity per assembly', 'Unit', 'Source currency',
    'Source unit price at build quantity', 'Source extended per assembly', 'Target currency', 'FX factor',
    'Converted per assembly', 'Converted build', 'Status',
  ]];
  let subtotal = 0;
  let excluded = 0;
  const addCost = (path: string, category: string, ref: string, label: string, quantity: number, unit: string,
    source: string | undefined, unitPrice: number | undefined, extended: number | undefined, reason?: string): void => {
    let converted = extended === undefined ? undefined : convertAmount(extended, source, settings.target, settings.snapshot);
    if (converted !== undefined && (!Number.isFinite(converted * builds) || !Number.isFinite(subtotal + converted) || !Number.isFinite((subtotal + converted) * builds))) throw new Error('The converted subtotal or build total is too large.');
    if (extended !== undefined && !finite(extended)) reason = 'Excluded: source amount is invalid or too large.';
    const factor = convertAmount(1, source, settings.target, settings.snapshot);
    const status = reason ?? (extended === undefined ? 'Excluded: no price.' : source === undefined ? 'Excluded: source currency is unknown.' : converted === undefined ? 'Excluded: currency rate is unavailable or conversion is too large.' : 'Included: reference-rate estimate.');
    if (converted === undefined || reason !== undefined) excluded += 1;
    else subtotal += converted;
    rows.push([path, category, ref, label, quantity, unit, source, finite(unitPrice) ? unitPrice : undefined, finite(extended) ? extended : undefined, settings.target, factor,
      reason === undefined ? converted : undefined, reason === undefined && converted !== undefined ? converted * builds : undefined, status]);
  };
  const walk = (current: CableDesign, currentDb: Db, path: string, multiplier: number, stack: readonly string[]): void => {
    if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isSafeInteger(multiplier * builds)) throw new Error('Subassembly build quantity is invalid.');
    const sheet = deriveBomSheet(current, currentDb, { buildQty: multiplier * builds, assemblyStack: stack });
    for (const line of sheet.lines) {
      if (line.subassembly !== undefined) {
        const quantity = Number(line.quantity) * multiplier;
        const opened = placedDesign(currentDb, { id: line.instances[0] ?? line.ref, def: line.subassembly.design, ...(line.subassembly.rev === undefined ? {} : { rev: line.subassembly.rev }) });
        if (opened === undefined || !opened.ok || stack.includes(line.subassembly.design) || stack.length >= 32) {
          addCost(path, line.category, line.ref, line.label, quantity, 'each', undefined, undefined, undefined, 'Excluded: subassembly is unavailable or cyclic.');
          continue;
        }
        const childPath = `${path}/${line.ref}${line.subassembly.rev === undefined ? '' : `@${line.subassembly.rev}`}`;
        rows.push([path, 'subassembly', line.ref, line.label, quantity, 'each', '', '', '', settings.target, '', '', '', 'Detail follows; subtotal includes child lines once.']);
        walk(opened.placed.design, opened.placed.db, childPath, quantity, [...stack, opened.placed.design.id]);
        continue;
      }
      const cost = costLineOf(sheet.cost, line);
      addCost(path, line.category, line.ref, line.label, (cost?.quantity ?? Number(line.quantity)) * multiplier,
        cost?.unit ?? line.unit, cost?.currency, cost?.unitPrice, cost === undefined ? undefined : cost.extended * multiplier);
    }
    if (current.labourMinutes !== undefined) {
      const rate = currentDb.rules?.costing?.labourRatePerHour;
      const minutes = current.labourMinutes * multiplier;
      addCost(path, 'labour', '', 'Labour', minutes / 60, 'hour', currentDb.rules?.costing?.currency,
        rate, rate === undefined ? undefined : minutes / 60 * rate);
    }
    for (const issue of [...sheet.blockers, ...sheet.warnings]) rows.push([path, 'note', '', issue.message, '', '', '', '', '', '', '', '', '', 'BOM warning.']);
  };
  walk(design, db, design.id, 1, [design.id]);
  rows.push(['', 'Subtotal', '', 'Included reference-rate estimate', '', '', '', '', '', settings.target, '', subtotal, subtotal * builds, `${excluded} excluded line(s); this is a subtotal, not a complete cost.`]);
  rows.push(['', 'Snapshot', '', 'Saved reference rates; converted values are derived estimates, not transaction prices.', '', '', settings.snapshot.base, '', '', settings.target, '', '', '', `Observed ${settings.snapshot.date}; retrieved ${settings.snapshot.retrievedAt}; source ${settings.snapshot.source}`]);
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
