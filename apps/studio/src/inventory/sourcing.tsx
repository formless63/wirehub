/** The build sheet's optional sourcing bits: hover text for a line's cost and cut waste, one footer line. */

import type { JSX } from 'react';

import { formatQty, type Dimension } from '../inventory.browser.ts';
import { money, totalsText, type LineCost, type SourcingSummary, type Waste } from '../sourcing.browser.ts';

const L = (mm: number): string => formatQty(mm, 'length');

export function costTitle(cost: LineCost, dim: Dimension): string {
  const rows = cost.parts.map((p) => {
    const what = p.from === 'stock' ? 'from stock' : p.from === 'catalog' ? 'buy (catalog price)' : p.supplier === undefined ? 'buy' : `buy from ${p.supplier}${p.offeredOn === undefined ? '' : ` (${p.offeredOn})`}`;
    const packs = p.packs === undefined || p.pack === undefined ? '' : ` in ${p.packs} × ${formatQty(p.pack, dim)}`;
    return `${formatQty(p.qty, dim)} ${what}${packs}: ${p.amount === undefined ? 'no price' : money(p.amount, p.currency)}`;
  });
  if (cost.atLeast === true) rows.push('At least: some runs have no length yet');
  if (cost.reason !== undefined) rows.push(`Not totalled: ${cost.reason}`);
  return rows.join('\n');
}

export function wasteTitle(w: Waste): string {
  const rows = [`Cut ${L(w.cut)}`];
  if (w.allowance > 0) rows.push(`+ ${L(w.allowance)} allowance`);
  if (w.scrap > 0) rows.push(`+ ${L(w.scrap)} scrap`);
  if (w.fromStock > 0) rows.push(`${L(w.fromStock)} from free reels${w.drop > 0 ? `, leaving ${L(w.drop)} in drops` : ''}`);
  if (w.buy > 0) rows.push(`${L(w.buy)} to buy${w.packs === undefined || w.pack === undefined ? '' : `: ${w.packs} × ${L(w.pack)}${w.leftover === undefined || w.leftover <= 0 ? '' : `, ${L(w.leftover)} left over`}`}`);
  if (w.tooLong !== undefined) rows.push(`A ${L(w.tooLong)} cut is longer than one pack`);
  return rows.join('\n');
}

// a saved fx-rates snapshot turns the per-currency totals into one figure, shown on hover only
const convertedText = (s: SourcingSummary): string => {
  const c = s.converted;
  if (c === undefined || (Object.keys(s.totals).length === 1 && s.totals[c.currency] !== undefined)) return '';
  return `\n${s.atLeast ? '≥' : '≈'} ${money(c.amount, c.currency)} at ${c.date} reference rates (${c.source})`;
};

/** One line: the build's cost (per currency) and the wire it wastes. Nothing when neither is known. */
export function SourcingFoot({ sourcing, buildQty }: { sourcing: SourcingSummary; buildQty: number }): JSX.Element | null {
  const total = totalsText(sourcing.totals);
  const wastes = sourcing.lines.flatMap((l) => (l.waste === undefined ? [] : [l.waste]));
  const lost = wastes.reduce((s, w) => s + w.allowance + w.scrap + w.drop, 0);
  if (total === '' && lost === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 pt-1 text-dim" data-testid="build-sourcing">
      {total === '' ? null : (
        <span title={`${buildQty} unit${buildQty === 1 ? '' : 's'}: stock at its lot costs, the rest at the newest dated offer or catalog price${convertedText(sourcing)}`}>
          Cost {sourcing.atLeast ? '≥ ' : ''}<span className="text-ink">{total}</span>
          {sourcing.unpriced > 0 ? <span className="text-faint"> · {sourcing.unpriced} unpriced</span> : null}
        </span>
      )}
      {lost === 0 ? null : (
        <span title={wastes.map(wasteTitle).join('\n\n')}>
          Wire waste <span className="text-ink">{L(lost)}</span>
          <span className="text-faint"> ({[['allowance', wastes.reduce((s, w) => s + w.allowance, 0)], ['scrap', wastes.reduce((s, w) => s + w.scrap, 0)], ['drops', wastes.reduce((s, w) => s + w.drop, 0)]].filter(([, v]) => (v as number) > 0).map(([k, v]) => `${L(v as number)} ${k as string}`).join(', ')})</span>
        </span>
      )}
    </div>
  );
}
