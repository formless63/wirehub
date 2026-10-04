/**
 * The breakout list of a bench sheet: per mould, what
 * passes through it uncut, what is terminated in it and on what, and what is
 * cut back there and why — read from core's `breakoutViews`. The foil is never
 * indicated (owner 2026-09-25).
 */

import { breakoutViews, isTrimmedFoil, type CableDesign, type Db } from '@wirehub/model';

import { escapeHtml, facts } from '../text.ts';
import { lengthFromMm } from '../units.ts';

/** The moulds of the design (or those on one trunk end): every conductor's fate. */
export function breakoutSection(design: CableDesign, db: Db, side?: 'a' | 'b'): string {
  const views = breakoutViews(design, db).filter((view) => side === undefined || view.trunk.end === side);
  if (views.length === 0) return '';
  const refText = (r: { instance: string; terminal: string; end?: 'a' | 'b' }): string =>
    `${r.instance} ${r.terminal}${r.end === undefined ? '' : ` @${r.end}`}`;
  const parts: string[] = ['<section class="cs-section cs-breakouts">', '<h2 class="cs-section__h">Breakouts</h2>'];
  for (const view of views) {
    const mould = view.mould === undefined ? 'no mould part named' : facts([view.mould.label ?? view.mould.def, view.mould.partNumber ?? 'no part number yet', view.mould.instance]);
    const legs = view.legs
      .map((l) => `${l.segment} (${l.lengthMm === undefined ? 'length TBD' : lengthFromMm(l.lengthMm).text}${l.through.length > 0 ? ', runs through uncut' : ''})`)
      .join(', ');
    parts.push(
      `<p class="cs-meta"><strong>${escapeHtml(view.id)}</strong> · ${escapeHtml(mould)} · trunk ${escapeHtml(`${view.trunk.segment} @${view.trunk.end}`)} · legs ${escapeHtml(legs)}${
        view.housed.length > 0 ? ` · housed: ${escapeHtml(view.housed.join(', '))}` : ''
      }</p>`,
    );
    // the foil is never indicated (owner 2026-09-25): it is trimmed back with the drain
    const shown = view.rows.filter((row) => {
      const def = design.instances.segments.find((s) => s.id === row.segment)?.def;
      const wire = def === undefined ? undefined : db.wires.find((w) => w.id === def);
      return wire === undefined || !isTrimmedFoil(wire, row.path);
    });
    const items = shown.map((row) => {
      const what = `${row.segment} ${row.path}`;
      const fate =
        row.fate === 'through'
          ? `passes through uncut → ${row.to.map(refText).join(', ')}`
          : row.fate === 'terminated'
            ? `terminated in the mould on ${row.to.map(refText).join(', ') || '— nothing (fix)'}`
            : `NC — ${row.reason ?? 'no reason given'}`;
      return `<li><span class="cs-tag">${escapeHtml(row.fate === 'nc' ? 'NC' : row.fate)}</span> <span>${escapeHtml(what)}: ${escapeHtml(fate)}</span></li>`;
    });
    parts.push(`<ul class="cs-notes">${items.join('')}</ul>`);
  }
  parts.push('</section>');
  return parts.join('');
}
