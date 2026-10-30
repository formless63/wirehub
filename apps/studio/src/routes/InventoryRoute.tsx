/**
 * `/inventory` (`docs/inventory.md`): locations as a tree, the lots in them, open reservations,
 * batches made and the ledger. Receive, move, adjust, edit a lot's details, rename / move / remove a
 * location from here; reserve and finish units from a design's Build panel, record prints from a
 * record's Prepare print panel. Another browser's write refreshes it (the `inventory` server event).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, Checkbox, Chip, ConfirmDialog, DataTable, Dialog, Field, Input, KeyValues, Page, PageBody, SidePanel, Tab, TabList, TabPanel, Tabs, type DataColumn } from '@wirehub/editor-react';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { BatchList, EditLotDialog, LocationDialog } from '../inventory/batches.tsx';
import { UnitsTab } from '../inventory/units.tsx';
import { AdjustDialog, kindLabel, LocationSelect, MoveDialog, ReceiveDialog } from '../inventory/dialogs.tsx';
import { batchesKey, createLocation, deleteLocation, feetOf, fetchBatches, fetchInventory, fetchMovements, formatQty, inventoryKey, locationPaths, unwrap, type ItemRef, type Location, type Lot, type Movement, type Reservation } from '../inventory.browser.ts';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { useStudio } from '../studio-context.tsx';
import { localDate, localDateTime } from '../when.ts';

const LIBRARY_URL: Readonly<Record<string, string>> = { connectors: 'connectors', components: 'components', wires: 'wires', pcbas: 'boards', mechanicals: 'hardware' };

export function ItemLink({ item, label }: { item: ItemRef; label: string }): JSX.Element {
  if (item.kind === 'designs') {
    return <Link to="/cables/$id" params={{ id: item.id }} search={{ view: 'build' }} className="underline">{label}</Link>;
  }
  return <Link to="/library/$kind/$id" params={{ kind: LIBRARY_URL[item.kind] ?? item.kind, id: item.id }} className="underline">{label}</Link>;
}

export function Qty({ value, dim, tone }: { value: number; dim: Lot['dim']; tone?: 'warn' | 'err' | 'dim' }): JSX.Element {
  const cls = tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : tone === 'dim' ? 'text-faint' : undefined;
  return <span className={cls} title={dim === 'length' ? feetOf(value) : undefined}>{formatQty(value, dim)}</span>;
}

function LocationTree({ locations, lots, selected, onSelect }: { locations: readonly Location[]; lots: readonly Lot[]; selected: string | undefined; onSelect: (id: string | undefined) => void }): JSX.Element {
  const children = (parent: string | undefined) => locations.filter((l) => l.parent === parent).sort((a, b) => a.name.localeCompare(b.name));
  const count = (id: string): number => lots.filter((l) => l.location === id).length;
  const row = (l: Location, depth: number): JSX.Element => (
    <li key={l.id}>
      <button
        type="button"
        onClick={() => onSelect(l.id)}
        aria-current={selected === l.id ? 'true' : undefined}
        className={`flex w-full items-center gap-1 rounded-sm px-2 py-0.5 text-left text-xs hover:bg-hover ${selected === l.id ? 'bg-hover font-medium text-ink' : 'text-dim'}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <span className="min-w-0 flex-1 truncate">{l.name}</span>
        <span className="text-2xs text-faint">{count(l.id) || ''}</span>
      </button>
      <ul>{children(l.id).map((c) => row(c, depth + 1))}</ul>
    </li>
  );
  return (
    <nav aria-label="Locations" className="flex w-52 shrink-0 flex-col gap-0.5 overflow-auto border-r border-line py-2">
      <button type="button" onClick={() => onSelect(undefined)} className={`px-2 py-0.5 text-left text-xs hover:bg-hover ${selected === undefined ? 'bg-hover font-medium text-ink' : 'text-dim'}`}>
        All locations <span className="text-2xs text-faint">{lots.length}</span>
      </button>
      <ul>{children(undefined).map((l) => row(l, 0))}</ul>
    </nav>
  );
}

function NewLocationDialog({ locations, parent, onClose, onDone }: { locations: readonly Location[]; parent: string | undefined; onClose: () => void; onDone: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [inside, setInside] = useState<string | undefined>(parent);
  const [error, setError] = useState<string>();
  const submit = async (): Promise<void> => {
    if (name.trim() === '') return setError('Name it.');
    const out = await createLocation(name.trim(), inside);
    if (!out.ok) return setError(out.message);
    onDone();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())} title="New location" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void submit()}>Add</Button></>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Shelf B, Bin 3, Reel rack…" /></Field>
        {locations.length === 0 ? null : (
          <Field label="Inside">
            <div className="flex gap-2">
              <LocationSelect locations={locations} value={inside} onChange={setInside} label="Inside" />
              {inside === undefined ? null : <Button size="sm" variant="ghost" onClick={() => setInside(undefined)}>Top level</Button>}
            </div>
          </Field>
        )}
        {error === undefined ? null : <div role="alert" className="text-xs text-err">{error}</div>}
      </form>
    </Dialog>
  );
}

const MOVEMENT_LABEL: Readonly<Record<Movement['kind'], string>> = { receive: 'Received', move: 'Moved', split: 'Split', adjust: 'Adjusted', consume: 'Consumed', return: 'Returned', edit: 'Edited' };

/** A made lot's note from before serials stood alone (`made in bat-…: S1, S2`): just the serials. */
const noteText = (note: string | undefined): string | undefined => {
  const out = note?.replace(/^made in bat-[0-9a-f]+:?\s*/, '');
  return out === '' ? undefined : out;
};

