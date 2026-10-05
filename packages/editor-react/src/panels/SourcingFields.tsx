/**
 * How a part or a cable is sourced (`@wirehub/model` `products.ts`): made in house, by a contract
 * manufacturer (and which), or bought in (and from whom). Optional; a bought-in part without a
 * supplier and a contract-made one without a maker are warnings in the issues.
 *
 * `SourcingFields` edits the three fields of one object; `sourcingOfExtra` / `withExtraSourcing`
 * read and write them in a library draft's `extra`, like the cost.
 */

import { PART_ROUTES, ROUTE_LABELS, type PartRoute, type PartSupplier, type Sourcing } from '@wirehub/model';
import type { JSX } from 'react';

import { Choice, Field } from './fields.tsx';

export const sourcingOfExtra = (extra: Record<string, unknown> | undefined): Sourcing => ({
  ...(extra?.['route'] === undefined ? {} : { route: extra['route'] as PartRoute }),
  ...(extra?.['maker'] === undefined ? {} : { maker: extra['maker'] as string }),
  ...(extra?.['suppliers'] === undefined ? {} : { suppliers: extra['suppliers'] as PartSupplier[] }),
});

/** `extra` with the sourcing fields replaced (an empty one dropped). */
export function withExtraSourcing(extra: Record<string, unknown> | undefined, sourcing: Sourcing): Record<string, unknown> | undefined {
  const { route: _r, maker: _m, suppliers: _s, ...rest } = extra ?? {};
  const next = { ...rest, ...withSourcing({}, sourcing) };
  return Object.keys(next).length === 0 ? undefined : next;
}

/** `target` with the sourcing fields set from `sourcing` (absent ones removed). */
export function withSourcing<T extends object>(target: T, sourcing: Sourcing): T {
  const { route: _r, maker: _m, suppliers: _s, ...rest } = target as T & Sourcing;
  return {
    ...rest,
    ...(sourcing.route === undefined ? {} : { route: sourcing.route }),
    ...(sourcing.maker === undefined || sourcing.maker.trim() === '' ? {} : { maker: sourcing.maker }),
    ...(sourcing.suppliers === undefined || sourcing.suppliers.length === 0 ? {} : { suppliers: sourcing.suppliers }),
  } as T;
}

export function SourcingFields(props: { value: Sourcing; onChange: (next: Sourcing) => void; suppliersElsewhere?: boolean }): JSX.Element {
  const { value } = props;
  const first = value.suppliers?.[0];
  const setSupplier = (patch: Partial<PartSupplier>): void => {
    const next: PartSupplier = { supplier: first?.supplier ?? '', ...(first?.number === undefined ? {} : { number: first.number }), ...patch };
    const rest = (value.suppliers ?? []).slice(1);
    props.onChange({ ...value, suppliers: next.supplier.trim() === '' ? rest : [next, ...rest] });
  };
  return (
    <div className="cs-field-row" data-testid="sourcing-fields">
      <Choice
        label="Route"
        say="How it is sourced: made in house, built by a contract manufacturer, or bought in finished."
        value={value.route ?? ''}
        choices={[{ value: '', label: 'not stated' }, ...PART_ROUTES.map((r) => ({ value: r, label: ROUTE_LABELS[r] }))]}
        onChange={(next) => {
          const { route: _old, ...rest } = value;
          props.onChange(next === '' ? rest : { ...rest, route: next as PartRoute });
        }}
      />
      {value.route === 'contract' ? (
        <Field label="Maker" say="The contract manufacturer that builds it." value={value.maker ?? ''} onChange={(maker) => props.onChange({ ...value, maker })} placeholder="contract manufacturer" />
      ) : null}
      {value.route === 'buy' && props.suppliersElsewhere !== true ? (
        <>
          <Field label="Supplier" say="Who sells it." value={first?.supplier ?? ''} onChange={(supplier) => setSupplier({ supplier })} placeholder="supplier" />
          <Field label="Supplier's number" say="The supplier's own number for it." value={first?.number ?? ''} onChange={(number) => setSupplier(number.trim() === '' ? { number: undefined } : { number })} placeholder="optional" />
        </>
      ) : null}
    </div>
  );
}
