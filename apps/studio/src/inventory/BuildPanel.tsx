/**
 * A design's Build / shortages strip: build quantity and cut allowance in, per item needed vs free
 * vs held, short, and the make/buy hint; Reserve, then finish units (some now, the rest later, with
 * serials and a batch code), return a cut-off or release from the open reservations; the batches
 * made so far. Collapsed it is one line under the header.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, NumberInput } from '@wirehub/editor-react';
import { IconChevronRight } from '@tabler/icons-react';
import { useState, type JSX, type ReactNode } from 'react';
import { toast } from 'sonner';

import { money } from '../sourcing.browser.ts';
import { buildKey, fetchBuild, formatQty, inventoryKey, releaseReservation, reserveBuild, type Allowance, type Reservation } from '../inventory.browser.ts';
import { ItemLink, Qty } from '../routes/InventoryRoute.tsx';
import { RouteChip } from '../shell/RouteChip.tsx';
import { BatchList, CompleteDialog, shortLines } from './batches.tsx';
import { kindLabel } from './dialogs.tsx';
import { DesignUnits } from './units.tsx';
import { ReturnDialog } from './ReturnLeftover.tsx';
import { costTitle, SourcingFoot, wasteTitle } from './sourcing.tsx';

/**
 * `lead` and `end` share the strip's one row (the design editor puts Used in and the cover there), so
 * the canvas keeps the height; without inventory the row still carries them.
 */
