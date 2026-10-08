/**
 * The continuity / test spec, rendered.
 *
 * Same deal as the BOM renderers: two formats, one derivation, no computation
 * on this side of the line. The column that must never be lost in either
 * format is **Meter** — `reads` or `OPEN` — because that is the column a tech
 * checks their probe against, and the one that decides whether a 220 µF
 * coupling cap stays on the board.
 */

import { escapeHtml, facts, htmlTable, markdownTable } from './text.ts';
import { testParameterLines, type ResolvedTestParameters } from './exports/test-params.ts';
import {
  SIDE_WORD,
  type GroundLandingCheck,
  type IsolationCheck,
  type NetCheck,
  type OpenCheck,
  type PathCheck,
  type TestSpec,
} from './test-spec.ts';

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

const NET_HEADERS = ['Net', 'Signal', 'Ends', 'Ports on this net', 'Expected'];
const PATH_HEADERS = [
  'From',
  'To',
  'Through',
  'Behaviour',
  'Meter',
  'Expected',
  'Covers',
  'Why',
];
const ISOLATION_HEADERS = ['End', 'Rule', 'A', 'B', 'Expected', 'Why'];
const COMMONED_HEADERS = ['End', 'A', 'B', 'Expected', 'Commoned by design (source)'];
const OPEN_HEADERS = ['Kind', 'Terminal', 'Expected', 'Why'];
const PARAMETER_HEADERS = ['Parameter', 'Value'];
const ELECTRICAL_HEADERS = ['Segment', 'Conductor', 'Net', 'Current (A)', 'Length (mm)', 'Area (mm2)', 'Rated (A)', 'Drop (V)', 'Drop (%)'];
const CONTACT_HEADERS = ['Connector', 'Pin', 'Net', 'Current (A)', 'Contact rating (A)'];
const ELECTRICAL_NOTE = 'Declared currents only: each conductor against its ampacity, each contact against its rating, and the voltage drop over its length (one conductor, at 20 C). Warnings are listed with the design issues.';

function num(value: number | undefined, digits = 3): string {
  return value === undefined ? '' : String(Math.round(value * 10 ** digits) / 10 ** digits);
}

function electricalRows(spec: TestSpec): string[][] {
  return spec.electrical.rows.map((r) => [r.segment, r.conductor, r.net, num(r.currentA), num(r.lengthMm, 0), num(r.areaMm2), num(r.ampacityA), num(r.dropV), num(r.dropPct, 2)]);
}

function contactRows(spec: TestSpec): string[][] {
  return spec.electrical.contacts.map((c) => [c.connector, c.pin, c.net, num(c.currentA), num(c.ratingA)]);
}

const LANDING_HEADERS = ['End', 'Pigtail', 'Screens', 'Lands on', 'Expected', 'Prep'];

function landingRow(check: GroundLandingCheck): string[] {
  return [
    `${check.segment} @${check.end}`,
    check.pigtail,
    check.membersText,
    check.landing === ''
      ? '—'
      : `${check.landing}${check.pad === undefined ? '' : ` · pad ${check.pad}${check.padSide === undefined ? '' : ` (${check.padSide})`}`}`,
    check.expected,
    check.note ?? '',
  ];
}

const LANDING_PREAMBLE =
  'Checked by eye before the shell goes on: no finished cable has a probe point on a braid, ' +
  'so the bench checks each twist — present, on its pad, nothing else on it.';

const PATH_ALIGN: ('left' | 'right')[] = [];
PATH_ALIGN[6] = 'right';

function netRow(check: NetCheck): string[] {
  return [
    check.net,
    check.signal,
    check.ends.map((end) => SIDE_WORD[end]).join(' + '),
    check.ports.map((port) => port.text).join(' · '),
    check.expected,
  ];
}

/** `reads` or `OPEN` — the one word the whole document exists to get right. */
export function meterWord(check: PathCheck): string {
  return check.dcContinuous ? 'reads' : 'OPEN';
}

function pathRow(check: PathCheck): string[] {
  return [
    check.from.text,
    check.to.text,
    check.through.join(' → '),
    check.behaviour.verdict,
    meterWord(check),
    check.expected,
    `${check.covers}`,
    check.rationale,
  ];
}

function isolationRow(check: IsolationCheck): string[] {
  return [
    SIDE_WORD[check.side],
    check.rule,
    facts([check.a.text, check.netA]),
    facts([check.b.text, check.netB]),
    check.expected,
    check.rationale,
  ];
}

