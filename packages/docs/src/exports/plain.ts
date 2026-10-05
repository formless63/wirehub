/**
 * The bench build sheet as plain markdown: the text of the sheet without its
 * figures, from the same derivations. It exists for the places that cannot lay
 * out HTML (headless SVG and PDF output, a work-order note); the HTML sheet
 * stays the full-fidelity document.
 */

import type { CableDesign, Db } from '@wirehub/model';

import { deriveBench } from '../bench/model.ts';
import { deriveBomSheet } from '../bom-sheet.ts';
import { benchOptions } from '../build-sheet.ts';
import { deriveTestSpec } from '../test-spec.ts';
import { facts, markdownTable } from '../text.ts';
import { deriveLabels } from './labels.ts';
import { bomTable, cutListTable, type ExportOptions } from './rows.ts';
import { resolveTestParameters, testParameterLines } from './test-params.ts';

export function buildSheetMarkdown(design: CableDesign, db: Db, options: ExportOptions = {}): string {
  const sheet = deriveBomSheet(design, db, benchOptions(options));
  const header = sheet.header;
  const parameters = resolveTestParameters(options.testParameters ?? options.drawing?.test, options.testDefaults);
  const out: string[] = [];
  out.push(`# Bench build sheet — ${header.title}`);
  out.push('');
  out.push(facts([`\`${design.id}\``, header.productPn ?? header.family, header.revision === undefined ? undefined : `Rev ${header.revision}`, header.release, `stock ${header.stock}`, header.destination]));

  out.push('', '## Kit & cut', '', '### Parts to pull', '');
  const bom = bomTable(design, db, options);
  out.push(markdownTable(['Part', 'Description', 'Qty', 'Unit', 'Where'], bom.rows.map((r) => [String(r[1] === '' ? '—' : r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5])]), ['left', 'left', 'right']));
  out.push('', '### Cut', '');
  const cut = cutListTable(design, db, options);
  out.push(
    cut.rows.length === 0
      ? 'Nothing to cut: the wire arrives cut.'
      : markdownTable(['Piece', 'Stock', 'Cut (mm)', 'Cut (in)', 'Qty', 'For'], cut.rows.map((r) => [String(r[2]), String(r[0] === '' ? r[1] : `${r[0]} ${r[1]}`), String(r[3]), String(r[4]), String(r[5]), String(r[6])]), ['left', 'left', 'right', 'right', 'right']),
  );

  for (const end of deriveBench(design, db).ends) {
    if (end.terminations.length === 0) continue;
    out.push('', `## ${end.side === 'a' ? 'Source end' : 'Destination end'}`);
    for (const termination of end.terminations) {
      out.push('', `### ${termination.label} (${termination.instance}${termination.partNumber === undefined ? '' : `, ${termination.partNumber}`})`, '');
      out.push(
        markdownTable(
          ['#', 'Wire', 'Element', 'Lands on', 'Pad', 'Face', 'Note'],
          termination.landings.map((l) => [
            String(l.n),
            `${l.segment} @${l.segEnd}`,
            l.element.name,
            `${l.target.instance}.${l.target.terminal}${l.target.label === undefined ? '' : ` ${l.target.label}`}`,
            l.target.pad ?? '',
            l.face ?? '',
            l.note ?? '',
          ]),
          ['right'],
        ),
      );
    }
    for (const bridge of end.bridges) out.push('', `- Bridge ${bridge.from} to ${bridge.to}${bridge.part === undefined ? '' : ` through ${bridge.part}`}${bridge.note === undefined ? '' : ` — ${bridge.note}`}`);
  }

  const labels = deriveLabels(design, db);
  if (labels.length > 0) {
    out.push('', '## Wire labels', '');
    out.push(markdownTable(['Label', 'Reads', 'Position'], labels.map((l) => [l.lines[0] ?? '', l.lines.slice(1).join(' · '), l.position])));
  }

  const spec = deriveTestSpec(design, db, { continuityOhmsMax: parameters.continuityOhmsMax });
  out.push('', '## Test', '');
  out.push(`${spec.summary.ports} probe points · ${spec.netChecks.length} net checks · ${spec.pathChecks.length} path checks · ${spec.summary.isolation} isolation checks · ${spec.summary.opens} deliberate opens. The continuity & test spec lists every reading.`);
  out.push('', markdownTable(['Parameter', 'Value'], testParameterLines(parameters)));
  out.push('');
  return out.join('\n');
}