export function BuildPanel({ design, readOnly, lead, end }: { design: string; readOnly: boolean; lead?: ReactNode; end?: ReactNode }): JSX.Element | null {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<number | null>(1);
  const [allowance, setAllowance] = useState<Allowance>({ perCutMm: 0, pct: 0 });
  const [returning, setReturning] = useState<Reservation>();
  const [finishing, setFinishing] = useState<Reservation>();
  // list the parts of placed sub-assemblies instead of one line each (build them here, not from stock)
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const buildQty = qty === null || qty < 1 ? 1 : Math.round(qty);
  const query = useQuery({ queryKey: buildKey(design, buildQty, allowance, explode), queryFn: async () => { const out = await fetchBuild(design, buildQty, allowance, explode); return out.ok ? out.value : null; }, retry: false, placeholderData: (prev) => prev });
  const view = query.data;
  if (view === null) {
    if (lead === undefined && end === undefined) return null;
    return <div data-testid="design-strip" className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-raised px-3 py-1 text-xs">{lead}<span className="flex-1" />{end}</div>;
  }
  const refresh = (): void => void client.invalidateQueries({ queryKey: inventoryKey });
  const lines = view?.lines ?? [];
  const shortCount = lines.filter((l) => (l.short ?? 0) > 0 || l.unknown !== undefined || l.noFit !== undefined).length;
  // optional: cost from lot costs and offers, where cut stock goes; a column only once anything is priced
  const sourcing = new Map((view?.sourcing?.lines ?? []).map((s) => [s.key, s]));
  const priced = (view?.sourcing?.lines ?? []).some((s) => s.cost !== undefined);
  const open_ = view?.reservations ?? [];
  const act = async (what: string, run: () => Promise<{ ok: boolean; message?: string; hint?: string }>): Promise<void> => {
    setBusy(true);
    const out = await run();
    setBusy(false);
    if (!out.ok) toast.error(out.message ?? 'Refused.', { description: out.hint });
    else toast.success(what);
    refresh();
  };
  // shortages only mean something once stock is tracked: before that the strip is just its toggle
  const tracked = open_.length > 0 || lines.some((l) => l.free > 0 || l.reservedHere > 0 || l.consumedHere > 0);
  const summary = view === undefined || !tracked ? '' : shortCount === 0 ? `${lines.length} items · all in stock` : `${lines.length} items · ${shortCount} short`;
  return (
    <div data-testid="build-panel" className="shrink-0 border-b border-line bg-raised text-xs">
      <div data-testid="design-strip" className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 font-medium text-ink" title={open ? 'Hide the build sheet' : 'Quantities, stock, shortages, reserve'}>
          <IconChevronRight size={12} aria-hidden className={open ? 'rotate-90 text-faint' : 'text-faint'} /> Build
        </button>
        {summary === '' ? null : <span className={shortCount > 0 ? 'text-warn' : 'text-dim'}>{summary}</span>}
        {open_.length === 0 ? null : <span className="text-dim">{open_.length} open reservation{open_.length === 1 ? '' : 's'}</span>}
        {lead}
        <span className="flex-1" />
        {!open ? end : (
          <>
            <label className="flex items-center gap-1 text-dim">Qty <NumberInput aria-label="Build quantity" value={qty} onChange={setQty} min={1} step={1} precision={0} size="xs" className="w-16" /></label>
            <label className="flex items-center gap-1 text-dim" title="Extra length cut per wire piece: strip, trim, service">+ per cut <NumberInput aria-label="Allowance per cut" value={allowance.perCutMm} onChange={(v) => setAllowance({ ...allowance, perCutMm: v ?? 0 })} min={0} unit="mm" size="xs" className="w-20" /></label>
            <label className="flex items-center gap-1 text-dim" title="Scrap on cut or weighed stock (never on counted parts)">scrap <NumberInput aria-label="Scrap percent" value={allowance.pct} onChange={(v) => setAllowance({ ...allowance, pct: v ?? 0 })} min={0} max={200} unit="%" size="xs" className="w-16" /></label>
            {lines.some((l) => l.item.kind === 'designs') || explode ? <Checkbox checked={explode} onCheckedChange={setExplode} label="sub-assembly parts" /> : null}
            {readOnly ? null : (
              <Button size="xs" variant="primary" disabled={busy || view === undefined} onClick={() => void act(`Reserved ${buildQty} × ${view?.label ?? 'design'}.`, () => reserveBuild(design, buildQty, allowance, explode))}>
                Reserve
              </Button>
            )}
            {end}
          </>
        )}
      </div>
      {!open || view === undefined ? null : (
        <div className="max-h-72 overflow-auto px-3 pb-2">
          <table className="w-full" data-testid="build-lines">
            <thead className="text-2xs text-faint">
              <tr>
                <th className="text-left font-normal">Item</th>
                <th className="text-left font-normal">Kind</th>
                <th className="text-right font-normal">Per unit</th>
                <th className="text-right font-normal">Needed</th>
                <th className="text-right font-normal">Free</th>
                <th className="text-right font-normal">Held here</th>
                <th className="text-right font-normal">Used</th>
                <th className="text-right font-normal">Short</th>
                {priced ? <th className="text-right font-normal">Cost</th> : null}
                <th className="pl-3 text-left font-normal">Hint</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const src = sourcing.get(`${l.item.kind}:${l.item.id}`);
                // a cut that fits no free reel is bought whole: show that, not the bare shortfall
                const rawShort = l.short ?? 0;
                const short = l.short !== undefined && (src?.waste?.buy ?? 0) > rawShort ? src!.waste!.buy : rawShort;
                const wholeCut = short > rawShort ? `${formatQty(short, l.dim)} to buy: ${formatQty(rawShort, l.dim)} short in total, but a cut that fits no free reel is bought whole` : undefined;
                return (
                  <tr key={`${l.item.kind}:${l.item.id}`} data-item={`${l.item.kind}:${l.item.id}`} className="border-t border-line">
                    <td className="py-0.5 pr-2"><ItemLink item={l.item} label={l.label} />{l.partNumber === undefined ? null : <span className="ml-1 font-mono text-2xs text-faint">{l.partNumber}</span>}</td>
                    <td className="pr-2 text-dim">{kindLabel(l.item.kind)}</td>
                    <td className="text-right text-dim" title={l.pieces === undefined ? undefined : `cuts: ${l.pieces.map((p) => formatQty(p, 'length')).join(', ')}`}>{formatQty(l.perUnit, l.dim)}{l.pieces === undefined || l.pieces.length < 2 ? '' : ` (${l.pieces.length} cuts)`}</td>
                    <td className="text-right" title={src?.waste === undefined ? undefined : wasteTitle(src.waste)}>{l.needed !== undefined ? <Qty value={l.needed} dim={l.dim} /> : <span className="text-warn" title={(l.missing ?? [l.unknown ?? '']).join('\n')}>{l.neededAtLeast === undefined ? 'unknown' : `≥ ${formatQty(l.neededAtLeast, l.dim)}`}</span>}</td>
                    <td className="text-right"><Qty value={l.free} dim={l.dim} tone={l.free === 0 ? 'dim' : undefined} /></td>
                    <td className="text-right">{l.reservedHere === 0 ? '' : <Qty value={l.reservedHere} dim={l.dim} />}</td>
                    <td className="text-right">{l.consumedHere === 0 ? '' : <Qty value={l.consumedHere} dim={l.dim} tone="dim" />}</td>
                    <td className="text-right">{l.short === undefined ? (l.shortAtLeast === undefined || l.shortAtLeast === 0 ? '' : <span className="text-err" title="At least: some runs have no length yet">≥ {formatQty(l.shortAtLeast, l.dim)}</span>) : short === 0 ? <span className="text-ok">0</span> : l.shortAtMost === true ? <span className="text-err" title="At most: lots counted another way may cover part of it">≤ {formatQty(short, l.dim)}</span> : <span title={wholeCut === undefined ? undefined : `${wholeCut}\n\n${wasteTitle(src!.waste!)}`}><Qty value={short} dim={l.dim} tone="err" /></span>}</td>
                    {priced ? <td className="whitespace-nowrap text-right" title={src?.cost === undefined ? undefined : costTitle(src.cost, l.dim)}>{src?.cost === undefined ? '' : src.cost.amount === undefined ? <span className="text-faint">—</span> : `${src.cost.atLeast === true ? '≥ ' : ''}${money(src.cost.amount, src.cost.currency)}`}</td> : null}
                    <td className="pl-3">
                      <span className="flex items-center gap-1">
                        {short > 0 || l.needed === undefined ? <RouteChip route={l.route.route} maker={l.route.maker} /> : null}
                        <span className="text-dim">
                          {short > 0 ? (l.route.route === 'make' ? `make ${l.dim === 'count' ? short : ''}`.trim() : l.route.supplier === undefined ? '' : l.route.supplier) : ''}
                          {short > 0 && l.route.assumed ? <span className="text-faint" title="The record names no route; this is the default for its kind."> (assumed)</span> : null}
                          {l.noFit === undefined ? null : <span className="text-warn"> no reel holds a {formatQty(l.noFit, 'length')} cut</span>}
                          {short > 0 && src?.waste?.packs !== undefined ? <span> · {src.waste.packs} × {formatQty(src.waste.pack!, 'length')}</span> : null}
                          {l.otherDim === undefined ? null : <span className="text-faint"> · {l.otherDim} lot(s) counted another way</span>}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {view.gaps.length === 0 ? null : <div className="pt-1 text-faint">BOM gaps: {view.gaps.join('; ')}</div>}
          {view.sourcing === undefined ? null : <SourcingFoot sourcing={view.sourcing} buildQty={view.buildQty} />}
          {open_.length === 0 ? null : (
            <div className="mt-2 flex flex-col gap-1" data-testid="build-reservations">
              {open_.map((r) => {
                const short = shortLines(r);
                const used = r.lines.some((l) => l.allocations.some((a) => a.consumed > 0));
                return (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-sm border border-line px-2 py-1" data-reservation={r.id} title="Build reservation">
                    <span>× {r.buildQty}{r.label === undefined ? '' : ` · ${r.label}`}</span>
                    <span className={(r.unitsDone ?? 0) > 0 ? 'text-ok' : 'text-dim'} data-testid="units-done">{r.unitsDone ?? 0}/{r.buildQty} done</span>
                    <span className={short > 0 ? 'text-warn' : 'text-dim'}>{short > 0 ? `${short} short` : 'all held'}{r.allowance.perCutMm > 0 || r.allowance.pct > 0 ? <span className="text-dim"> · +{r.allowance.perCutMm} mm/cut, {r.allowance.pct}% scrap</span> : ''}</span>
                    <span className="flex-1" />
                    {readOnly ? null : (
                      <>
                        <Button size="xs" variant="primary" disabled={busy} onClick={() => setFinishing(r)}>Finish units…</Button>
                        {used ? <Button size="xs" disabled={busy} onClick={() => setReturning(r)}>Return…</Button> : null}
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('Released.', () => releaseReservation(r))}>Release</Button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {view.batches === undefined || view.batches.length === 0 ? null : (
            <div className="mt-2 flex flex-col gap-1" data-testid="build-batches">
              <div className="text-2xs font-medium uppercase tracking-wide text-faint">Made</div>
              <BatchList batches={view.batches} canReturn={!readOnly} />
            </div>
          )}
          <DesignUnits design={design} readOnly={readOnly} />
        </div>
      )}
      {finishing === undefined ? null : <CompleteDialog reservation={finishing} label={view?.label ?? 'design'} locations={view?.locations ?? []} onClose={() => setFinishing(undefined)} onDone={(b) => { refresh(); toast.success(`Recorded ${b.units} unit(s)${b.failed > 0 ? `, ${b.failed} failed` : ''}.`); }} />}
      {returning === undefined ? null : <ReturnDialog reservation={returning} onClose={() => setReturning(undefined)} onDone={() => { refresh(); toast.success('Returned.'); }} />}
    </div>
  );
}