function commonedRow(check: IsolationCheck): string[] {
  return [SIDE_WORD[check.side], check.a.text, check.b.text, check.expected, check.commoned ?? ''];
}

function openRow(check: OpenCheck): string[] {
  return [check.openKind, check.text, check.expected, check.rationale];
}

function summaryLine(spec: TestSpec): string {
  return facts([
    `${spec.summary.ports} probe points`,
    `${spec.summary.nets} nets`,
    `${spec.netChecks.length} net checks`,
    `${spec.pathChecks.length} path checks`,
    `${spec.summary.nonDcPaths} of them NOT DC-continuous`,
    `${spec.summary.isolation} isolation checks`,
    spec.summary.commoned === 0 ? undefined : `${spec.summary.commoned} commoned by design`,
    `${spec.summary.opens} deliberate opens`,
    `${spec.summary.groundLandings} ground landings`,
    spec.summary.violations === 0
      ? 'no isolation violations'
      : `${spec.summary.violations} ISOLATION VIOLATION(S)`,
  ]);
}

const METER_PREAMBLE =
  'A path existing in the model is not a path a DC meter reads. Series capacitors block DC; ' +
  'active silicon regenerates rather than conducts. The Meter column is the ruling: `reads` ' +
  'means put a meter on it, `OPEN` means an open reading is the correct result and reworking ' +
  'the part would break the cable.';

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

