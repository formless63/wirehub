/**
 * Crimp steps on the bench build sheet: per connector, a table of its
 * cavities — the wire that goes in, the contact, seal and tool, the strip
 * length and the crimp height where the contact's datasheet (or the design)
 * gives one — and the cavities to plug. The tools a design needs are listed on
 * the kit page. Everything reads `cavityRows` from the model, the same rows
 * the BOM counts.
 */

import { cavityRows, designTools, type CableDesign, type CavityRow, type Db, type MechanicalDefinition } from '@wirehub/model';

import { escapeHtml } from '../text.ts';

/** a measurement as printed: at most three decimals, no trailing zeros */
const num = (n: number, _places?: number): string => String(Math.round(n * 1000) / 1000);

function partText(part: MechanicalDefinition | undefined): string {
  if (part === undefined) return '—';
  return part.partNumber === undefined ? part.label : `${part.partNumber} ${part.label}`;
}

function wireText(row: CavityRow): string {
  if (row.wires.length === 0) return '';
  return row.wires.map((w) => `${w.segment}.${w.path}${w.areaMm2 === undefined ? '' : ` (${num(w.areaMm2, 3)} mm²)`}`).join(' + ');
}

/** The crimp table for one connector instance; `''` when it has no cavities on record. */
export function crimpTableHtml(design: CableDesign, db: Db, instance: string): string {
  const rows = cavityRows(design, db, instance).filter((r) => r.contact !== undefined || r.seal !== undefined || r.plug !== undefined || r.wires.length > 0);
  if (rows.length === 0) return '';
  const crimped = rows.filter((r) => r.plug === undefined);
  const plugged = rows.filter((r) => r.plug !== undefined);
  const body = crimped
    .map(
      (r) =>
        `<tr><td><span class="cs-check"></span></td><td class="cs-num">${escapeHtml(r.pin)}</td><td>${escapeHtml(wireText(r))}</td><td>${escapeHtml(partText(r.contact))}</td><td>${escapeHtml(
          r.seal === undefined ? '' : partText(r.seal),
        )}</td><td class="cs-num">${escapeHtml(r.stripMm === undefined ? '' : `${num(r.stripMm, 2)} mm`)}</td><td class="cs-num">${escapeHtml(
          r.crimpHeightMm === undefined ? '' : `${num(r.crimpHeightMm, 3)} mm${r.crimpWidthMm === undefined ? '' : ` × ${num(r.crimpWidthMm, 3)}`}`,
        )}</td><td>${escapeHtml(r.tool === undefined ? '' : partText(r.tool))}</td></tr>`,
    )
    .join('');
  const table =
    crimped.length === 0
      ? ''
      : `<table class="cs-cut cs-crimp"><thead><tr><th></th><th class="cs-num">Cavity</th><th>Wire</th><th>Contact</th><th>Seal</th><th class="cs-num">Strip</th><th class="cs-num">Crimp height</th><th>Tool</th></tr></thead><tbody>${body}</tbody></table>`;
  const plugs =
    plugged.length === 0
      ? ''
      : `<p class="cs-legend"><strong>Plug unused cavities</strong> ${escapeHtml(plugged.map((r) => `${r.pin}: ${partText(r.plug)}`).join(' · '))}</p>`;
  return `${table}${plugs}`;
}

/** The tools the design's contacts need, as a list for the kit page; `''` when none. */
export function toolsHtml(design: CableDesign, db: Db): string {
  const tools = designTools(design, db);
  if (tools.length === 0) return '';
  return `<ul class="cs-notes">${tools
    .map((t) => `<li><span class="cs-check"></span> <span><strong>${escapeHtml(partText(t.tool))}</strong> <span class="cs-meta">for ${escapeHtml(t.contacts.join(', '))}</span></span></li>`)
    .join('')}</ul>`;
}
