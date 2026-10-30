/**
 * Prints made from a manufacturing variant (`docs/inventory.md`, Batches): record what came off
 * the printer — good and failed parts, the actual print time and part mass beside the slicer's
 * estimate — take the filament or resin used from an inventory lot (or a new spool received on the spot), and optionally shelve the parts as a
 * lot of the record. Nothing here operates a printer; it records what a person did.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, NumberInput, Select } from '@wirehub/editor-react';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { batchesKey, DIM_UNITS, fetchBatches, fetchInventory, formatQty, inventoryKey, locationPaths, recordBatch, unwrap, type Batch, type Dimension, type ItemRef } from '../inventory.browser.ts';
import { variantLabel, type VariantNaming } from '../print/variant-label.ts';
import { BatchList } from './batches.tsx';
import { LocationSelect, Shell } from './dialogs.tsx';
import { NEW_SPOOL, NEW_SPOOL_OPTION, newSpool, SpoolFields, useCreateSpool, type SpoolDraft } from './spool.tsx';

const BASE: Readonly<Record<Dimension, string>> = { count: 'ea', length: 'mm', mass: 'g', volume: 'ml' };

/** What the print panel knows of a variant: its id, profile and the slicer's estimates. */
export interface PrintVariantRef extends VariantNaming {
  id: string;
  estimates: { printTimeSeconds?: number; printTimeText?: string; filamentG?: number; resinMl?: number };
  parts: { path: string }[];
}

