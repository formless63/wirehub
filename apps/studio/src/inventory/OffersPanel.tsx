/**
 * A library record's dated supplier offers: who sells it, at what price, in what pack, on which day.
 * Optional throughout — empty, the panel is only an entry in the record's Add menu. The newest offer
 * per supplier is the one a build's cost reads; older ones stay, dimmed.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, IconButton, Input, NumberInput, Section, Select } from '@wirehub/editor-react';
import { IconTrash } from '@tabler/icons-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import { DIM_UNITS, inventoryKey, type Dimension, type ItemRef } from '../inventory.browser.ts';
import { addOffer, deleteOffer, fetchOffers, money, offersKey, type Offer } from '../sourcing.browser.ts';
import { useSectionAdd } from '../shell/RecordSections.tsx';
import { Shell } from './dialogs.tsx';

const UNITS_ALL = [...DIM_UNITS.count, ...DIM_UNITS.length, ...DIM_UNITS.mass, ...DIM_UNITS.volume];
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function OfferDialog({ item, dim, onClose, onDone }: { item: ItemRef; dim: Dimension; onClose: () => void; onDone: () => void }): JSX.Element {
  const [supplier, setSupplier] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [offeredOn, setOfferedOn] = useState(today());
  const [price, setPrice] = useState<number | null>(null);
  const [currency, setCurrency] = useState('');
  const [unit, setUnit] = useState(DIM_UNITS[dim][0]!);
  const [pack, setPack] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (): Promise<void> => {
    if (supplier.trim() === '') return setError('Name the supplier.');
    setBusy(true);
    const out = await addOffer({
      item,
      supplier: supplier.trim(),
      unit,
      offeredOn,
      ...(price === null ? {} : { price }),
      ...(currency.trim() === '' ? {} : { currency: currency.trim().toUpperCase() }),
      ...(pack === null ? {} : { pack }),
      ...(supplierRef.trim() === '' ? {} : { supplierRef: supplierRef.trim() }),
    });
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone();
    onClose();
  };
  return (
    <Shell open onClose={onClose} title="Supplier offer" busy={busy} error={error} submit={() => void submit()} submitLabel="Add">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Supplier"><Input aria-label="Supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} autoFocus /></Field>
        <Field label="Their number"><Input aria-label="Their number" mono value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} /></Field>
        <Field label="Price">
          <div className="flex gap-2">
            <NumberInput aria-label="Price" value={price} onChange={setPrice} min={0} className="min-w-0 flex-1" />
            <Input aria-label="Currency" placeholder="USD" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} className="w-16" />
          </div>
        </Field>
        <Field label="Per">
          <Select aria-label="Per" value={unit} onValueChange={setUnit} options={(DIM_UNITS[dim].length > 1 ? DIM_UNITS[dim] : UNITS_ALL).map((u) => ({ value: u, label: u }))} />
        </Field>
        <Field label="Pack"><NumberInput aria-label="Pack" value={pack} onChange={setPack} min={0} unit={unit} /></Field>
        <Field label="Date"><Input aria-label="Date" type="date" value={offeredOn} onChange={(e) => setOfferedOn(e.target.value)} /></Field>
      </div>
    </Shell>
  );
}

/** `from 0.50 USD/m · 2 suppliers`: the lowest current price and how many sell it. */
function summaryOf(current: readonly Offer[]): string {
  // the lowest current price (as the build cost reads it), compared within one unit and currency
  const priced = current.filter((o) => o.price !== undefined);
  const low = priced.filter((o) => o.unit === priced[0]?.unit && o.currency === priced[0]?.currency).sort((a, b) => a.price! - b.price!)[0];
  const count = `${current.length} supplier${current.length === 1 ? '' : 's'}`;
  return low === undefined ? count : `${current.length > 1 ? 'from ' : ''}${money(low.price!, low.currency)}/${low.unit} · ${count}`;
}

export function OffersPanel({ item, dim, readOnly }: { item: ItemRef; dim: Dimension; readOnly: boolean }): JSX.Element | null {
  const client = useQueryClient();
  const query = useQuery({ queryKey: offersKey(item), queryFn: async () => { const out = await fetchOffers(item); return out.ok ? out.value.offers : null; }, retry: false });
  const [adding, setAdding] = useState(false);
  const offers = query.data;
  const empty = offers !== undefined && offers !== null && offers.length === 0;
  const hosted = useSectionAdd('offers', 'Supplier offer…', empty && !readOnly, () => setAdding(true));
  if (offers === null) return null;
  const refresh = (): void => void client.invalidateQueries({ queryKey: inventoryKey });
  const dialog = adding ? <OfferDialog item={item} dim={dim} onClose={() => setAdding(false)} onDone={refresh} /> : null;
  if (hosted && (empty || offers === undefined)) return dialog;
  const list = offers ?? [];
  // the newest per supplier is the current one; the rest is history
  const current = new Set<string>();
  const seen = new Set<string>();
  for (const o of list) if (!seen.has(o.supplier.toLowerCase())) { seen.add(o.supplier.toLowerCase()); current.add(o.id); }
  const remove = async (o: Offer): Promise<void> => {
    const out = await deleteOffer(o);
    if (!out.ok) toast.error(out.message, { description: out.hint });
    refresh();
  };
  return (
    <>
      <Section id="offers" title="Offers" testId="offers-panel" defaultOpen={false}
        summary={list.length === 0 ? undefined : summaryOf(list.filter((o) => current.has(o.id)))}
        actions={readOnly ? null : <Button size="xs" onClick={() => setAdding(true)}>Add…</Button>}>
        {list.length === 0 ? null : (
          <table className="w-full">
            <thead className="text-2xs text-faint">
              <tr><th className="text-left font-normal">Supplier</th><th className="text-right font-normal">Price</th><th className="text-right font-normal">Pack</th><th className="text-right font-normal">Date</th><th /></tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} data-offer={o.id} className={current.has(o.id) ? undefined : 'text-faint'} title={current.has(o.id) ? undefined : 'Older than this supplier’s newest offer'}>
                  <td className="truncate pr-2">{o.supplier}{o.supplierRef === undefined ? null : <span className="ml-1 font-mono text-2xs text-faint">{o.supplierRef}</span>}</td>
                  <td className="whitespace-nowrap text-right">{o.price === undefined ? <span className="text-faint">—</span> : `${money(o.price, o.currency)}/${o.unit}`}</td>
                  <td className="whitespace-nowrap text-right text-dim">{o.pack === undefined ? '' : `${o.pack} ${o.unit}`}</td>
                  <td className="whitespace-nowrap pl-2 text-right text-dim">{o.offeredOn}</td>
                  <td className="pl-1 text-right">{readOnly ? null : <IconButton size="xs" label="Delete offer" icon={<IconTrash size={12} />} onClick={() => void remove(o)} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {dialog}
    </>
  );
}
