/**
 * Documents and exports without a browser: `/api/designs/:id/documents/:kind`
 * and `/api/designs/:id/exports/:format`, over memory stores.
 */

import { inflateSync } from 'node:zlib';

import { loadDb, loadDesign } from '@wirehub/catalog';
import { BASE_EXPORTS, baseExport, renderBuildSheet, withUnreleasedMark } from '@wirehub/docs';
import type { CableDesign } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { routeWorkbenchRequest, type ApiResponse, type WorkbenchDeps } from '../server/api.ts';
import { testDefaultsFromEnv } from '../server/documents.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore, readDrawingMeta } from '../server/drawings.ts';
import { memoryVersionStore } from '../server/versions.ts';

const db = loadDb();
const ID = 'de9-crossover';

function memoryDesigns(seed: CableDesign[]): DesignStore {
  const files = new Map(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () => [...files.keys()].sort().map((id) => ({ id, label: (JSON.parse(files.get(id) as string) as CableDesign).label })),
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? (JSON.parse(files.get(id) as string) as CableDesign) : undefined),
    write: (id, design) => {
      files.set(id, formatDesignJson(design));
      return { changed: true };
    },
    remove: (id) => void files.delete(id),
  };
}

let deps: WorkbenchDeps;

beforeEach(async () => {
  const drawings = memoryDrawingStore();
  drawings.writeMeta(ID, { partNumber: 'CBL-00101-3X', revision: '1', test: { isolationVolts: 500 } });
  deps = {
    designs: memoryDesigns([loadDesign(ID), loadDesign('de9-terminal-board')]),
    loadDb: () => db,
    drawings,
    versions: memoryVersionStore(),
    now: () => '2026-09-25T10:00:00.000Z',
    localUser: { name: 'Owner', source: 'local' },
  };
});

const get = (path: string, d: WorkbenchDeps = deps): Promise<ApiResponse> => routeWorkbenchRequest({ method: 'GET', path }, d);
const text = (r: ApiResponse): string => new TextDecoder().decode(r.bytes);

async function release(): Promise<void> {
  const saved = await routeWorkbenchRequest({ method: 'POST', path: `/api/designs/${ID}/versions`, body: { note: 'first' } }, deps);
  expect(saved.status).toBe(201);
}

/** Every PDF object, its xref offset checked, its streams inflated. */
function readPdf(bytes: Uint8Array): { pages: number; streams: string[]; images: number } {
  const text = Buffer.from(bytes).toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  expect(text.slice(start, start + 4)).toBe('xref');
  const size = Number(/trailer\n<< \/Size (\d+)/.exec(text)![1]);
  const entries = [...text.slice(start).matchAll(/^(\d{10}) \d{5} n $/gm)].map((m) => Number(m[1]));
  expect(entries).toHaveLength(size - 1);
  entries.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  const streams: string[] = [];
  let images = 0;
  for (const offset of entries) {
    const head = text.slice(offset, text.indexOf('\nstream\n', offset));
    const mark = text.indexOf('\nendobj', offset);
    // an object with a stream: its dictionary is followed by `stream`, before the next `endobj`
    const streamAt = text.indexOf('\nstream\n', offset);
    if (streamAt < 0 || streamAt > mark) continue;
    const length = Number(/\/Length (\d+)/.exec(head)![1]);
    const at = streamAt + '\nstream\n'.length;
    const inflated = inflateSync(Buffer.from(bytes.subarray(at, at + length)));
    if (/\/Subtype \/Image/.test(head)) {
      images += 1;
      expect(inflated).toHaveLength(Number(/\/Width (\d+)/.exec(head)![1]) * Number(/\/Height (\d+)/.exec(head)![1]) * 3);
    } else streams.push(inflated.toString('latin1'));
  }
  return { pages: Number(/\/Count (\d+)/.exec(text)![1]), streams, images };
}

