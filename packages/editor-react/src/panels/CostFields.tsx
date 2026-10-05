/**
 * A part's optional price (cs-5k1.17): unit price, currency, what it is per
 * (a piece, or a metre for wire) and quantity breaks. Leaving the unit price
 * blank removes the cost. Quantity breaks are typed as `10: 0.80, 100: 0.60`
 * (from this quantity, this price); the base price applies below the first.
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
      if (more.length > 0 || minQty === undefined || price === undefined) return { problem: 'Quantity breaks read like 10: 0.80, 100: 0.60.' };
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
  const perLabel = isWire ? 'per metre' : 'per piece';
  return (
    <div className="cs-form-grid" data-testid="cost-fields">
      <Field label={`Unit price (${perLabel})`} say="What one unit costs. Leave blank for no price: the BOM then shows no cost for this part." value={t.unit} onChange={(unit) => set({ unit })} mono placeholder="e.g. 0.42" {...(read.problem === undefined ? {} : { problem: read.problem })} />
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
      <Field label="Quantity breaks" say="From this quantity, this unit price: 10: 0.80, 100: 0.60. Read at the build quantity." value={t.breaks} onChange={(breaks) => set({ breaks })} mono wide placeholder="10: 0.80, 100: 0.60" />
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
