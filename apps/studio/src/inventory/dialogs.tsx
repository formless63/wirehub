/** The inventory forms: receive, move, adjust, return. Each one request; a refusal stays in the dialog. */

import { Button, Combobox, Dialog, Field, Input, NumberInput, Select, type ComboboxOption } from '@wirehub/editor-react';
import { useMemo, useState, type JSX, type ReactNode } from 'react';

import { useStudio } from '../studio-context.tsx';
import { NEW_SPOOL, NEW_SPOOL_OPTION, useCreateSpool } from './spool.tsx';
import { adjustLot, DIM_UNITS, formatQty, locationPaths, moveLot, receiveStock, UNIT_FACTOR, type Dimension, type ItemKind, type ItemRef, type Location, type Lot } from '../inventory.browser.ts';

const KIND_LABEL: Readonly<Record<ItemKind, string>> = { connectors: 'Connector', wires: 'Wire', components: 'Component', pcbas: 'Board', mechanicals: 'Part', designs: 'Design' };
export const kindLabel = (kind: ItemKind): string => KIND_LABEL[kind];

function useItemOptions(): ComboboxOption[] {
  const { db, designs } = useStudio();
  return useMemo(() => {
    const out: ComboboxOption[] = [];
    const add = (kind: ItemKind, list: readonly { id: string; label?: string }[]) => {
      for (const r of list) out.push({ value: `${kind}:${r.id}`, label: r.label || 'Unnamed item', hint: KIND_LABEL[kind] });
    };
    add('wires', db.wires);
    add('connectors', db.connectors);
    add('components', db.components);
    add('pcbas', db.pcbas);
    add('mechanicals', db.mechanicals ?? []);
    add('designs', designs.map((d) => ({ id: d.id, label: d.label })));
    return out;
  }, [db, designs]);
}

export function LocationSelect({ locations, value, onChange, label = 'Location', placeholder = 'Choose…' }: { locations: readonly Location[]; value: string | undefined; onChange: (id: string) => void; label?: string; placeholder?: string }): JSX.Element {
  const paths = locationPaths(locations);
  const options = [...paths].map(([id, path]) => ({ value: id, label: path })).sort((a, b) => a.label.localeCompare(b.label));
  return <Select aria-label={label} value={value} onValueChange={onChange} options={options} placeholder={options.length === 0 ? 'Add a location first' : placeholder} disabled={options.length === 0} />;
}

export function QtyRow({ dim, qty, unit, onQty, onUnit, label = 'Quantity', allowNegative = false }: { dim: Dimension; qty: number | null; unit: string; onQty: (n: number | null) => void; onUnit: (u: string) => void; label?: string; allowNegative?: boolean }): JSX.Element {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <NumberInput aria-label={label} value={qty} onChange={onQty} {...(allowNegative ? {} : { min: 0 })} className="min-w-0 flex-1" />
        {DIM_UNITS[dim].length === 1 ? (
          <span className="self-center text-xs text-dim">{unit}</span>
        ) : (
          <Select aria-label="Unit" value={unit} onValueChange={onUnit} options={DIM_UNITS[dim].map((u) => ({ value: u, label: u }))} className="w-20" />
        )}
      </div>
    </Field>
  );
}

export function Shell({ open, onClose, title, description, busy, error, submit, submitLabel, children }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; busy: boolean; error: string | undefined; submit: () => void; submitLabel: string; children: ReactNode }): JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={title}
      {...(description === undefined ? {} : { description })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>{submitLabel}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {children}
        {error === undefined ? null : <div role="alert" className="text-xs text-err">{error}</div>}
      </form>
    </Dialog>
  );
}

const dimOfKind = (kind: ItemKind | undefined): Dimension => (kind === 'wires' ? 'length' : 'count');

