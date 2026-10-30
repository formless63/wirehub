/** A library record's Stock: its lots by location, what builds hold, the last movements, Receive. */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, Section } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';

import { fetchItemStock, formatQty, inventoryKey, itemStockKey, locationPaths, type ItemRef, type Lot } from '../inventory.browser.ts';
import { Qty } from '../routes/InventoryRoute.tsx';
import { useSectionAdd } from '../shell/RecordSections.tsx';
import { AdjustDialog, MoveDialog, ReceiveDialog } from './dialogs.tsx';

export function StockPanel({ item, label, readOnly }: { item: ItemRef; label: string; readOnly: boolean }): JSX.Element | null {
  const client = useQueryClient();
  const query = useQuery({ queryKey: itemStockKey(item), queryFn: async () => { const out = await fetchItemStock(item); return out.ok ? out.value : null; }, retry: false });
  const [dialog, setDialog] = useState<{ kind: 'receive' } | { kind: 'move' | 'adjust'; lot: Lot }>();
  const stock = query.data;
  const lots = stock?.lots ?? [];
  const live = lots.filter((l) => l.onHand > 0 || l.reserved > 0);
  const reservations = stock?.reservations ?? [];
  // nothing stocked or held: the record's Add menu offers Receive instead of an empty box
  const empty = stock !== undefined && stock !== null && live.length === 0 && reservations.length === 0;
  const hosted = useSectionAdd('stock', 'Stock…', empty && !readOnly, () => setDialog({ kind: 'receive' }));
  // a hub that keeps no inventory: no panel
  if (stock === null) return null;
  const refresh = (): void => void client.invalidateQueries({ queryKey: inventoryKey });
  const dialogs = <>
    {dialog?.kind === 'receive' && stock !== undefined ? <ReceiveDialog open item={{ ...item, label }} locations={stock.locations} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
    {dialog?.kind === 'move' && stock !== undefined ? <MoveDialog lot={dialog.lot} label={label} locations={stock.locations} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
    {dialog?.kind === 'adjust' ? <AdjustDialog lot={dialog.lot} label={label} onClose={() => setDialog(undefined)} onDone={refresh} /> : null}
  </>;
  if (hosted && (empty || stock === undefined)) return dialogs;
  const dims = [...new Set(live.map((l) => l.dim))];
  const paths = locationPaths(stock?.locations ?? []);
  const total = (pick: (l: Lot) => number) => dims.map((d) => formatQty(live.filter((l) => l.dim === d).reduce((s, l) => s + pick(l), 0), d)).join(' + ') || '0';
  return (<>
    <Section id="stock" title="Stock" testId="stock-panel"
      summary={stock === undefined ? '…' : `${total((l) => l.onHand)} on hand · ${total((l) => l.onHand - l.reserved)} free`}
      actions={<>
        <Link to="/inventory" className="cs-ui-btn no-underline" data-variant="ghost" data-size="xs">Inventory</Link>
        {readOnly || stock === undefined ? null : <Button size="xs" onClick={() => setDialog({ kind: 'receive' })}>Receive…</Button>}
      </>}>
      {live.length === 0 && reservations.length === 0 ? null : <div className="flex flex-col gap-1">
        {live.length === 0 ? null : (
          <table className="w-full">
            <thead className="text-2xs text-faint">
              <tr><th className="text-left font-normal">Location</th><th className="text-left font-normal">Lot</th><th className="text-right font-normal">On hand</th><th className="text-right font-normal">Held</th><th /></tr>
            </thead>
            <tbody>
              {live.map((l) => (
                <tr key={l.id} data-lot={l.id}>
                  <td className="truncate pr-2">{paths.get(l.location) ?? l.location}</td>
                  <td className="pr-2 font-mono text-2xs text-dim" title={l.lotCode || l.receivedAt}>{l.lotCode ?? <span className="text-faint">—</span>}</td>
                  <td className="text-right"><Qty value={l.onHand} dim={l.dim} /></td>
                  <td className="text-right">{l.reserved === 0 ? '' : <Qty value={l.reserved} dim={l.dim} tone="warn" />}</td>
                  <td className="whitespace-nowrap pl-2 text-right">
                    {readOnly ? null : (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => setDialog({ kind: 'move', lot: l })}>Move</Button>
                        <Button size="xs" variant="ghost" onClick={() => setDialog({ kind: 'adjust', lot: l })}>Adjust</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {reservations.length === 0 ? null : (
          <div className="text-dim">
            Held for{' '}
            {reservations.map((r, i) => (
              <span key={r.id}>
                {i === 0 ? '' : ', '}
                <Link to="/cables/$id" params={{ id: r.design }} search={{ view: 'build' }} className="underline">{r.design}</Link> × {r.buildQty}
              </span>
            ))}
          </div>
        )}
      </div>}
    </Section>
    {dialogs}
  </>);
}