describe('GET /api/designs/:id/documents/:kind', () => {
  it('renders the html sheets with the browser\'s own functions; the working copy is marked UNRELEASED', async () => {
    const r = await get(`/api/designs/${ID}/documents/build-sheet`);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('text/html; charset=utf-8');
    expect(r.headers?.['Content-Security-Policy']).toContain("default-src 'none'");
    const html = text(r);
    expect(html).toContain('UNRELEASED');
    expect(html).toContain('data-labels="wire"');
    expect(withUnreleasedMark(renderBuildSheet(loadDesign(ID), db, { depictions: true }))).not.toBe('');
  });

  it('a saved revision renders from its frozen definitions, not the working copy', async () => {
    await release();
    deps.designs.write(ID, { ...loadDesign(ID), label: 'edited after release' });
    const working = text(await get(`/api/designs/${ID}/documents/bom`));
    const rev1 = text(await get(`/api/designs/${ID}/documents/bom?rev=1`));
    const latest = text(await get(`/api/designs/${ID}/documents/bom?rev=latest`));
    expect(working).toContain('edited after release');
    expect(rev1).not.toContain('edited after release');
    expect(rev1).not.toContain('UNRELEASED');
    expect(latest).toBe(rev1);
  });

  it('csv: the BOM, the wire list and the continuity data', async () => {
    const bom = text(await get(`/api/designs/${ID}/documents/bom?format=csv`));
    expect(bom.split('\r\n')[0]).toBe('section,part_number,description,quantity,unit,location,instances,variation_pn,notes');
    const spec = text(await get(`/api/designs/${ID}/documents/test-spec?format=csv`));
    expect(spec.split('\r\n')[0]).toMatch(/^type,id,net,signal,from,to,expect/);
    expect(text(await get(`/api/designs/${ID}/documents/build-sheet?format=csv`)).split('\r\n')[0]).toMatch(/^segment,stock_part_number/);
    expect(text(await get(`/api/designs/${ID}/documents/labels?format=csv`))).toContain('W1-A');
  });

  it('svg: the schematic, the drawing sheet, the label sheet and a plain text sheet', async () => {
    for (const [kind, marker] of [['schematic', '<svg'], ['drawing', '<svg'], ['labels', 'data-label='], ['bom', 'Bill of materials'], ['test-spec', 'Test parameters'], ['build-sheet', 'Wire labels']] as const) {
      const r = await get(`/api/designs/${ID}/documents/${kind}?format=svg`);
      expect(r.status, kind).toBe(200);
      expect(r.contentType).toBe('image/svg+xml');
      expect(text(r), kind).toContain(marker);
      expect(text(r).startsWith('<svg'), kind).toBe(true);
    }
  });

  it('pdf: a well-formed file for every kind, text in the sheets and an image page for the drawings', async () => {
    const sheet = await get(`/api/designs/${ID}/documents/build-sheet?format=pdf&paper=letter`);
    expect(sheet.contentType).toBe('application/pdf');
    const parsed = readPdf(sheet.bytes!);
    expect(parsed.pages).toBeGreaterThanOrEqual(1);
    expect(parsed.streams.join('\n')).toContain('(Bench build sheet');
    expect(/\/MediaBox \[0 0 612 792\]/.test(Buffer.from(sheet.bytes!).toString('latin1'))).toBe(true);

    for (const kind of ['bom', 'test-spec']) expect(readPdf((await get(`/api/designs/${ID}/documents/${kind}?format=pdf`)).bytes!).pages).toBeGreaterThanOrEqual(1);
    for (const kind of ['schematic', 'drawing']) expect(readPdf((await get(`/api/designs/${ID}/documents/${kind}?format=pdf`)).bytes!).images).toBe(1);
    const labels = readPdf((await get(`/api/designs/${ID}/documents/labels?format=pdf&copies=11`)).bytes!);
    expect(labels.pages).toBe(2);
    expect(labels.images).toBe(2);
  });

  it('a long test spec runs over pages, repeating nothing but the table header', async () => {
    const parsed = readPdf((await get(`/api/designs/de9-terminal-board/documents/test-spec?format=pdf`)).bytes!);
    expect(parsed.streams.length).toBe(parsed.pages);
  });

  it('refuses what it cannot render, in sentences', async () => {
    expect((await get(`/api/designs/${ID}/documents/nothing`)).status).toBe(404);
    expect((await get(`/api/designs/${ID}/documents/bom?format=docx`)).status).toBe(400);
    const schematicCsv = await get(`/api/designs/${ID}/documents/schematic?format=csv`);
    expect(schematicCsv).toMatchObject({ status: 400, body: { hint: 'It comes as svg, pdf.' } });
    expect((await get(`/api/designs/${ID}/documents/bom?rev=abc`)).status).toBe(400);
    expect((await get(`/api/designs/${ID}/documents/bom?rev=9`)).status).toBe(404);
    expect((await get(`/api/designs/${ID}/documents/bom?rev=latest`)).status).toBe(404);
    expect((await get(`/api/designs/${ID}/documents/bom?paper=B5`)).status).toBe(400);
    expect((await get(`/api/designs/${ID}/documents/labels?page=0`)).status).toBe(400);
    expect((await get('/api/designs/no-such/documents/bom')).status).toBe(404);
    expect((await routeWorkbenchRequest({ method: 'POST', path: `/api/designs/${ID}/documents/bom` }, deps)).status).toBe(405);
    const { versions: _versions, ...bare } = deps;
    expect((await get(`/api/designs/${ID}/documents/bom?rev=1`, bare)).status).toBe(501);
    // without saved revisions the working copy is not marked
    expect(text(await get(`/api/designs/${ID}/documents/bom`, bare))).not.toContain('UNRELEASED');
  });
});