function RecordPrintDialog({ item, variants, onClose, onDone }: { item: ItemRef; variants: readonly PrintVariantRef[]; onClose: () => void; onDone: (batch: Batch) => void }): JSX.Element {
  const client = useQueryClient();
  const stock = useQuery({ queryKey: [...inventoryKey, false], queryFn: () => unwrap(fetchInventory(false)), retry: false });
  const createSpool = useCreateSpool();
  const [variantId, setVariantId] = useState(variants[0]?.id);
  const variant = variants.find((v) => v.id === variantId);
  // a resin variant is measured in ml of resin, a filament one in g
  const resin = variant?.estimates.resinMl !== undefined;
  const dim: Dimension = resin ? 'volume' : 'mass';
  const material = resin ? 'Resin' : 'Filament';
  const [units, setUnits] = useState<number | null>(1);
  const [failed, setFailed] = useState<number | null>(0);
  const [hours, setHours] = useState<number | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [massG, setMassG] = useState<number | null>(null);
  const [lot, setLot] = useState<string>();
  const [used, setUsed] = useState<number | null>(null);
  const [unit, setUnit] = useState<string>();
  const [into, setInto] = useState<string>();
  const [batchCode, setBatchCode] = useState('');
  const [note, setNote] = useState('');
  const [spool, setSpool] = useState<SpoolDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const view = stock.data;
  // taken by weight (filament) or volume (resin): lots counted that way with free stock
  const lots = useMemo(() => (view?.lots ?? []).filter((l) => l.dim === dim && l.onHand - l.reserved > 0), [view, dim]);
  const paths = useMemo(() => locationPaths(view?.locations ?? []), [view]);
  const chosen = lots.find((l) => l.id === lot);
  const usedUnit = unit !== undefined && DIM_UNITS[dim].includes(unit) ? unit : BASE[dim];
  const copies = (units ?? 0) + (failed ?? 0);
  const perPrint = resin ? variant?.estimates.resinMl : variant?.estimates.filamentG;
  const estimate = perPrint === undefined ? undefined : Math.round(perPrint * copies * 10) / 10;
  const pickLot = (v: string): void => {
    if (v === NEW_SPOOL) {
      setLot(NEW_SPOOL);
      setSpool(newSpool(dim, view?.locations[0]?.id));
      return;
    }
    setLot(v);
    setSpool(undefined);
  };
  const submit = async (): Promise<void> => {
    if (copies <= 0) return setError('Record at least one part, good or failed.');
    const seconds = hours === null && minutes === null ? undefined : ((hours ?? 0) * 60 + (minutes ?? 0)) * 60;
    const take = used ?? (usedUnit === BASE[dim] ? estimate : undefined);
    if (lot !== undefined && (take === undefined || take <= 0)) return setError(`Say how much ${material.toLowerCase()} the print used.`);
    setBusy(true);
    let from = lot;
    if (lot === NEW_SPOOL && spool !== undefined) {
      const made = await createSpool(spool, view?.locations ?? []);
      if ('error' in made) {
        setBusy(false);
        return setError(made.error);
      }
      from = made.lot.id;
      // the spool is in: a refusal below keeps it chosen, not offered again
      setLot(from);
      setSpool(undefined);
      await client.invalidateQueries({ queryKey: inventoryKey });
    }
    const out = await recordBatch({
      item,
      units: units ?? 0,
      ...((failed ?? 0) > 0 ? { failed: failed ?? 0 } : {}),
      ...(variant === undefined ? {} : { variant: variant.id }),
      consume: from === undefined || take === undefined ? [] : [{ lot: from, qty: take, unit: usedUnit }],
      measured: { ...(seconds === undefined ? {} : { durationS: seconds }), ...(massG === null ? {} : { unitMassG: massG }) },
      ...(batchCode.trim() === '' ? {} : { batchCode: batchCode.trim() }),
      ...(into === undefined || (units ?? 0) === 0 ? {} : { into }),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone(out.value.batch);
    onClose();
  };
  const label = (l: (typeof lots)[number]): string => `${view?.labels[`${l.item.kind}:${l.item.id}`] ?? 'Unavailable material'}${l.lotCode === undefined ? '' : ` · ${l.lotCode}`} · ${formatQty(l.onHand - l.reserved, l.dim)} free`;
  return (
    <Shell open onClose={onClose} title="Record a print" busy={busy} error={error} submit={() => void submit()} submitLabel="Record">
      <Field label="Variant">
        <Select aria-label="Variant" className="[&>span]:truncate" value={variantId} onValueChange={(v) => { setVariantId(v); setUnit(undefined); setLot(undefined); setSpool(undefined); }} options={variants.map((v) => ({ value: v.id, label: variantLabel(v) }))} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Good parts"><NumberInput aria-label="Good parts" value={units} onChange={setUnits} min={0} step={1} precision={0} /></Field>
        <Field label="Failed"><NumberInput aria-label="Failed prints" value={failed} onChange={setFailed} min={0} step={1} precision={0} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Print time" hint={variant?.estimates.printTimeText === undefined ? undefined : `est. ${variant.estimates.printTimeText}`}>
          <div className="flex gap-1">
            <NumberInput aria-label="Print time hours" value={hours} onChange={setHours} min={0} step={1} precision={0} unit="h" />
            <NumberInput aria-label="Print time minutes" value={minutes} onChange={setMinutes} min={0} max={59} step={1} precision={0} unit="min" />
          </div>
        </Field>
        <Field label="Part mass (each)" hint={resin || variant?.estimates.filamentG === undefined ? undefined : `est. ${variant.estimates.filamentG} g`}>
          <NumberInput aria-label="Part mass" value={massG} onChange={setMassG} min={0} unit="g" />
        </Field>
      </div>
      <Field label={`${material} from`} hint={chosen === undefined ? undefined : paths.get(chosen.location)}>
        <Select aria-label={`${material} lot`} value={lot} onValueChange={pickLot} options={[...lots.map((l) => ({ value: l.id, label: label(l) })), NEW_SPOOL_OPTION]} placeholder="Not taken from stock" />
      </Field>
      {lot !== NEW_SPOOL || spool === undefined ? null : (
        <SpoolFields draft={spool} onChange={setSpool} dim={dim} locations={view?.locations ?? []} placeholder={resin ? 'Grey standard resin' : 'PLA black'} />
      )}
      {lot === undefined ? null : (
        <Field label={`${material} used`} hint={estimate === undefined || usedUnit !== BASE[dim] ? undefined : `empty = ${estimate} ${BASE[dim]} (estimate)`}>
          <div className="flex gap-2">
            <NumberInput aria-label={`${material} used`} value={used} onChange={setUsed} min={0} className="min-w-0 flex-1" />
            <Select aria-label="Unit" value={usedUnit} onValueChange={setUnit} options={DIM_UNITS[dim].map((u) => ({ value: u, label: u }))} className="w-20" />
          </div>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Put good parts in"><LocationSelect locations={view?.locations ?? []} value={into} onChange={setInto} label="Put good parts in" placeholder="Not kept in stock" /></Field>
        <Field label="Batch code"><Input value={batchCode} onChange={(e) => setBatchCode(e.target.value)} placeholder="optional" /></Field>
      </div>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="bed, nozzle, what went wrong…" /></Field>
    </Shell>
  );
}

/** The record's print batches and the Record a print action, under its manufacturing variants. */
export function PrintBatches({ id, variants, readOnly }: { id: string; variants: readonly PrintVariantRef[]; readOnly: boolean }): JSX.Element | null {
  const client = useQueryClient();
  const item: ItemRef = { kind: 'mechanicals', id };
  const query = useQuery({ queryKey: batchesKey(item), queryFn: async () => { const out = await fetchBatches({ item, limit: 50 }); return out.ok ? out.value.batches : null; }, retry: false });
  const [recording, setRecording] = useState(false);
  const stock = useQuery({ queryKey: [...inventoryKey, false], queryFn: () => unwrap(fetchInventory(false)), retry: false, enabled: (query.data ?? []).some((b) => b.outputLot !== undefined) });
  const batches = query.data;
  // a hub without inventory answers 501: no batches, no action
  if (batches === null || (variants.length === 0 && (batches ?? []).length === 0)) return null;
  const byId = new Map(variants.map((v) => [v.id, v]));
  const paths = locationPaths(stock.data?.locations ?? []);
  const lotName = (lot: string): string | undefined => {
    const l = stock.data?.lots.find((x) => x.id === lot);
    return l === undefined ? undefined : l.lotCode ?? paths.get(l.location);
  };
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="print-batches">
      <div className="flex items-center gap-2">
        <p className="text-faint">Prints made</p>
        {readOnly || variants.length === 0 ? null : <Button size="xs" variant="ghost" onClick={() => setRecording(true)}>Record a print…</Button>}
      </div>
      {(batches ?? []).length === 0 ? <p className="text-faint">None recorded yet.</p> : (
        <BatchList
          batches={batches ?? []}
          variantName={(v) => { const found = byId.get(v); return found === undefined ? undefined : variantLabel(found); }}
          lotName={lotName}
          estimate={(b) => {
            const v = b.variant === undefined ? undefined : byId.get(b.variant);
            return v === undefined ? undefined : { ...(v.estimates.printTimeSeconds === undefined ? {} : { durationS: v.estimates.printTimeSeconds * (b.units + b.failed) }), ...(v.estimates.filamentG === undefined ? {} : { unitMassG: v.estimates.filamentG }) };
          }}
        />
      )}
      {recording ? <RecordPrintDialog item={item} variants={variants} onClose={() => setRecording(false)} onDone={(b) => { void client.invalidateQueries({ queryKey: inventoryKey }); toast.success(`Recorded ${b.units} good${b.failed > 0 ? `, ${b.failed} failed` : ''}.`); }} /> : null}
    </div>
  );
}