export function testSpecToMarkdown(spec: TestSpec, parameters?: ResolvedTestParameters): string {
  const out: string[] = [];
  out.push(`# Continuity & test spec — ${spec.designLabel}`);
  out.push('');
  out.push(facts([`\`${spec.designId}\``, spec.productRef]));
  out.push('');
  out.push(summaryLine(spec));

  if (parameters !== undefined) {
    out.push('');
    out.push('## Test parameters');
    out.push('');
    out.push(markdownTable(PARAMETER_HEADERS, testParameterLines(parameters)));
  }

  if (spec.violations.length > 0) {
    out.push('');
    out.push('## ⚠ Isolation violations');
    out.push('');
    out.push('> These pairs are one net in this design and must not be. Do not build.');
    out.push('');
    out.push(markdownTable(ISOLATION_HEADERS, spec.violations.map(isolationRow)));
  }

  // a section with nothing in it is left out: no heading over an empty table
  if (spec.netChecks.length > 0) {
    out.push('');
    out.push('## Continuity — one net, one node');
    out.push('');
    out.push(markdownTable(NET_HEADERS, spec.netChecks.map(netRow)));
  }

  if (spec.pathChecks.length > 0) {
    out.push('');
    out.push('## Continuity — through something');
    out.push('');
    out.push(METER_PREAMBLE);
    out.push('');
    out.push(markdownTable(PATH_HEADERS, spec.pathChecks.map(pathRow), PATH_ALIGN));
  }

  if (spec.isolationChecks.length > 0) {
    out.push('');
    out.push('## Isolation — must NOT be connected');
    out.push('');
    out.push(markdownTable(ISOLATION_HEADERS, spec.isolationChecks.map(isolationRow)));
  }

  if (spec.commoned.length > 0) {
    out.push('');
    out.push('## Commoned by design — one net on purpose');
    out.push('');
    out.push(markdownTable(COMMONED_HEADERS, spec.commoned.map(commonedRow)));
  }

  if (spec.openChecks.length > 0) {
    out.push('');
    out.push('## Deliberate open circuits — do not "fix" these');
    out.push('');
    out.push(markdownTable(OPEN_HEADERS, spec.openChecks.map(openRow)));
  }

  if (spec.groundLandings.length > 0) {
    out.push('');
    out.push('## Ground landings — pre-shell visual check');
    out.push('');
    out.push(LANDING_PREAMBLE);
    out.push('');
    out.push(markdownTable(LANDING_HEADERS, spec.groundLandings.map(landingRow)));
  }

  if (spec.electrical.rows.length > 0 || spec.electrical.contacts.length > 0) {
    out.push('');
    out.push('## Electrical — declared currents');
    out.push('');
    out.push(ELECTRICAL_NOTE);
    if (spec.electrical.rows.length > 0) {
      out.push('');
      out.push(markdownTable(ELECTRICAL_HEADERS, electricalRows(spec)));
    }
    if (spec.electrical.contacts.length > 0) {
      out.push('');
      out.push(markdownTable(CONTACT_HEADERS, contactRows(spec)));
    }
    for (const issue of spec.electrical.issues) out.push('', `- WARNING: ${issue.message}`);
  }

  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * HTML fragment
 * ------------------------------------------------------------------ */

export function testSpecToHtml(spec: TestSpec, parameters?: ResolvedTestParameters): string {
  const parts: string[] = [];
  parts.push('<section class="cs-section cs-testspec">');
  parts.push('<h2 class="cs-section__h">Continuity &amp; test spec</h2>');
  parts.push(`<p class="cs-meta">${escapeHtml(summaryLine(spec))}</p>`);

  if (parameters !== undefined) {
    parts.push('<h3 class="cs-section__h3">Test parameters</h3>');
    parts.push(htmlTable('cs-table cs-table--parameters', PARAMETER_HEADERS, testParameterLines(parameters)));
  }

  if (spec.violations.length > 0) {
    parts.push('<h3 class="cs-section__h3">Isolation violations</h3>');
    parts.push(
      '<p class="cs-hazard">These pairs are one net in this design and must not be. Do not build.</p>',
    );
    parts.push(
      htmlTable(
        'cs-table cs-table--violations',
        ISOLATION_HEADERS,
        spec.violations.map(isolationRow),
      ),
    );
  }

  // a section with nothing in it is left out: no heading over an empty table
  if (spec.netChecks.length > 0) {
    parts.push('<h3 class="cs-section__h3">Continuity — one net, one node</h3>');
    parts.push(htmlTable('cs-table cs-table--nets', NET_HEADERS, spec.netChecks.map(netRow)));
  }

  if (spec.pathChecks.length > 0) {
    parts.push('<h3 class="cs-section__h3">Continuity — through something</h3>');
    // printed text: the markdown's code marks are not carried (`escapeHtml` drops them)
    parts.push(`<p class="cs-caution">${escapeHtml(METER_PREAMBLE)}</p>`);
    parts.push(htmlTable('cs-table cs-table--paths', PATH_HEADERS, spec.pathChecks.map(pathRow), PATH_ALIGN));
  }

  if (spec.isolationChecks.length > 0) {
    parts.push('<h3 class="cs-section__h3">Isolation — must NOT be connected</h3>');
    parts.push(htmlTable('cs-table cs-table--isolation', ISOLATION_HEADERS, spec.isolationChecks.map(isolationRow)));
  }

  if (spec.commoned.length > 0) {
    parts.push('<h3 class="cs-section__h3">Commoned by design — one net on purpose</h3>');
    parts.push(htmlTable('cs-table cs-table--commoned', COMMONED_HEADERS, spec.commoned.map(commonedRow)));
  }

  if (spec.openChecks.length > 0) {
    parts.push('<h3 class="cs-section__h3">Deliberate open circuits — do not &ldquo;fix&rdquo; these</h3>');
    parts.push(htmlTable('cs-table cs-table--opens', OPEN_HEADERS, spec.openChecks.map(openRow)));
  }

  if (spec.groundLandings.length > 0) {
    parts.push('<h3 class="cs-section__h3">Ground landings — pre-shell visual check</h3>');
    parts.push(`<p class="cs-caution">${escapeHtml(LANDING_PREAMBLE)}</p>`);
    parts.push(
      htmlTable('cs-table cs-table--landings', LANDING_HEADERS, spec.groundLandings.map(landingRow)),
    );
  }

  if (spec.electrical.rows.length > 0 || spec.electrical.contacts.length > 0) {
    parts.push('<h3 class="cs-section__h3">Electrical — declared currents</h3>');
    parts.push(`<p class="cs-caution">${escapeHtml(ELECTRICAL_NOTE)}</p>`);
    if (spec.electrical.rows.length > 0) parts.push(htmlTable('cs-table cs-table--electrical', ELECTRICAL_HEADERS, electricalRows(spec)));
    if (spec.electrical.contacts.length > 0) parts.push(htmlTable('cs-table cs-table--contacts', CONTACT_HEADERS, contactRows(spec)));
    for (const issue of spec.electrical.issues) parts.push(`<p class="cs-caution">${escapeHtml(issue.message)}</p>`);
  }

  parts.push('</section>');
  return parts.join('');
}
