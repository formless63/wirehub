/**
 * A part's optional price (cs-5k1.17): unit price, currency, what it is per
 * (a piece, or a metre for wire) and quantity breaks. Leaving the unit price
 * blank removes the cost. Quantity breaks are a small table, one row per break
 * (from this quantity, this price), kept sorted; the base price applies below the
 * first. `breakRowsOf` / `breaksText` convert between the rows and the
 * `10: 0.80, 100: 0.60` text `readCostTexts` reads.
 */

import { isCurrencyCode, type PartCost } from '@wirehub/model';
import { useState, type JSX } from 'react';

import { Choice, Field } from './fields.tsx';

interface Texts {
  unit: string;
  currency: string;
  per: 'each' | 'm';
  breaks: string;
  moq: string;
}

const textsOf = (cost: PartCost | undefined, isWire: boolean): Texts => ({
  unit: cost === undefined ? '' : String(cost.unit),
  currency: cost?.currency ?? '',
  per: cost?.per ?? (isWire ? 'm' : 'each'),
  breaks: (cost?.breaks ?? []).map((b) => `${b.minQty}: ${b.unit}`).join(', '),
  moq: cost?.moq === undefined ? '' : String(cost.moq),
});

export interface BreakRow {
  qty: string;
  price: string;
}

/** The rows of a break list, from the text `readCostTexts` reads. */
const isBreakProblem = (problem: string): boolean => problem.startsWith('Each quantity break') || problem.startsWith('The break at');

export const breakRowsOf = (breaks: string): BreakRow[] =>
  breaks.trim() === '' ? [] : breaks.split(',').map((piece) => ({ qty: (piece.split(':')[0] ?? '').trim(), price: (piece.split(':')[1] ?? '').trim() }));

/** The text for a list of rows; a row with both boxes empty is nothing. */
export const breaksText = (rows: readonly BreakRow[]): string => rows.filter((r) => r.qty.trim() !== '' || r.price.trim() !== '').map((r) => `${r.qty.trim()}: ${r.price.trim()}`).join(', ');

/** The base price's saving at each break, in percent (for the table's hint), or undefined while a row is not a number. */
export function savingPct(unit: string, price: string): number | undefined {
  const u = Number(unit);
  const p = Number(price);
  if (unit.trim() === '' || price.trim() === '' || !Number.isFinite(u) || !Number.isFinite(p) || u <= 0) return undefined;
  return Math.round((1 - p / u) * 1000) / 10;
}

const positive = (s: string): number | undefined => (s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : undefined);
const nonNegative = (s: string): number | undefined => (s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : undefined);

/** The cost the typed texts mean, or what is wrong with them (`undefined` cost with no problem = none). */
export function readCostTexts(t: Texts, isWire: boolean, keep?: Pick<PartCost, 'src'>): { cost?: PartCost; problem?: string } {
  if (t.unit.trim() === '') return {};
  const unit = nonNegative(t.unit);
  if (unit === undefined) return { problem: 'The unit price is a number, zero or more.' };
  const currency = t.currency.trim().toUpperCase();
  if (currency !== '' && !isCurrencyCode(currency)) return { problem: 'The currency is a three-letter code such as USD.' };
  const breaks: { minQty: number; unit: number }[] = [];
  if (t.breaks.trim() !== '') {
    for (const piece of t.breaks.split(',')) {
      const [q, p, ...more] = piece.split(':');
      const minQty = positive(q ?? '');
      const price = nonNegative(p ?? '');
      if (more.length > 0 || minQty === undefined || price === undefined) return { problem: 'Each quantity break needs a quantity and a price (from 10, 0.80).' };
      if (breaks.some((b) => b.minQty === minQty)) return { problem: `The break at ${minQty} is listed twice.` };
      breaks.push({ minQty, unit: price });
    }
    breaks.sort((a, b) => a.minQty - b.minQty);
  }
  const moq = t.moq.trim() === '' ? undefined : positive(t.moq);
  if (t.moq.trim() !== '' && moq === undefined) return { problem: 'The minimum order is a positive number.' };
  const cost: PartCost = {
    unit,
    ...(currency === '' ? {} : { currency }),
    ...(t.per === (isWire ? 'm' : 'each') ? {} : { per: t.per }),
    ...(breaks.length === 0 ? {} : { breaks }),
    ...(moq === undefined ? {} : { moq }),
    ...(keep?.src === undefined ? {} : { src: keep.src }),
  };
  return { cost };
}

