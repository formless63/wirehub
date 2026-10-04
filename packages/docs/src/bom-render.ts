/**
 * The BOM, rendered.
 *
 * Two renderers over one derivation, deliberately printing the *same* columns
 * in the same order — a markdown BOM pasted into a work order and an HTML BOM
 * on a build sheet must never disagree about a quantity, so neither renderer
 * is allowed to compute anything. They only format `Bom`.
 *
 * `bomToHtml` returns a **fragment** (`<section class="cs-section cs-bom">`),
 * not a document: the build sheet embeds it, and a host app can drop it into
 * its own page. Every class name is `cs-`-prefixed so it cannot collide, and
 * the fragment references no stylesheet, script, font or image of its own.
 */

import { bomCategoryLabel, type Bom, type BomLine } from './bom.ts';
import { escapeHtml, facts, htmlTable, markdownTable } from './text.ts';

const HEADERS = [
  'Qty',
  'Type',
  'Part',
  'Part no.',
  'Value / length',
  'Location',
  'Refs',
  'Notes',
];
const ALIGN: ('left' | 'right')[] = ['right'];

function row(line: BomLine): string[] {
  return [
    `${line.qty}`,
    bomCategoryLabel(line.category),
    line.label,
    line.partNumber ?? '—',
    line.value ?? '—',
    line.location,
    line.provenance.join(', '),
    line.detail ?? '',
  ];
}

function assemblyRows(bom: Bom): string[][] {
  return bom.assemblies.map((assembly) => [
    assembly.kind,
    assembly.label,
    assembly.segment === undefined
      ? 'no wire stock of its own'
      : facts([assembly.segment.label, assembly.segment.length?.text]),
    assembly.terminations.length === 0
      ? '—'
      : assembly.terminations
          .map((termination) => `${termination.instance} ${termination.label}`)
          .join('; '),
  ]);
}

const ASSEMBLY_HEADERS = ['Kind', 'Branch', 'Wire stock', 'Terminations'];

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

export function bomToMarkdown(bom: Bom): string {
  const out: string[] = [];
  out.push(`# Bill of materials — ${bom.designLabel}`);
  out.push('');
  out.push(facts([`\`${bom.designId}\``, bom.productRef]));
  out.push('');
  out.push(markdownTable(HEADERS, bom.lines.map(row), ALIGN));

  if (bom.assemblies.length > 0) {
    out.push('');
    out.push('## Branches (whips and legs)');
    out.push('');
    out.push(markdownTable(ASSEMBLY_HEADERS, assemblyRows(bom)));
  }

  if (bom.notes.length > 0) {
    out.push('');
    out.push('## Build & purchasing notes');
    out.push('');
    for (const note of bom.notes) {
      out.push(`- **${note.source}** *(${note.topics.join(', ')})* — ${note.text}`);
    }
  }

  if (bom.gaps.length > 0) {
    out.push('');
    out.push('## Identity gaps');
    out.push('');
    out.push('> These are stated, not invented. Order by description until the catalog carries the number.');
    out.push('');
    for (const gap of bom.gaps) out.push(`- ${gap}`);
  }

  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * HTML fragment
 * ------------------------------------------------------------------ */

export function bomToHtml(bom: Bom): string {
  const parts: string[] = [];
  parts.push('<section class="cs-section cs-bom">');
  parts.push('<h2 class="cs-section__h">Bill of materials</h2>');
  parts.push(htmlTable('cs-table cs-table--bom', HEADERS, bom.lines.map(row), ALIGN));

  if (bom.assemblies.length > 0) {
    parts.push('<h3 class="cs-section__h3">Branches (whips and legs)</h3>');
    parts.push(htmlTable('cs-table cs-table--assemblies', ASSEMBLY_HEADERS, assemblyRows(bom)));
  }

  if (bom.notes.length > 0) {
    parts.push('<h3 class="cs-section__h3">Build &amp; purchasing notes</h3>');
    parts.push('<ul class="cs-notes">');
    for (const note of bom.notes) {
      parts.push(
        `<li><span class="cs-tag">${escapeHtml(note.source)}</span>` +
          `<span class="cs-topics">${escapeHtml(note.topics.join(' · '))}</span> ` +
          `${escapeHtml(note.text)}</li>`,
      );
    }
    parts.push('</ul>');
  }

  if (bom.gaps.length > 0) {
    parts.push('<h3 class="cs-section__h3">Identity gaps</h3>');
    parts.push(
      '<p class="cs-caution">Stated, not invented — order by description until the catalog carries the number.</p>',
    );
    parts.push('<ul class="cs-notes">');
    for (const gap of bom.gaps) parts.push(`<li>${escapeHtml(gap)}</li>`);
    parts.push('</ul>');
  }

  parts.push('</section>');
  return parts.join('');
}
