/** Return unused material from an open reservation or a completed batch. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, Field, NumberInput, Select } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';
import { request } from '../definitions.browser.ts';
import { DIM_UNITS, fetchInventory, formatQty, inventoryKey, returnLeftover, UNIT_FACTOR, type Reservation } from '../inventory.browser.ts';

export function ReturnDialog({ reservation, onClose, onDone }: { reservation: Reservation; onClose: () => void; onDone: () => void }): JSX.Element {
  const stock = useQuery({ queryKey: [...inventoryKey, 'all'], queryFn: async () => { const out = await fetchInventory(true); return out.ok ? out.value : undefined; } });
  const lotName = (id: string): string => { const lot = stock.data?.lots.find((l) => l.id === id); if (!lot) return 'Loading lot…'; const location = stock.data?.locations.find((l) => l.id === lot.location)?.name; return `${lot.lotCode || `Received ${new Date(lot.receivedAt).toLocaleString()}`}${location ? ` · ${location}` : ''}`; };
  // cut-offs first: the usual leftover is a length back onto its reel
  const used = reservation.lines.flatMap((l) => l.allocations.filter((a) => a.consumed - a.returned > 0).map((a) => ({ line: l, alloc: a }))).sort((a, b) => (a.line.dim === 'length' ? 0 : 1) - (b.line.dim === 'length' ? 0 : 1));
  const [lot, setLot] = useState(used[0]?.alloc.lot);
  const pick = used.find((u) => u.alloc.lot === lot);
  const dim = pick?.line.dim ?? 'count';
  const [unit, setUnit] = useState(DIM_UNITS[dim][0]!);
  const [qty, setQty] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const submit = async (): Promise<void> => {
    if (lot === undefined || qty === null || qty <= 0) return setError('Choose the lot and how much comes back.');
    const available = pick === undefined ? 0 : pick.alloc.consumed - pick.alloc.returned;
    if (qty * (UNIT_FACTOR[unit] ?? 1) > available + 1e-6) return setError(`Only ${formatQty(available, dim)} is available to return from this build.`);
    setSubmitting(true);
    const out = await returnLeftover(reservation, lot, qty, unit);
    setSubmitting(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone();
    onClose();
  };
  const labelOf = (key: string): string => stock.data?.labels[key] ?? 'Unavailable item';
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())} title="Return leftover" description="A cut-off back onto its reel, unused parts back into their lot." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={submitting || used.length === 0} onClick={() => void submit()}>Return</Button></>}>
      <div className="flex flex-col gap-3">
        {used.length === 0 ? <p>All material taken for this build has already been returned.</p> : null}
        <Field label="From lot">
          <Select aria-label="From lot" value={lot} onValueChange={(v) => { setLot(v); const d = used.find((u) => u.alloc.lot === v)?.line.dim ?? 'count'; setUnit(DIM_UNITS[d][0]!); }} options={used.map((u) => ({ value: u.alloc.lot, label: `${labelOf(`${u.line.item.kind}:${u.line.item.id}`)} · ${lotName(u.alloc.lot)} · used ${formatQty(u.alloc.consumed - u.alloc.returned, u.line.dim)}` }))} />
        </Field>
        <Field label="Quantity">
          <div className="flex gap-2">
            <NumberInput aria-label="Quantity" value={qty} onChange={setQty} min={0} className="min-w-0 flex-1" />
            <Select aria-label="Unit" value={unit} onValueChange={setUnit} options={DIM_UNITS[dim].map((u) => ({ value: u, label: u }))} className="w-20" />
          </div>
        </Field>
        {error === undefined ? null : <div role="alert" className="text-xs text-err">{error}</div>}
      </div>
    </Dialog>
  );
}

export function ReturnLeftoverButton({ reservation }: { reservation: string }): JSX.Element {
  const client = useQueryClient();
  const [opened, setOpened] = useState<Reservation>();
  const [busy, setBusy] = useState(false);
  const open = async (): Promise<void> => {
    setBusy(true);
    const result = await request<{ reservation: Reservation }>(`/api/inventory/reservations/${encodeURIComponent(reservation)}`);
    setBusy(false);
    if (result.ok) setOpened(result.value.reservation);
    else toast.error(result.message);
  };
  return <><Button size="xs" variant="ghost" disabled={busy} onClick={() => void open()}>Return leftover…</Button>
    {opened === undefined ? null : <ReturnDialog reservation={opened} onClose={() => setOpened(undefined)} onDone={() => { void client.invalidateQueries({ queryKey: inventoryKey }); toast.success('Returned.'); }} />}</>;
}