export function ReceiveDialog({ open, onClose, onDone, locations, item: fixed, location: initialLocation }: { open: boolean; onClose: () => void; onDone: () => void; locations: readonly Location[]; item?: ItemRef & { label: string }; location?: string }): JSX.Element {
  const items = useItemOptions();
  const options = useMemo(() => [NEW_SPOOL_OPTION, ...items], [items]);
  const createSpool = useCreateSpool();
  const [spoolName, setSpoolName] = useState('');
  const [itemKey, setItemKey] = useState<string | null>(fixed === undefined ? null : `${fixed.kind}:${fixed.id}`);
  const kind = itemKey?.split(':')[0] as ItemKind | undefined;
  const [dim, setDim] = useState<Dimension>(dimOfKind(fixed?.kind));
  const [unit, setUnit] = useState(DIM_UNITS[dimOfKind(fixed?.kind)][0]!);
  const [qty, setQty] = useState<number | null>(null);
  const [location, setLocation] = useState<string | undefined>(initialLocation ?? locations[0]?.id);
  const [lotCode, setLotCode] = useState('');
  const [supplier, setSupplier] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pickDim = (next: Dimension) => {
    setDim(next);
    setUnit(DIM_UNITS[next][0]!);
  };
  const submit = async () => {
    if (itemKey === NEW_SPOOL) {
      setBusy(true);
      const made = await createSpool({ name: spoolName, qty, unit, location }, locations, {
        ...(lotCode.trim() === '' ? {} : { lotCode: lotCode.trim() }),
        ...(supplier.trim() === '' ? {} : { supplier: supplier.trim() }),
        ...(supplierRef.trim() === '' ? {} : { supplierRef: supplierRef.trim() }),
        ...(unitCost === null ? {} : { unitCost }),
      });
      setBusy(false);
      if ('error' in made) return setError(made.error);
      onDone();
      return onClose();
    }
    if (itemKey === null || kind === undefined) return setError('Choose an item.');
    if (qty === null || qty <= 0) return setError('Enter a quantity above zero.');
    if (location === undefined) return setError('Choose a location.');
    setBusy(true);
    const out = await receiveStock({
      item: { kind, id: itemKey.slice(kind.length + 1) },
      qty,
      unit,
      location,
      ...(lotCode.trim() === '' ? {} : { lotCode: lotCode.trim() }),
      ...(supplier.trim() === '' ? {} : { supplier: supplier.trim() }),
      ...(supplierRef.trim() === '' ? {} : { supplierRef: supplierRef.trim() }),
      ...(unitCost === null ? {} : { unitCost }),
    });
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone();
    onClose();
  };
  return (
    <Shell open={open} onClose={onClose} title={fixed === undefined ? 'Receive stock' : `Receive ${fixed.label}`} busy={busy} error={error} submit={() => void submit()} submitLabel="Receive">
      {fixed !== undefined ? null : (
        <Field label="Item">
          <Combobox aria-label="Item" options={options} value={itemKey} onValueChange={(v) => { setItemKey(v); if (v === NEW_SPOOL) { setDim('mass'); setUnit('kg'); setQty((q) => q ?? 1); } else pickDim(dimOfKind(v.split(':')[0] as ItemKind)); }} placeholder="Search the library…" />
        </Field>
      )}
      {itemKey !== NEW_SPOOL ? null : <Field label="New spool"><Input autoFocus value={spoolName} onChange={(e) => setSpoolName(e.target.value)} placeholder={dim === 'volume' ? 'Grey standard resin' : 'PLA black'} /></Field>}
      <div className="grid grid-cols-[auto_1fr] items-end gap-2">
        <Field label="Counted by">
          <Select aria-label="Counted by" value={dim} onValueChange={(v) => pickDim(v as Dimension)} options={[{ value: 'count', label: 'Count' }, { value: 'length', label: 'Length' }, { value: 'mass', label: 'Mass' }, { value: 'volume', label: 'Volume' }]} className="w-28" />
        </Field>
        <QtyRow dim={dim} qty={qty} unit={unit} onQty={setQty} onUnit={setUnit} />
      </div>
      <Field label="Location">
        <LocationSelect locations={locations} value={location} onChange={setLocation} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Lot / reel code"><Input value={lotCode} onChange={(e) => setLotCode(e.target.value)} /></Field>
        <Field label="Supplier"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>
        <Field label="Supplier ref"><Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} /></Field>
        <Field label={`Unit cost (per ${unit})`}><NumberInput aria-label="Unit cost" value={unitCost} onChange={setUnitCost} min={0} /></Field>
      </div>
    </Shell>
  );
}

export function MoveDialog({ lot, label, locations, onClose, onDone }: { lot: Lot; label: string; locations: readonly Location[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const [to, setTo] = useState<string>();
  const [unit, setUnit] = useState(DIM_UNITS[lot.dim][0]!);
  const [qty, setQty] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (to === undefined) return setError('Choose where it goes.');
    setBusy(true);
    const out = await moveLot(lot, to, qty === null ? undefined : { qty, unit });
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone();
    onClose();
  };
  return (
    <Shell open onClose={onClose} title={`Move ${label}`} description={`${formatQty(lot.onHand, lot.dim)} on hand, ${formatQty(lot.reserved, lot.dim)} held. Leave the quantity empty to move the whole lot; part of it splits off as a new lot.`} busy={busy} error={error} submit={() => void submit()} submitLabel="Move">
      <Field label="To"><LocationSelect locations={locations.filter((l) => l.id !== lot.location)} value={to} onChange={setTo} label="To" /></Field>
      <QtyRow dim={lot.dim} qty={qty} unit={unit} onQty={setQty} onUnit={setUnit} label="Quantity (empty = all)" />
    </Shell>
  );
}

export function AdjustDialog({ lot, label, onClose, onDone }: { lot: Lot; label: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const [unit, setUnit] = useState(DIM_UNITS[lot.dim][0]!);
  const [count, setCount] = useState<number | null>(Math.round((lot.onHand / (UNIT_FACTOR[DIM_UNITS[lot.dim][0]!] ?? 1)) * 1000) / 1000);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (count === null || count < 0) return setError('Enter what is there now.');
    setBusy(true);
    const out = await adjustLot(lot, { count, unit, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) });
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone();
    onClose();
  };
  return (
    <Shell open onClose={onClose} title={`Adjust ${label}`} description={`Recorded as ${formatQty(lot.onHand, lot.dim)}.`} busy={busy} error={error} submit={() => void submit()} submitLabel="Adjust">
      <QtyRow dim={lot.dim} qty={count} unit={unit} onQty={setCount} onUnit={(u) => { setUnit(u); setCount(Math.round((lot.onHand / (UNIT_FACTOR[u] ?? 1)) * 1000) / 1000); }} label="Counted now" />
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="optional" /></Field>
    </Shell>
  );
}
