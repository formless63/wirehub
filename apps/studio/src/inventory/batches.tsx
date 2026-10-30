/**
 * Made units and lot details (`docs/inventory.md`, Batches): edit a lot's code, supplier and cost;
 * rename, move or remove a location; finish units of a build (part of it or the rest) with serials,
 * a batch code and what was measured; list batches. Each form is one request; a refusal stays in it.
 */

import { Button, Checkbox, Field, Input, NumberInput, Textarea } from '@wirehub/editor-react';
import { formatMassValue } from '@wirehub/model';
import { useState, type JSX } from 'react';

import { completeUnits, DIM_UNITS, editLot, formatDuration, formatQty, locationPaths, UNIT_FACTOR, updateLocation, type Batch, type Location, type Lot, type Reservation } from '../inventory.browser.ts';
import { localDateTime } from '../when.ts';
import { ReturnLeftoverButton } from './ReturnLeftover.tsx';
import { LocationSelect, Shell } from './dialogs.tsx';

const message = (out: { message: string; hint?: string }): string => `${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`;

/** The lot's details after receipt. Quantities change only by Adjust, Move or a build. */
export function EditLotDialog({ lot, label, onClose, onDone }: { lot: Lot; label: string; onClose: () => void; onDone: () => void }): JSX.Element {
  // a length is priced per metre, as it is received; everything else per its base unit
  const costUnit = lot.dim === 'length' ? 'm' : (DIM_UNITS[lot.dim][0] ?? 'ea');
  const factor = UNIT_FACTOR[costUnit] ?? 1;
  const [lotCode, setLotCode] = useState(lot.lotCode ?? '');
  const [supplier, setSupplier] = useState(lot.supplier ?? '');
  const [supplierRef, setSupplierRef] = useState(lot.supplierRef ?? '');
  const [unitCost, setUnitCost] = useState<number | null>(lot.unitCost === undefined ? null : Math.round(lot.unitCost * factor * 1e6) / 1e6);
  const [currency, setCurrency] = useState(lot.currency ?? '');
  const [note, setNote] = useState(lot.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (): Promise<void> => {
    setBusy(true);
    const field = (v: string): string | null => (v.trim() === '' ? null : v.trim());
    const out = await editLot(lot, {
      lotCode: field(lotCode),
      supplier: field(supplier),
      supplierRef: field(supplierRef),
      unitCost,
      ...(unitCost === null ? {} : { unit: costUnit }),
      currency: field(currency),
      note: field(note),
    });
    setBusy(false);
    if (!out.ok) return setError(message(out));
    onDone();
    onClose();
  };
  return (
    <Shell open onClose={onClose} title={`Details of ${label}`} description="The ledger keeps what each field was before." busy={busy} error={error} submit={() => void submit()} submitLabel="Save">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Lot / reel code"><Input value={lotCode} onChange={(e) => setLotCode(e.target.value)} /></Field>
        <Field label="Supplier"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>
        <Field label="Supplier ref"><Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} /></Field>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Field label={`Unit cost (per ${costUnit})`}><NumberInput aria-label="Unit cost" value={unitCost} onChange={setUnitCost} min={0} /></Field>
          <Field label="Currency"><Input value={currency} maxLength={8} onChange={(e) => setCurrency(e.target.value)} /></Field>
        </div>
      </div>
      <Field label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Shell>
  );
}