describe('GET /api/designs/:id/exports/:format', () => {
  it('serves every base export as a download, equal to what the toolbar saves', async () => {
    for (const format of BASE_EXPORTS) {
      const r = await get(`/api/designs/${ID}/exports/${format.id}`);
      expect(r.status, format.id).toBe(200);
      expect(r.headers?.['Content-Disposition']).toContain(`attachment; filename="${ID}-`);
      expect(r.bytes!.length).toBeGreaterThan(0);
    }
    const bom = text(await get(`/api/designs/${ID}/exports/bom.csv`));
    expect(bom).toBe(baseExport('bom.csv')!.render(loadDesign(ID), db, { drawing: { partNumber: 'CBL-00101-3X' } }).body);
  });

  it('puts the revision in the file name and the test parameters in the continuity data', async () => {
    await release();
    const r = await get(`/api/designs/${ID}/exports/continuity.json?rev=1`);
    expect(r.headers?.['Content-Disposition']).toContain(`${ID}-rev1-continuity.json`);
    const data = JSON.parse(text(r));
    // the design's own 500 V over the base's defaults
    expect(data.parameters).toMatchObject({ isolationVolts: 500, continuityOhmsMax: 5, isolationMinMohm: 10 });
  });

  it('the organisation defaults sit under the design and ride on the drawing sidecar', async () => {
    const withDefaults: WorkbenchDeps = { ...deps, testDefaults: { isolationVolts: 250, isolationSeconds: 3, hipotVolts: 1500 } };
    const data = JSON.parse(text(await get(`/api/designs/${ID}/exports/continuity.json`, withDefaults)));
    expect(data.parameters).toMatchObject({ isolationVolts: 500, isolationSeconds: 3, hipotVolts: 1500 });
    expect(text(await get(`/api/designs/${ID}/documents/test-spec`, withDefaults))).toContain('1500 V');
    const drawing = await get(`/api/drawings/${ID}`, withDefaults);
    expect((drawing.body as { testDefaults: unknown }).testDefaults).toEqual({ isolationVolts: 250, isolationSeconds: 3, hipotVolts: 1500 });
    expect((await get(`/api/drawings/${ID}`)).body).not.toHaveProperty('testDefaults');
  });

  it('refuses an unknown format, and lists the formats at /api/exports', async () => {
    expect((await get(`/api/designs/${ID}/exports/bom.pdf`)).status).toBe(404);
    const list = (await get('/api/exports')).body as { exports: { id: string }[]; documents: { kind: string }[] };
    expect(list.exports.map((e) => e.id)).toEqual(BASE_EXPORTS.map((e) => e.id));
    expect(list.documents.map((d) => d.kind)).toEqual(['schematic', 'build-sheet', 'bom', 'test-spec', 'drawing', 'labels']);
    expect(((await get('/api')).body as { routes: string[] }).routes).toContain('GET    /api/designs/:id/documents/:kind');
  });
});

describe('test parameters in the sidecar and the environment', () => {
  it('the drawing sidecar accepts positive numbers under test and refuses the rest', () => {
    expect(readDrawingMeta({ test: { isolationVolts: 250, hipotSeconds: 2 } })).toEqual({ ok: true, meta: { test: { isolationVolts: 250, hipotSeconds: 2 } } });
    expect(readDrawingMeta({ test: {} })).toEqual({ ok: true, meta: {} });
    const bad = readDrawingMeta({ test: { isolationVolts: 0, bogus: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toEqual(['\'test.bogus\' is not a test parameter.', 'test.isolationVolts must be a positive number.']);
  });

  it('WIREHUB_TEST_DEFAULTS is JSON of the same, or a sentence says why not', () => {
    expect(testDefaultsFromEnv({})).toBeUndefined();
    expect(testDefaultsFromEnv({ WIREHUB_TEST_DEFAULTS: '' })).toBeUndefined();
    expect(testDefaultsFromEnv({ WIREHUB_TEST_DEFAULTS: '{"isolationVolts":250}' })).toEqual({ isolationVolts: 250 });
    expect(() => testDefaultsFromEnv({ WIREHUB_TEST_DEFAULTS: 'nope' })).toThrow('not JSON');
    expect(() => testDefaultsFromEnv({ WIREHUB_TEST_DEFAULTS: '{"isolationVolts":-5}' })).toThrow('positive number');
  });
});
