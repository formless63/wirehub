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
    designs: memoryDesigns([loadDesign(ID), loadDesign('de9-terminal-board'), loadDesign('dc-y-splitter')]),
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
function readPdf(bytes: Uint8Array): { pages: number; streams: string[]; contents: string[]; images: number } {
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
  /** the page content streams: not a font program, not a character map */
  const contents: string[] = [];
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
    } else {
      const body = inflated.toString('latin1');
      streams.push(body);
      if (!/\/Length1/.test(head) && !body.startsWith('/CIDInit')) contents.push(body);
    }
  }
  return { pages: Number(/\/Count (\d+)/.exec(text)![1]), streams, contents, images };
}

describe('every sheet in the one frame, on the paper asked for', () => {
  it('honours paper= on every kind: the page size follows, the frame is on the sheet', async () => {
    const size = (svg: string): [number, number] => {
      const m = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg)!;
      return [Number(m[1]), Number(m[2])];
    };
    const [dw, dh] = size(text(await get(`/api/designs/${ID}/documents/drawing?format=svg&paper=A3`)));
    expect([dw, dh]).toEqual([420, 297]);
    expect(size(text(await get(`/api/designs/${ID}/documents/drawing?format=svg&paper=letter`)))).toEqual([279.4, 215.9]);
    expect(size(text(await get(`/api/designs/${ID}/documents/formboard?format=svg&paper=A3`)))).toEqual([420, 297]);
    expect(size(text(await get(`/api/designs/${ID}/documents/labels?format=svg&paper=letter`)))).toEqual([215.9, 279.4]);
    const schematic = text(await get(`/api/designs/${ID}/documents/schematic?format=svg&paper=A3`));
    expect(schematic).toMatch(/data-paper="A3"/);
    expect(schematic).toContain('data-state-stamp="UNRELEASED"');
    const bom = text(await get(`/api/designs/${ID}/documents/bom?format=html&paper=ansi-c`));
    expect(bom).toContain('@page{size:431.8mm 558.8mm');
    const refused = await get(`/api/designs/${ID}/documents/bom?paper=A5`);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('A4, A3');
  });

  it('prints the saved revisions in the drawing’s revision table, the working copy as its own row', async () => {
    await release();
    const working = text(await get(`/api/designs/${ID}/documents/drawing?format=svg`));
    expect(working).toContain('class="wh-revisions"');
    expect(working).toContain('first');
    expect(working).toContain('Working copy, not released');
    // a saved revision's drawing lists up to itself, and is released: no stamp
    const saved = text(await get(`/api/designs/${ID}/documents/drawing?format=svg&rev=1`));
    expect(saved).toContain('class="wh-revisions"');
    expect(saved).not.toContain('Working copy, not released');
    expect(saved).not.toContain('data-state-stamp');
  });
});

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
    // the sheet's headings are set in the embedded Liberation Sans as glyph ids; the frame's title block in IBM Plex (cs-dcuk)
    const { liberation } = await import('../server/render/fonts.ts');
    const regular = liberation('bold');
    const hex = (t: string): string => [...t].map((c) => regular.glyphFor(c.codePointAt(0)!).toString(16).padStart(4, '0')).join('');
    expect(parsed.contents.join('\n')).toContain(`<${hex('Bench build sheet')}`);
    expect(parsed.contents.join('\n')).toMatch(/\/E[3-6] [\d.]+ Tf/);
    expect(/\/MediaBox \[0 0 612 792\]/.test(Buffer.from(sheet.bytes!).toString('latin1'))).toBe(true);

    for (const kind of ['bom', 'test-spec']) expect(readPdf((await get(`/api/designs/${ID}/documents/${kind}?format=pdf`)).bytes!).pages).toBeGreaterThanOrEqual(1);
    for (const kind of ['schematic', 'drawing']) expect(readPdf((await get(`/api/designs/${ID}/documents/${kind}?format=pdf`)).bytes!).images).toBe(1);
    const labels = readPdf((await get(`/api/designs/${ID}/documents/labels?format=pdf&copies=11`)).bytes!);
    expect(labels.pages).toBe(2);
    expect(labels.images).toBe(2);
  });

  it('a long test spec runs over pages, repeating nothing but the table header', async () => {
    const parsed = readPdf((await get(`/api/designs/de9-terminal-board/documents/test-spec?format=pdf`)).bytes!);
    expect(parsed.contents.length).toBe(parsed.pages);
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
    expect(list.documents.map((d) => d.kind)).toEqual(['schematic', 'build-sheet', 'bom', 'test-spec', 'drawing', 'labels', 'formboard']);
    expect(((await get('/api')).body as { routes: string[] }).routes).toContain('GET    /api/designs/:id/documents/:kind');
  });
});

