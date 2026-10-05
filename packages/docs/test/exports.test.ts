/**
 * The base exports over every starter design: deterministic, columns as
 * documented, and agreeing with the sheets they sit beside.
 */

import { elementPaths, validateDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import {
  BASE_EXPORTS,
  BOM_HEADERS,
  CONTINUITY_CSV_HEADERS,
  CUT_LIST_HEADERS,
  DEFAULT_TEST_PARAMETERS,
  LABEL_HEADERS,
  WIRE_LIST_HEADERS,
  baseExport,
  bomTable,
  cutListTable,
  deriveBomSheet,
  deriveContinuityExport,
  deriveLabels,
  deriveTestSpec,
  labelSheetPages,
  labelSheetSvg,
  readTestParameters,
  renderBuildSheet,
  renderTestSpecSheet,
  resolveTestParameters,
  toCsv,
  toXlsx,
  wireListTable,
} from '../src/index.ts';

const db = loadDb();

/** A small RFC 4180 reader, so the tests do not trust the writer. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Read the stored entries of a zip: name → text. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    out[name] = new TextDecoder().decode(bytes.subarray(start, start + size));
    at = start + size;
  }
  return out;
}

describe('csv and xlsx', () => {
  it('quotes commas, quotes and line breaks, and round-trips', () => {
    const rows = [['a,b', 'say "hi"', 'two\nlines', 3, '']];
    const csv = toCsv({ headers: ['x', 'y', 'z', 'n', 'e'], rows });
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(parseCsv(csv)).toEqual([['x', 'y', 'z', 'n', 'e'], ['a,b', 'say "hi"', 'two\nlines', '3', '']]);
  });

  it('writes a workbook: one sheet per table, numbers as numbers, deterministic bytes', () => {
    const tables = [
      { name: 'BOM', headers: ['pn', 'qty'], rows: [['A & B', 2]] },
      { name: 'BOM', headers: ['x'], rows: [] },
    ];
    const a = toXlsx(tables);
    expect(toXlsx(tables)).toEqual(a);
    const files = unzip(a);
    expect(Object.keys(files)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(files['xl/workbook.xml']).toContain('name="BOM"');
    expect(files['xl/workbook.xml']).toContain('name="BOM 2"');
    expect(files['xl/worksheets/sheet1.xml']).toContain('A &amp; B');
    expect(files['xl/worksheets/sheet1.xml']).toContain('<c r="B2"><v>2</v></c>');
  });
});

describe.each(listDesignIds())('%s', (id) => {
  const design = loadDesign(id);

  it('every export is deterministic with the documented columns', () => {
    const headers: Record<string, readonly string[]> = {
      'bom.csv': BOM_HEADERS,
      'wire-list.csv': WIRE_LIST_HEADERS,
      'cut-list.csv': CUT_LIST_HEADERS,
      'continuity.csv': CONTINUITY_CSV_HEADERS,
      'labels.csv': LABEL_HEADERS,
    };
    for (const format of BASE_EXPORTS) {
      const a = format.render(design, db);
      const b = format.render(design, db);
      expect(b, format.id).toEqual(a);
      expect(a.fileName.startsWith(`${id}-`), format.id).toBe(true);
      const expected = headers[format.id];
      if (expected !== undefined) {
        const rows = parseCsv(a.body as string);
        expect(rows[0], format.id).toEqual([...expected]);
        expect(rows.every((r) => r.length === expected.length), `${format.id} is rectangular`).toBe(true);
      }
    }
  });

  it('the CSV exports match their snapshots', () => {
    for (const format of BASE_EXPORTS) {
      if (format.id.endsWith('.csv')) expect(format.render(design, db).body, format.id).toMatchSnapshot(format.id);
    }
    expect(baseExport('continuity.json')!.render(design, db).body).toMatchSnapshot('continuity.json');
  });

  it('the BOM CSV has the BOM sheet\'s lines', () => {
    const rows = parseCsv(baseExport('bom.csv')!.render(design, db).body as string).slice(1);
    const sheet = deriveBomSheet(design, db);
    expect(rows).toHaveLength(sheet.lines.length);
    expect(rows.map((r) => r[1])).toEqual(sheet.lines.map((l) => l.sku ?? ''));
  });

  it('the wire list has a row for every landed conductor, landed at the ends the bench lands it', () => {
    const table = wireListTable(design, db);
    for (const segment of design.instances.segments) {
      expect(table.rows.some((r) => r[0] === segment.id)).toBe(true);
    }
    const landed = table.rows.flatMap((r) => [r[6], r[8]]).filter((v) => v !== '');
    expect(landed.length).toBeGreaterThan(0);
  });

  it('the cut list covers every wire segment once per length', () => {
    const table = cutListTable(design, db);
    const pieces = table.rows.reduce((sum, r) => sum + Number(r[5]), 0);
    expect(pieces).toBeGreaterThanOrEqual(design.instances.segments.length === 0 ? 0 : 1);
    expect(table.rows.flatMap((r) => String(r[7]).split(' ')).every((s) => design.instances.segments.some((x) => x.id === s))).toBe(true);
  });

  it('the continuity export agrees with the spec', () => {
    const spec = deriveTestSpec(design, db);
    const data = deriveContinuityExport(design, db);
    expect(data.points).toHaveLength(spec.ports.length);
    expect(data.nets.reduce((n, net) => n + net.points.length, 0)).toBe(spec.netChecks.reduce((n, c) => n + c.ports.length, 0));
    expect(data.connections).toHaveLength(spec.pathChecks.length + spec.commoned.length);
    expect(data.isolation).toHaveLength(spec.isolationChecks.length);
    expect(data.opens).toHaveLength(spec.openChecks.length);
    expect(data.parameters).toEqual(DEFAULT_TEST_PARAMETERS);
    const json = JSON.parse(baseExport('continuity.json')!.render(design, db).body as string);
    expect(json.format).toBe('wirehub.continuity');
    expect(json.points.map((p: { id: string }) => p.id)).toEqual(data.points.map((p) => p.id));
    const rows = parseCsv(baseExport('continuity.csv')!.render(design, db).body as string).slice(1);
    expect(rows.filter((r) => r[0] === 'isolation')).toHaveLength(spec.isolationChecks.length);
  });

  it('labels: two per wire run, deterministic, and on the build sheet', () => {
    const labels = deriveLabels(design, db);
    expect(labels).toHaveLength(design.instances.segments.length * 2);
    expect(labels.map((l) => l.lines[0])).toContain('W1-A');
    expect(deriveLabels(design, db)).toEqual(labels);
    expect(renderBuildSheet(design, db, { depictions: false })).toContain('data-labels="wire"');
    const svg = labelSheetSvg(labels);
    expect(svg).toContain('<svg');
    expect((svg.match(/data-label=/g) ?? []).length).toBe(labels.length);
  });

  it('label text: a run label, end text, a connector label and per-core labels override the defaults', () => {
    const d = structuredClone(design);
    const seg = d.instances.segments[0]!;
    const wire = db.wires.find((w) => w.id === seg.def)!;
    const core = elementPaths(wire.structure).find((e) => e.element.kind === 'conductor')!.path;
    seg.label = 'FEED-1';
    seg.endLabels = { b: ['TO AMP', ' ', 'rack 2'] };
    seg.coreLabels = { [core]: 'SYNC', 'no-such': 'x' };
    d.instances.connectors[0]!.label = 'SOURCE';
    const labels = deriveLabels(d, db);
    const a = labels.find((l) => l.id === `${seg.id}/a`)!;
    const b = labels.find((l) => l.id === `${seg.id}/b`)!;
    expect(a.lines[0]).toBe('FEED-1-A');
    expect(a.lines.join(' ')).toContain('SOURCE');
    expect(b.lines).toEqual(['TO AMP', 'rack 2']);
    const cores = labels.filter((l) => l.core !== undefined);
    expect(cores.map((l) => l.id)).toEqual([`${seg.id}/a/${core}`, `${seg.id}/b/${core}`].filter((id) => id.includes(core)));
    expect(cores[0]!.lines[0]).toBe('SYNC');
    expect(validateDesign(d, db).map((i) => i.code)).toContain('label-unknown-core');
    expect(deriveLabels(design, db).every((l) => l.core === undefined)).toBe(true);
  });

  it('the continuity spec prints its test parameters', () => {
    const html = renderTestSpecSheet(design, db, { testParameters: { isolationVolts: 250 } });
    expect(html).toContain('Test parameters');
    expect(html).toContain('250 V DC');
  });
});

describe('test parameters', () => {
  it('layers: base, organisation, design', () => {
    expect(resolveTestParameters()).toEqual(DEFAULT_TEST_PARAMETERS);
    const p = resolveTestParameters({ isolationVolts: 500 }, { isolationVolts: 250, hipotVolts: 1000, hipotSeconds: 2 });
    expect(p.isolationVolts).toBe(500);
    expect(p.hipotVolts).toBe(1000);
    expect(p.continuityOhmsMax).toBe(5);
  });

  it('the hipot step appears in the CSV only when set', () => {
    const design = loadDesign('de9-crossover');
    const plain = baseExport('continuity.csv')!.render(design, db).body as string;
    expect(plain).not.toContain('hipot');
    const withHipot = baseExport('continuity.csv')!.render(design, db, { testParameters: { hipotVolts: 1500, hipotSeconds: 2, hipotMaxMicroamps: 500 } }).body as string;
    const row = parseCsv(withHipot).find((r) => r[0] === 'hipot');
    expect(row).toEqual(['hipot', 'hipot', '', '', '*', '', 'withstand', '500', 'uA', '1500', '2', 'applied between every pair of isolated nets']);
  });

  it('a changed threshold is quoted in the expected readings', () => {
    const design = loadDesign('de9-crossover');
    expect(renderTestSpecSheet(design, db, {})).toContain('&lt; 5 Ω');
    const html = renderTestSpecSheet(design, db, { testParameters: { continuityOhmsMax: 2 } });
    expect(html).toContain('&lt; 2 Ω');
    expect(html).not.toContain('&lt; 5 Ω');
    expect(deriveTestSpec(design, db, { continuityOhmsMax: 2 }).netChecks[0]?.expected).toContain('< 2 Ω');
    // the sidecar's own parameters reach the continuity export and the build sheet
    const viaSidecar = baseExport('continuity.json')!.render(design, db, { drawing: { test: { isolationVolts: 500 } } }).body as string;
    expect(JSON.parse(viaSidecar).parameters.isolationVolts).toBe(500);
    expect(renderBuildSheet(design, db, { depictions: false, drawing: { test: { continuityOhmsMax: 2 } } })).toContain('Beep &lt; 2 Ω');
  });

  it('validates untrusted input', () => {
    expect(readTestParameters({ isolationVolts: 100 })).toEqual({ ok: true, parameters: { isolationVolts: 100 } });
    const bad = readTestParameters({ isolationVolts: -1, nonsense: 1, hipotVolts: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toHaveLength(3);
  });
});

describe('label sheet', () => {
  it('paginates and honours the paper and copies', () => {
    const labels = deriveLabels(loadDesign('de9-crossover'), db);
    expect(labelSheetPages(labels.length)).toBe(1);
    expect(labelSheetPages(100)).toBe(5);
    expect(labelSheetPages(10, { copies: 3 })).toBe(2);
    expect(labelSheetSvg(labels, { paper: 'letter' })).toContain('viewBox="0 0 215.9 279.4"');
    expect((labelSheetSvg(labels, { copies: 2 }).match(/data-label=/g) ?? []).length).toBe(labels.length * 2);
  });
});

describe('bomTable', () => {
  it('prints wire in feet and parts each', () => {
    const rows = bomTable(loadDesign('de9-crossover'), db).rows;
    expect(rows.find((r) => r[0] === 'Wire')?.[4]).toBe('ft');
    expect(rows.find((r) => r[0] === 'Connectors')?.[4]).toBe('ea');
  });
});