/** Rename a location, put it inside another, or change its note. */
export function LocationDialog({ location, locations, onClose, onDone }: { location: Location; locations: readonly Location[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const [name, setName] = useState(location.name);
  const [parent, setParent] = useState<string | undefined>(location.parent);
  const [note, setNote] = useState(location.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // not itself, nor anything inside it
  const inside = new Set([location.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of locations) if (l.parent !== undefined && inside.has(l.parent) && !inside.has(l.id)) { inside.add(l.id); grew = true; }
  }
  const submit = async (): Promise<void> => {
    if (name.trim() === '') return setError('Name it.');
    setBusy(true);
    const out = await updateLocation(location, {
      ...(name.trim() === location.name ? {} : { name: name.trim() }),
      ...(parent === location.parent ? {} : { parent: parent ?? null }),
      ...(note.trim() === (location.note ?? '') ? {} : { note: note.trim() === '' ? null : note.trim() }),
    });
    setBusy(false);
    if (!out.ok) return setError(message(out));
    onDone();
    onClose();
  };
  return (
    <Shell open onClose={onClose} title={`Location ${locationPaths(locations).get(location.id) ?? location.name}`} busy={busy} error={error} submit={() => void submit()} submitLabel="Save">
      <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Inside">
        <div className="flex gap-2">
          <LocationSelect locations={locations.filter((l) => !inside.has(l.id))} value={parent} onChange={setParent} label="Inside" placeholder="Top level" />
          {parent === undefined ? null : <Button size="sm" variant="ghost" onClick={() => setParent(undefined)}>Top level</Button>}
        </div>
      </Field>
      <Field label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Shell>
  );
}

const splitSerials = (text: string): string[] => text.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s !== '');

/** Lines of a reservation that hold less than they need: their parts are not taken from stock. */
export function shortLines(r: Reservation): number {
  return r.lines.filter((l) => l.allocations.reduce((s, a) => s + a.qty, 0) < l.needed - 1e-6).length;
}

/**
 * Finish units of a build: some of them now, the rest later. Takes each unit's share of what the
 * reservation holds, records the batch (serials, code, time) and can shelve the finished units.
 */
export function CompleteDialog({ reservation, label, locations, onClose, onDone }: { reservation: Reservation; label: string; locations: readonly Location[]; onClose: () => void; onDone: (batch: Batch) => void }): JSX.Element {
  const done = reservation.unitsDone ?? 0;
  const left = Math.max(0, reservation.buildQty - done);
  const [units, setUnits] = useState<number | null>(Math.min(1, left));
  const [failed, setFailed] = useState<number | null>(0);
  const [batchCode, setBatchCode] = useState('');
  const [serials, setSerials] = useState('');
  const [minutes, setMinutes] = useState<number | null>(null);
  const [shelve, setShelve] = useState(false);
  const [into, setInto] = useState<string | undefined>(locations[0]?.id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = splitSerials(serials);
  const submit = async (): Promise<void> => {
    const good = units ?? 0;
    if (good + (failed ?? 0) <= 0) return setError('Record at least one unit, good or failed.');
    if (good > left) return setError(`${left} unit(s) are left in this build.`);
    if (list.length > good) return setError(`${list.length} serials for ${good} good unit(s).`);
    if (shelve && into === undefined) return setError('Choose where the finished units go.');
    setBusy(true);
    const out = await completeUnits(reservation, {
      units: good,
      ...((failed ?? 0) > 0 ? { failed: failed ?? 0 } : {}),
      ...(batchCode.trim() === '' ? {} : { batchCode: batchCode.trim() }),
      ...(list.length === 0 ? {} : { serials: list }),
      ...(minutes === null ? {} : { measured: { durationS: minutes * 60 } }),
      ...(shelve && into !== undefined ? { into } : {}),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (!out.ok) return setError(message(out));
    onDone(out.value.batch);
    onClose();
  };
  return (
    <Shell
      open
      onClose={onClose}
      title={`Finish units of ${label}`}
      description={<>{done} of {reservation.buildQty} done{shortLines(reservation) > 0 ? <span className="text-warn"> · {shortLines(reservation)} line{shortLines(reservation) === 1 ? '' : 's'} short, not taken from stock</span> : null}</>}
      busy={busy}
      error={error}
      submit={() => void submit()}
      submitLabel="Record"
    >
      <div className="grid grid-cols-3 gap-2">
        <Field label="Good units"><NumberInput aria-label="Good units" value={units} onChange={setUnits} min={0} max={left} step={1} precision={0} /></Field>
        <Field label="Failed"><NumberInput aria-label="Failed units" value={failed} onChange={setFailed} min={0} step={1} precision={0} /></Field>
        <Field label="Time taken"><NumberInput aria-label="Time taken" value={minutes} onChange={setMinutes} min={0} unit="min" /></Field>
      </div>
      <Field label="Batch code"><Input value={batchCode} onChange={(e) => setBatchCode(e.target.value)} placeholder="optional" /></Field>
      <Field label="Serials" hint={list.length === 0 ? 'Optional: one per good unit, separated by spaces, commas or lines.' : `${list.length} of ${units ?? 0}`}>
        <Textarea aria-label="Serials" rows={2} mono value={serials} onChange={(e) => setSerials(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox checked={shelve} onCheckedChange={setShelve} label="Put the finished units in stock" />
        {shelve ? <div className="min-w-48 flex-1"><LocationSelect locations={locations} value={into} onChange={setInto} /></div> : null}
      </div>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Shell>
  );
}

/** One line per batch: when, units, code, serials, what was measured, where the units went. */
export function BatchList({ batches, labelOf, estimate, variantName, lotName, canReturn = false }: {
  batches: readonly Batch[];
  canReturn?: boolean;
  labelOf?: (b: Batch) => string | undefined;
  estimate?: (b: Batch) => { durationS?: number; unitMassG?: number } | undefined;
  /** a variant id as a person reads it (printer · material · process · date) */
  variantName?: (id: string) => string | undefined;
  /** where the units went: the lot's code or location */
  lotName?: (id: string) => string | undefined;
}): JSX.Element | null {
  if (batches.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs" data-testid="batch-list">
      {batches.map((b) => {
        const est = estimate?.(b);
        const name = labelOf?.(b);
        return (
          <li key={b.id} className="flex flex-wrap items-baseline gap-x-2" data-batch={b.id} title={localDateTime(b.at)}>
            <span className="w-28 text-faint">{localDateTime(b.at)}</span>
            {name === undefined ? null : <span className="font-medium">{name}</span>}
            <span>{b.units} good{b.failed > 0 ? <span className="text-warn"> · {b.failed} failed</span> : null}</span>
            {b.batchCode === undefined ? null : <span className="font-mono text-2xs">{b.batchCode}</span>}
            {b.serials.length === 0 ? null : <span className="font-mono text-2xs text-dim" title={b.serials.join(', ')}>{b.serials.length <= 4 ? b.serials.join(', ') : `${b.serials[0]} … ${b.serials.at(-1)} (${b.serials.length})`}</span>}
            {b.measured.durationS === undefined ? null : (
              <span>{formatDuration(b.measured.durationS)}{est?.durationS === undefined ? '' : <span className="text-faint"> (est. {formatDuration(est.durationS)})</span>}</span>
            )}
            {b.measured.unitMassG === undefined ? null : (
              <span title="One good unit: weighed, and derived from the parts' recorded masses (≥: some part has none)">
                {formatQty(b.measured.unitMassG, 'mass')} measured
                {b.massEstimate === undefined || formatMassValue(b.massEstimate) === undefined ? null : <span className="text-faint"> · {formatMassValue(b.massEstimate)} derived</span>}
                {est?.unitMassG === undefined ? null : <span className="text-faint"> (est. {formatQty(est.unitMassG, 'mass')})</span>}
              </span>
            )}
            {b.variant === undefined ? null : <span className="text-faint">{variantName?.(b.variant) ?? 'variant'}</span>}
            {b.outputLot === undefined ? null : <span className="text-faint">→ {lotName?.(b.outputLot) ?? 'stock'}</span>}
            {!canReturn || b.reservation === undefined ? null : <ReturnLeftoverButton reservation={b.reservation} />}
            {b.note === undefined ? null : <span className="min-w-0 truncate text-dim">{b.note}</span>}
          </li>
        );
      })}
    </ul>
  );
}