export function CostFields(props: { cost: PartCost | undefined; isWire?: boolean; onChange: (cost: PartCost | undefined) => void }): JSX.Element {
  const isWire = props.isWire === true;
  const [t, setT] = useState<Texts>(() => textsOf(props.cost, isWire));
  const read = readCostTexts(t, isWire, props.cost);
  const set = (patch: Partial<Texts>): void => {
    const next = { ...t, ...patch };
    setT(next);
    const out = readCostTexts(next, isWire, props.cost);
    if (out.problem === undefined) props.onChange(out.cost);
  };
  const [rows, setRows] = useState<BreakRow[]>(() => breakRowsOf(t.breaks));
  const setRowsAndBreaks = (next: BreakRow[]): void => {
    setRows(next);
    set({ breaks: breaksText(next) });
  };
  const breakProblem = t.breaks.trim() === '' || read.problem === undefined || !isBreakProblem(read.problem) ? undefined : read.problem;
  const perLabel = isWire ? 'per metre' : 'per piece';
  return (
    <div className="cs-form-grid" data-testid="cost-fields">
      <Field label={`Unit price (${perLabel})`} say="What one unit costs. Leave blank for no price: the BOM then shows no cost for this part." value={t.unit} onChange={(unit) => set({ unit })} mono placeholder="e.g. 0.42" {...(read.problem === undefined || isBreakProblem(read.problem) ? {} : { problem: read.problem })} />
      <Field label="Currency" say="ISO code; blank uses the hub's currency from the engineering settings." value={t.currency} onChange={(currency) => set({ currency })} mono placeholder="hub default" />
      {isWire ? (
        <Choice
          label="Priced"
          value={t.per}
          onChange={(per) => set({ per: per as 'each' | 'm' })}
          choices={[
            { value: 'm', label: 'per metre' },
            { value: 'each', label: 'per piece' },
          ]}
        />
      ) : null}
      <div className="cs-field is-wide" data-testid="price-breaks" {...(breakProblem === undefined ? {} : { 'data-bad': 'true' })}>
        <span title="From this quantity, this unit price. The BOM reads the break that applies at the build quantity; the base price applies below the first.">Quantity breaks</span>
        {rows.length === 0 ? <small>No breaks: the unit price applies at every quantity.</small> : null}
        {rows.map((row, index) => {
          const saving = savingPct(t.unit, row.price);
          return (
            <div key={index} className="cs-break-row" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBlock: 2 }}>
              <input
                aria-label={`Break ${index + 1} from quantity`}
                className="cs-mono"
                value={row.qty}
                placeholder="from qty"
                inputMode="decimal"
                onChange={(event) => setRowsAndBreaks(rows.map((r, i) => (i === index ? { ...r, qty: event.target.value } : r)))}
              />
              <input
                aria-label={`Break ${index + 1} unit price`}
                className="cs-mono"
                value={row.price}
                placeholder="unit price"
                inputMode="decimal"
                onChange={(event) => setRowsAndBreaks(rows.map((r, i) => (i === index ? { ...r, price: event.target.value } : r)))}
              />
              <small>{saving === undefined ? '' : saving >= 0 ? `${saving}% under the base price` : `${-saving}% over the base price`}</small>
              <button type="button" aria-label={`Remove break ${index + 1}`} onClick={() => setRowsAndBreaks(rows.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
          );
        })}
        <div>
          <button type="button" onClick={() => setRows([...rows, { qty: '', price: '' }])}>
            Add a break
          </button>
          {rows.length > 1 ? (
            <button type="button" onClick={() => setRowsAndBreaks([...rows].sort((a, b) => Number(a.qty) - Number(b.qty)))}>
              Sort by quantity
            </button>
          ) : null}
        </div>
        {breakProblem === undefined ? null : <small className="cs-field-bad">{breakProblem}</small>}
      </div>
      <Field label="Minimum order" say="The supplier's minimum order quantity, for the buyer's information." value={t.moq} onChange={(moq) => set({ moq })} mono />
    </div>
  );
}

/** The price a draft keeps among its extras (the forms of connectors, components and mechanicals). */
export const costOfExtra = (extra: Record<string, unknown> | undefined): PartCost | undefined => extra?.['cost'] as PartCost | undefined;

/** `extra` with its price replaced (or removed); `undefined` when nothing is left. */
export function withExtraCost(extra: Record<string, unknown> | undefined, cost: PartCost | undefined): Record<string, unknown> | undefined {
  const { cost: _old, ...rest } = extra ?? {};
  const next = cost === undefined ? rest : { ...rest, cost };
  return Object.keys(next).length === 0 ? undefined : next;
}