/**
 * Ledger columns. `lots` gives a lot's code (shown before its id); `builds` names what a
 * reservation or batch built (the design or part), for the Reason / build column.
 */
export function movementColumns(labels: Record<string, string>, paths: Map<string, string>, dims: Map<string, Lot['dim']>, lots: Map<string, Lot> = new Map(), builds: Map<string, string> = new Map()): DataColumn<Movement>[] {
  const dimOf = (m: Movement): Lot['dim'] => dims.get(m.lot) ?? (m.item.kind === 'wires' ? 'length' : 'count');
  const why = (m: Movement): string => {
    const built = (m.batch === undefined ? undefined : builds.get(m.batch)) ?? (m.reservation === undefined ? undefined : builds.get(m.reservation));
    // a made lot's receipt: the item column already names what was made
    const what = built === undefined || built === (labels[`${m.item.kind}:${m.item.id}`] ?? 'Unavailable item') ? undefined : built;
    return [m.reason, what, noteText(m.note)].filter((v) => v !== undefined).join(' · ');
  };
  return [
    { id: 'seq', header: '#', width: 54, numeric: true, mono: true, sortValue: (m) => m.seq, cell: (m) => String(m.seq) },
    { id: 'at', header: 'When', width: 132, sortValue: (m) => m.at, cell: (m) => <span title={m.at}>{localDateTime(m.at)}</span> },
    { id: 'kind', header: 'What', width: 84, cell: (m) => MOVEMENT_LABEL[m.kind] },
    { id: 'item', header: 'Item', width: 220, cell: (m) => <ItemLink item={m.item} label={labels[`${m.item.kind}:${m.item.id}`] ?? 'Unavailable item'} /> },
    { id: 'lot', header: 'Lot', width: 112, mono: true, cell: (m) => { const code = lots.get(m.lot)?.lotCode; return <span title={m.lot}>{code ?? m.lot}</span>; } },
    { id: 'qty', header: 'Qty', width: 90, numeric: true, cell: (m) => (m.qty === 0 ? '' : <span className={m.qty < 0 ? 'text-warn' : 'text-ok'}>{m.qty > 0 ? '+' : '−'}{formatQty(Math.abs(m.qty), dimOf(m))}</span>) },
    { id: 'after', header: 'After', width: 84, numeric: true, cell: (m) => formatQty(m.onHandAfter, dimOf(m)) },
    { id: 'where', header: 'Where', width: 180, cell: (m) => (m.from !== undefined && m.to !== undefined ? `${paths.get(m.from) ?? m.from} → ${paths.get(m.to) ?? m.to}` : m.to !== undefined ? (paths.get(m.to) ?? m.to) : '') },
    { id: 'why', header: 'Reason / build', width: 220, cell: (m) => <span title={[m.reservation, m.batch].filter((v) => v !== undefined).join(' · ') || undefined}>{why(m)}</span> },
    { id: 'by', header: 'By', width: 120, cell: (m) => m.by },
  ];
}