describe('GET /api/designs/:id/documents/formboard', () => {
  const path = '/api/designs/dc-y-splitter/documents/formboard';

  it('is the overview as svg by default, one tile with ?page=, at the asked scale and paper', async () => {
    const overview = await get(path);
    expect(overview.status).toBe(200);
    expect(overview.contentType).toBe('image/svg+xml');
    expect(text(overview)).toContain('data-formboard="overview"');
    expect(text(overview)).toContain('16 pages');
    const tile = text(await get(`${path}?page=7`));
    expect(tile).toContain('data-formboard="tile"');
    expect(tile).toContain('page 7 of 16');
    expect(text(await get(`${path}?scale=1:10`))).toContain('tiles at 1:10: 1 page');
    expect(text(await get(`${path}?page=1&scale=0.5&paper=letter`))).toContain('width="279.4mm"');
  });

  it('refuses a tile that is not there and a scale that is not one, in sentences', async () => {
    const far = await get(`${path}?page=99`);
    expect(far).toMatchObject({ status: 400 });
    expect(JSON.stringify(far.body)).toContain('16 tile pages');
    expect(await get(`${path}?scale=banana`)).toMatchObject({ status: 400 });
    expect(await get(`${path}?scale=1:1000`)).toMatchObject({ status: 400 });
    expect(await get(`${path}?format=csv`)).toMatchObject({ status: 400, body: { hint: 'It comes as html, svg, pdf.' } });
  });

  it('html carries every page; pdf is the overview then every tile, as vector drawing (no image)', async () => {
    const html = text(await get(`${path}?format=html&scale=0.25`));
    expect(html).toContain('cs-formboard-page');
    const pdf = readPdf((await get(`${path}?format=pdf&scale=0.1`)).bytes!);
    expect(pdf.pages).toBe(2);
    expect(pdf.images).toBe(0);
    const content = pdf.streams.join('\n');
    // lines and the rounded mould outlines are path operators, the labels are the embedded Liberation Sans, as glyph ids
    expect(content).toMatch(/ m [\d. -]+ l\n/);
    expect(content).toMatch(/\bBT \/E[12] [\d.]+ Tf 1 0 0 -1 [\d. -]+ Tm <[0-9a-f]+> Tj ET/);
    expect(content).toContain(' re W n');
    const { liberation } = await import('../server/render/fonts.ts');
    const regular = liberation('regular');
    const glyphs = [...'print check: this bar must measure 100 mm'].map((c) => regular.glyphFor(c.codePointAt(0)!).toString(16).padStart(4, '0')).join('');
    expect(content).toContain(`<${glyphs}> Tj`);
  });

  it('a straight run (no breakout) still has a board', async () => {
    const r = await get(`/api/designs/${ID}/documents/formboard`);
    expect(r.status).toBe(200);
    expect(text(r)).toContain('data-run=');
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

describe('GET /api/definitions/wires/:id/wire-spec (cs-5k1.22)', () => {
  const wire = db.wires.find((w) => w.structure.children.length > 3) ?? db.wires[0]!;
  const withLibrary = async (): Promise<WorkbenchDeps> => {
    const { loadWireLibrary } = await import('@wirehub/catalog');
    const { memoryWireLibraryStore } = await import('../server/wire-library.ts');
    return { ...deps, wireLibrary: memoryWireLibraryStore(loadWireLibrary(), db.wires) };
  };

  it('is the browser sheet as html, named after the document number', async () => {
    const { renderWireSpecSheet, wireSpecFileName } = await import('@wirehub/docs');
    const d = await withLibrary();
    const r = await get(`/api/definitions/wires/${wire.id}/wire-spec`, d);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('text/html; charset=utf-8');
    expect(r.headers?.['Content-Disposition']).toContain(wireSpecFileName(wire, 'html'));
    expect(text(r)).toContain('<title>WSS_');
    const library = (await import('@wirehub/catalog')).loadWireLibrary();
    const recipe = library.recipes.find((x) => x.id === wire.id);
    expect(text(r)).toBe(renderWireSpecSheet(wire, { ...(recipe === undefined ? {} : { recipe }), parts: library.parts, manufacturers: db.vocab?.['manufacturers']?.entries ?? [], paper: 'A4' }));
  });

  it('is the same sheet as a text-set svg and pdf', async () => {
    const d = await withLibrary();
    const svg = await get(`/api/definitions/wires/${wire.id}/wire-spec?format=svg`, d);
    expect(svg.status).toBe(200);
    expect(svg.contentType).toBe('image/svg+xml');
    expect(text(svg)).toContain('<svg');
    expect(text(svg)).toContain(wire.label.split(' ')[0]!);
    const pdf = await get(`/api/definitions/wires/${wire.id}/wire-spec?format=pdf&paper=letter`, d);
    expect(pdf.status).toBe(200);
    expect(readPdf(pdf.bytes!).pages).toBeGreaterThanOrEqual(1);
  });

  it('refuses a stock that is not there and a format it does not come in', async () => {
    expect((await get('/api/definitions/wires/no-such-stock/wire-spec')).status).toBe(404);
    expect((await get(`/api/definitions/wires/${wire.id}/wire-spec?format=csv`)).status).toBe(400);
    expect((await get(`/api/definitions/wires/${wire.id}/wire-spec?paper=B5`)).status).toBe(400);
  });
});

describe('artwork and part-number proposals in the headless sheets (cs-5k1.23)', () => {
  /** the catalog's artwork store, with one connector's face carrying a marker only an uploaded copy has */
  async function uploadedStore() {
    const { fileDepictionStore } = await import('../server/depictions.ts');
    const real = fileDepictionStore();
    return {
      ...real,
      readAsset: async (defId: string, file: string) => {
        const bytes = await real.readAsset(defId, file);
        if (defId !== 'de9-female' || file !== 'mating-face.svg' || bytes === undefined) return bytes;
        return new TextEncoder().encode(new TextDecoder().decode(bytes).replace('</svg>', '<rect id="uploaded-marker" x="0" y="0" width="1" height="1"/></svg>'));
      },
    };
  }

  it('the schematic draws artwork the store holds, which the catalog tree does not', async () => {
    const plain = text(await get(`/api/designs/${ID}/documents/schematic`));
    expect(plain).not.toContain('uploaded-marker');
    const drawn = text(await get(`/api/designs/${ID}/documents/schematic`, { ...deps, depictions: await uploadedStore() }));
    expect(drawn).toContain('uploaded-marker');
    expect(drawn.length).toBeGreaterThan(plain.length);
  });

  it('a saved revision draws the artwork it was saved with, not today\'s', async () => {
    const store = await uploadedStore();
    const files = new Map<string, Uint8Array>();
    const versions = memoryVersionStore();
    versions.snapshotArtwork = async (defIds) => {
      const out = { files: {} as Record<string, Record<string, string>>, blobs: {} as Record<string, Uint8Array> };
      const { createHash } = await import('node:crypto');
      for (const defId of defIds) {
        const entry: Record<string, string> = {};
        for (const name of ['meta.json', 'mating-face.svg', 'solder-side.svg']) {
          const bytes = await store.readAsset(defId, name);
          if (bytes === undefined) continue;
          const hex = createHash('sha256').update(bytes).digest('hex');
          entry[name] = `sha256:${hex}`;
          out.blobs[`${hex}.${name.endsWith('.json') ? 'json' : 'svg'}`] = bytes;
        }
        if (Object.keys(entry).length > 0) out.files[defId] = entry;
      }
      return out;
    };
    versions.writeArtwork = async (_id, blobs) => void Object.entries(blobs).forEach(([k, v]) => files.set(k, v));
    versions.readArtworkBlob = async (_id, blob) => files.get(blob);
    const d: WorkbenchDeps = { ...deps, versions };
    expect((await routeWorkbenchRequest({ method: 'POST', path: `/api/designs/${ID}/versions`, body: { note: 'with art' } }, { ...d, depictions: store })).status).toBe(201);
    // today the live tree has no marker; the revision still carries it
    const rev = text(await get(`/api/designs/${ID}/documents/schematic?rev=1`, d));
    expect(rev).toContain('uploaded-marker');
    expect(text(await get(`/api/designs/${ID}/documents/schematic`, d))).not.toContain('uploaded-marker');
  });

  it('the BOM proposes numbers for unnumbered parts once the hub has a scheme', async () => {
    // the connector has no number of its own
    const unnumbered = { ...db, connectors: db.connectors.map((c) => (c.id === 'de9-female' ? (({ partNumber: _pn, ...rest }) => rest)(c) : c)) };
    const base: WorkbenchDeps = { ...deps, loadDb: () => unnumbered as typeof db };
    const without = text(await get(`/api/designs/${ID}/documents/bom`, base));
    const withScheme = text(await get(`/api/designs/${ID}/documents/bom`, { ...base, loadPartNumberFiles: () => ({}) }));
    expect(without).not.toContain('class="cs-proposal"');
    expect(withScheme).toContain('class="cs-proposal"');
  });
});