export function InventoryRoute(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const [tab, setTab] = useState<'stock' | 'reservations' | 'batches' | 'units' | 'ledger'>('stock');
  const [showEmpty, setShowEmpty] = useState(false);
  const query = useQuery({ queryKey: [...inventoryKey, showEmpty], queryFn: () => unwrap(fetchInventory(showEmpty)), retry: false });
  const ledger = useQuery({ queryKey: [...inventoryKey, 'ledger'], queryFn: () => unwrap(fetchMovements({ limit: 300 })), retry: false, enabled: tab === 'ledger' });
  const batches = useQuery({ queryKey: batchesKey(), queryFn: () => unwrap(fetchBatches({ limit: 300 })), retry: false, enabled: tab === 'batches' || tab === 'ledger' });
  const [location, setLocation] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [dialog, setDialog] = useState<'receive' | 'location' | 'move' | 'adjust' | 'edit-lot' | 'edit-location' | 'delete-location'>();
  const [deleting, setDeleting] = useState(false);
  const view = query.data;
  const paths = useMemo(() => locationPaths(view?.locations ?? []), [view]);
  const refresh = (): void => void client.invalidateQueries({ queryKey: inventoryKey });

  // a location shows what is in it and in the locations inside it
  const within = useMemo(() => {
    if (location === undefined || view === undefined) return undefined;
    const ids = new Set([location]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const l of view.locations) if (l.parent !== undefined && ids.has(l.parent) && !ids.has(l.id)) { ids.add(l.id); grew = true; }
    }
    return ids;
  }, [location, view]);
  const lots = (view?.lots ?? []).filter((l) => within === undefined || within.has(l.location));
  const lot = view?.lots.find((l) => l.id === selected);
  const here = view?.locations.find((l) => l.id === location);
  const removeLocation = async (): Promise<void> => {
    if (here === undefined) return;
    setDeleting(true);
    const out = await deleteLocation(here);
    setDeleting(false);
    setDialog(undefined);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    toast.success(`Removed ${here.name}.`);
    setLocation(here.parent);
    refresh();
  };
  const label = (l: Lot): string => view?.labels[`${l.item.kind}:${l.item.id}`] ?? 'Unavailable item';

  const lotColumns = useMemo((): DataColumn<Lot>[] => [
    { id: 'item', header: 'Item', width: 260, fixed: true, sortValue: (l) => label(l), cell: (l) => <ItemLink item={l.item} label={label(l)} /> },
    { id: 'kind', header: 'Kind', width: 90, sortValue: (l) => l.item.kind, cell: (l) => kindLabel(l.item.kind) },
    { id: 'lot', header: 'Lot', width: 110, mono: true, sortValue: (l) => l.lotCode ?? '', cell: (l) => l.lotCode || `Received ${localDateTime(l.receivedAt, true)}` },
    { id: 'location', header: 'Location', width: 190, fixed: true, sortValue: (l) => paths.get(l.location) ?? '', cell: (l) => paths.get(l.location) ?? 'Unavailable location' },
    { id: 'onHand', header: 'On hand', width: 90, fixed: true, numeric: true, sortValue: (l) => l.onHand, cell: (l) => <Qty value={l.onHand} dim={l.dim} tone={l.onHand === 0 ? 'dim' : undefined} /> },
    { id: 'reserved', header: 'Held', width: 80, numeric: true, sortValue: (l) => l.reserved, cell: (l) => (l.reserved === 0 ? '' : <Qty value={l.reserved} dim={l.dim} tone="warn" />) },
    { id: 'free', header: 'Free', width: 80, fixed: true, numeric: true, sortValue: (l) => l.onHand - l.reserved, cell: (l) => <Qty value={l.onHand - l.reserved} dim={l.dim} /> },
    { id: 'supplier', header: 'Supplier', width: 150, sortValue: (l) => l.supplier ?? '', cell: (l) => [l.supplier, l.supplierRef].filter(Boolean).join(' · ') },
    { id: 'cost', header: 'Unit cost', width: 90, numeric: true, cell: (l) => (l.unitCost === undefined ? '' : `${(l.unitCost * (l.dim === 'length' ? 1000 : 1)).toFixed(2)}${l.currency === undefined ? '' : ` ${l.currency}`}${l.dim === 'length' ? '/m' : ''}`) },
    { id: 'received', header: 'Received', width: 96, sortValue: (l) => l.receivedAt, cell: (l) => <span title={l.receivedAt}>{localDate(l.receivedAt)}</span> },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [view, paths]);

  const resColumns = useMemo((): DataColumn<Reservation>[] => [
    { id: 'design', header: 'Design', width: 220, sortValue: (r) => r.design, cell: (r) => <ItemLink item={{ kind: 'designs', id: r.design }} label={view?.labels[`designs:${r.design}`] ?? 'Unavailable design'} /> },
    { id: 'qty', header: 'Build', width: 60, numeric: true, cell: (r) => `× ${r.buildQty}` },
    { id: 'label', header: 'Label', width: 160, cell: (r) => r.label ?? '' },
    { id: 'held', header: 'Lines held', width: 110, cell: (r) => {
      const full = r.lines.filter((l) => l.allocations.reduce((s, a) => s + a.qty, 0) >= l.needed - 1e-6).length;
      return <span className={full < r.lines.length ? 'text-warn' : undefined}>{full}/{r.lines.length} full</span>;
    } },
    { id: 'created', header: 'Created', width: 140, sortValue: (r) => r.createdAt, cell: (r) => `${localDate(r.createdAt)} · ${r.createdBy}` },
  ], [view]);

  const dims = useMemo(() => new Map((view?.lots ?? []).map((l) => [l.id, l.dim])), [view]);
  // used-up lots drop out of the stock view; the ledger and Made lists bring their own names
  const labels = useMemo((): Record<string, string> => ({ ...ledger.data?.labels, ...batches.data?.labels, ...view?.labels }), [view, ledger.data, batches.data]);
  const builds = useMemo(() => {
    const name = (item: ItemRef): string => labels[`${item.kind}:${item.id}`] ?? 'Unavailable item';
    const out = new Map<string, string>();
    for (const r of view?.reservations ?? []) out.set(r.id, name({ kind: 'designs', id: r.design }));
    for (const b of batches.data?.batches ?? []) {
      out.set(b.id, name(b.item));
      if (b.reservation !== undefined) out.set(b.reservation, name(b.item));
    }
    return out;
  }, [view, batches.data, labels]);
  const lotsById = useMemo(() => new Map((view?.lots ?? []).map((l) => [l.id, l])), [view]);
  const ledgerColumns = useMemo(() => movementColumns(labels, paths, dims, lotsById, builds), [labels, paths, dims, lotsById, builds]);
  const lotMovements = useQuery({ queryKey: [...inventoryKey, 'lot', selected], queryFn: () => unwrap(fetchMovements({ lot: selected!, limit: 30 })), enabled: selected !== undefined });

  return (
    <Page testId="inventory">
      <RouteHeader
        title="Inventory"
        help={false}
        count={view === undefined ? undefined : `${view.lots.length} lots · ${view.locations.length} locations${view.reservations.length === 0 ? '' : ` · ${view.reservations.length} open builds`}`}
        secondary={readOnly ? undefined : <Button onClick={() => setDialog('location')}>New location…</Button>}
        primary={readOnly ? undefined : <Button variant="primary" disabled={view === undefined} onClick={() => setDialog('receive')}>Receive…</Button>}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex min-h-0 flex-1 flex-col">
        <TabList aria-label="inventory" className="px-4">
          <Tab value="stock">Stock</Tab>
          <Tab value="reservations">Reservations{view === undefined || view.reservations.length === 0 ? '' : ` (${view.reservations.length})`}</Tab>
          <Tab value="batches">Made</Tab>
          <Tab value="units">Units</Tab>
          <Tab value="ledger">Ledger</Tab>
        </TabList>
        <TabPanel value="stock" className="flex min-h-0 flex-1">
          <LocationTree locations={view?.locations ?? []} lots={view?.lots ?? []} selected={location} onSelect={setLocation} />
          <PageBody
            className="min-w-0 flex-1"
            panel={
              lot === undefined ? undefined : (
                <SidePanel
                  title={label(lot)}
                  subtitle={lot.lotCode || `Received ${localDateTime(lot.receivedAt, true)}`}
                  chips={<><Chip>{kindLabel(lot.item.kind)}</Chip>{lot.reserved > 0 ? <Chip tone="warn">held {formatQty(lot.reserved, lot.dim)}</Chip> : null}</>}
                  onClose={() => setSelected(undefined)}
                  label="Lot details"
                  footer={readOnly ? undefined : <><Button onClick={() => setDialog('move')}>Move…</Button><Button onClick={() => setDialog('adjust')}>Adjust…</Button><Button onClick={() => setDialog('edit-lot')}>Details…</Button></>}
                >
                  <div className="flex flex-col gap-3">
                    <KeyValues
                      items={[
                        ['On hand', <Qty key="o" value={lot.onHand} dim={lot.dim} />],
                        ['Free', <Qty key="f" value={lot.onHand - lot.reserved} dim={lot.dim} />],
                        ['Location', paths.get(lot.location) ?? 'Unavailable location'],
                        ['Lot code', lot.lotCode ?? '—'],
                        ['Supplier', [lot.supplier, lot.supplierRef].filter(Boolean).join(' · ') || '—'],
                        ...(lot.unitCost === undefined ? [] : [['Unit cost', `${(lot.unitCost * (lot.dim === 'length' ? 1000 : 1)).toFixed(2)}${lot.currency === undefined ? '' : ` ${lot.currency}`}${lot.dim === 'length' ? '/m' : ''}`] as const]),
                        ...(noteText(lot.note) === undefined ? [] : [['Note', noteText(lot.note)!] as const]),
                        ['Received', localDateTime(lot.receivedAt)],
                        ...(lot.parent === undefined ? [] : [['Split from', lot.parent] as const]),
                      ]}
                    />
                    <div className="text-2xs font-medium uppercase tracking-wide text-faint">Ledger</div>
                    <ul className="flex flex-col gap-0.5 text-xs">
                      {(lotMovements.data?.movements ?? []).map((m) => (
                        <li key={m.seq} className="flex gap-2" title={m.at}>
                          <span className="w-16 text-faint">{localDate(m.at).slice(5)}</span>
                          <span className="w-16">{MOVEMENT_LABEL[m.kind]}</span>
                          <span className={`w-20 text-right ${m.qty < 0 ? 'text-warn' : ''}`}>{m.qty === 0 ? '' : `${m.qty > 0 ? '+' : '−'}${formatQty(Math.abs(m.qty), lot.dim)}`}</span>
                          <span className="min-w-0 flex-1 truncate text-dim">{m.reason ?? noteText(m.note) ?? ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </SidePanel>
              )
            }
          >
            {query.isError ? (
              <div className="px-4 py-3 text-faint">{query.error instanceof Error ? query.error.message : 'The inventory could not be read.'}</div>
            ) : (
              <>
                <div className="flex items-center gap-3 px-4 py-1 text-xs text-dim">
                  <span>{location === undefined ? 'Everywhere' : paths.get(location)}</span>
                  {here === undefined || readOnly ? null : (
                    <>
                      <Button size="xs" variant="ghost" onClick={() => setDialog('edit-location')}>Rename / move…</Button>
                      <Button size="xs" variant="ghost" onClick={() => setDialog('delete-location')}>Remove</Button>
                    </>
                  )}
                  {here?.note === undefined ? null : <span className="text-faint">{here.note}</span>}
                  <Checkbox checked={showEmpty} onCheckedChange={setShowEmpty} label="show used-up lots" />
                </div>
                <DataTable
                  loading={view === undefined}
                  label="Lots"
                  testId="inventory-lots"
                  rows={lots}
                  columns={lotColumns}
                  getRowId={(l) => l.id}
                  selectedId={selected}
                  onSelect={(l) => setSelected(l.id)}
                  columnsKey="inventory-lots"
                  compact={lot !== undefined}
                  empty={<div className="px-4 py-3 text-faint">{view?.locations.length === 0 ? 'Add a location, then receive stock into it.' : 'No stock here.'}</div>}
                />
              </>
            )}
          </PageBody>
        </TabPanel>
        <TabPanel value="reservations" className="flex min-h-0 flex-1 flex-col">
          <DataTable label="Open reservations" testId="inventory-reservations" rows={view?.reservations ?? []} columns={resColumns} getRowId={(r) => r.id} columnsKey="inventory-reservations" empty={<div className="px-4 py-3 text-faint">Nothing held. Reserve from a design's Build panel.</div>} />
        </TabPanel>
        <TabPanel value="batches" className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-2">
          {batches.data === undefined ? <div className="text-faint">…</div> : batches.data.batches.length === 0 ? (
            <div className="text-faint">Nothing made yet. Finish units from a design's Build panel, or record a print from a part's Prepare print panel.</div>
          ) : (
            <BatchList canReturn={!readOnly} batches={batches.data.batches} labelOf={(b) => labels[`${b.item.kind}:${b.item.id}`] ?? 'Unavailable item'} />
          )}
        </TabPanel>
        <TabPanel value="units" className="flex min-h-0 flex-1 flex-col">
          {tab === 'units' ? <UnitsTab readOnly={readOnly} /> : null}
        </TabPanel>
        <TabPanel value="ledger" className="flex min-h-0 flex-1 flex-col">
          <DataTable loading={ledger.data === undefined} label="Ledger" testId="inventory-ledger" rows={ledger.data?.movements ?? []} columns={ledgerColumns} getRowId={(m) => String(m.seq)} columnsKey="inventory-ledger" empty={<div className="px-4 py-3 text-faint">No movements yet.</div>} />
        </TabPanel>
      </Tabs>
      {dialog === 'receive' && view !== undefined ? <ReceiveDialog open onClose={() => setDialog(undefined)} onDone={() => { refresh(); toast.success('Received.'); }} locations={view.locations} {...(location === undefined ? {} : { location })} /> : null}
      {dialog === 'location' && view !== undefined ? <NewLocationDialog locations={view.locations} parent={location} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
      {dialog === 'move' && lot !== undefined && view !== undefined ? <MoveDialog lot={lot} label={label(lot)} locations={view.locations} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
      {dialog === 'adjust' && lot !== undefined ? <AdjustDialog lot={lot} label={label(lot)} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
      {dialog === 'edit-lot' && lot !== undefined ? <EditLotDialog lot={lot} label={label(lot)} onClose={() => setDialog(undefined)} onDone={() => { refresh(); toast.success('Saved.'); }} /> : null}
      {dialog === 'edit-location' && here !== undefined && view !== undefined ? <LocationDialog location={here} locations={view.locations} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
      <ConfirmDialog open={dialog === 'delete-location' && here !== undefined} title={`Remove ${here?.name ?? 'location'}?`} confirmLabel="Remove" destructive busy={deleting} onConfirm={() => void removeLocation()} onCancel={() => setDialog(undefined)}>
        Only an empty location can go: no lots (even used-up ones) and no locations inside it. The ledger keeps where things were.
      </ConfirmDialog>
    </Page>
  );
}
