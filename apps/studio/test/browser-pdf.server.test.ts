/**
 * The HTML sheets printed to PDF by a browser engine (cs-5k1.24,
 * `server/render/browser-pdf.ts`): the configuration, the request sent to the
 * engine, the documents route's choice and its fallback headers — against a
 * stand-in engine, always — and, when `WIREHUB_TEST_PDF_ENGINE_URL` names a
 * running Gotenberg (the compose profile `pdf`; CI starts one), every sheet of
 * every starter design through the real thing.
 */

import { readFileSync } from 'node:fs';

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { routeWorkbenchRequest, type ApiResponse, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';
import { memoryDrawingStore } from '../server/drawings.ts';
import { gotenbergEngine, parseEngineUrl, pdfEngineFromEnv, PdfEngineError, printableHtml, type PdfEngine } from '../server/render/browser-pdf.ts';
import { BRANDING_PATH } from '../server/settings.ts';
import { memoryDocStore } from '../server/storage/doc-store.ts';
import { memoryVersionStore } from '../server/versions.ts';
import { httpSource, renderToFiles } from '../scripts/render-lib.ts';

const db = loadDb();
const ID = 'de9-crossover';
const STARTERS = ['dc-led-lead', 'dc-pigtail-lead', 'dc-y-from-leads', 'dc-y-splitter', 'de9-crossover', 'de9-terminal-board'];
const SHEETS = ['build-sheet', 'bom', 'test-spec', 'drawing'] as const;
const FAKE_PDF = new TextEncoder().encode('%PDF-1.7\n% stand-in\n%%EOF\n');

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

/** A stand-in engine that keeps what it was sent. */
function recordingEngine(answer: (html: string) => Promise<Uint8Array> = async () => FAKE_PDF): PdfEngine & { sent: string[] } {
  const sent: string[] = [];
  return {
    describe: 'http://engine.test',
    sent,
    htmlToPdf: async (html) => {
      sent.push(html);
      return answer(html);
    },
  };
}

function hubDeps(extra: Partial<WorkbenchDeps> = {}): WorkbenchDeps {
  return {
    designs: memoryDesigns(STARTERS.map((id) => loadDesign(id))),
    loadDb: () => db,
    drawings: memoryDrawingStore(),
    versions: memoryVersionStore(),
    now: () => '2026-10-05T10:00:00.000Z',
    localUser: { name: 'Owner', source: 'local' },
    ...extra,
  };
}

const get = (path: string, d: WorkbenchDeps): Promise<ApiResponse> => routeWorkbenchRequest({ method: 'GET', path }, d);

describe('configuration', () => {
  it('CI tests the image the compose profile runs', () => {
    const root = new URL('../../../', import.meta.url);
    const image = (text: string, at: RegExp): string | undefined => at.exec(text)?.[1];
    const compose = image(readFileSync(new URL('compose.yaml', root), 'utf8'), /\n {2}pdf:\n(?: {4}.*\n)*? {4}image: (\S+)/);
    const ci = image(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'), /\n {6}pdf:\n {8}image: (\S+)/);
    expect(compose).toMatch(/^gotenberg\/gotenberg:\d+\.\d+\.\d+-chromium$/);
    expect(ci).toBe(compose);
  });


  it('is off without WIREHUB_PDF_ENGINE_URL, and a wrong value stops the start with a sentence', () => {
    expect(pdfEngineFromEnv({})).toBeUndefined();
    expect(pdfEngineFromEnv({ WIREHUB_PDF_ENGINE_URL: '  ' })).toBeUndefined();
    expect(pdfEngineFromEnv({ WIREHUB_PDF_ENGINE_URL: 'http://pdf:3000' })?.describe).toBe('http://pdf:3000');
    expect(() => pdfEngineFromEnv({ WIREHUB_PDF_ENGINE_URL: 'pdf:3000x' })).toThrow(/http or https/);
    expect(() => pdfEngineFromEnv({ WIREHUB_PDF_ENGINE_URL: 'not a url' })).toThrow(/WIREHUB_PDF_ENGINE_URL is not a URL/);
    expect(() => pdfEngineFromEnv({ WIREHUB_PDF_ENGINE_URL: 'http://pdf:3000', WIREHUB_PDF_ENGINE_TIMEOUT_MS: '5s' })).toThrow(/WIREHUB_PDF_ENGINE_TIMEOUT_MS/);
    expect(pdfEngineFromEnv({ WIREHUB_PDF_ENGINE_URL: 'http://pdf:3000', WIREHUB_PDF_ENGINE_TIMEOUT_MS: '60000' })).toBeDefined();
  });

  it('never shows credentials in the URL it names', () => {
    expect(gotenbergEngine(parseEngineUrl('https://user:secret@pdf.example.com/gotenberg')).describe).toBe('https://pdf.example.com/gotenberg');
  });
});

describe('the sheet sent to the engine', () => {
  it('carries its fonts inline, first in the stacks, before </head>', () => {
    const html = printableHtml('<!doctype html><html><head><title>t</title></head><body><div class="cs-root">x</div></body></html>');
    const style = /<style data-wirehub-print-fonts>([\s\S]*?)<\/style><\/head>/.exec(html)?.[1] ?? '';
    for (const family of ['CS Sans', 'Helvetica', 'Arial']) expect(style).toContain(`font-family:'${family}';font-style:normal;font-weight:700;src:url(data:font/woff2;base64,`);
    expect(style).toContain(".cs-root{--cs-font:'IBM Plex Sans','CS Sans',Helvetica,Arial,sans-serif}");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('is posted to Gotenberg as index.html, its own @page preferred, with no margins added', async () => {
    let form: FormData | undefined;
    let url = '';
    const engine = gotenbergEngine('http://pdf:3000', {
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        url = String(input);
        form = init?.body as FormData;
        return new Response(FAKE_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }) as typeof fetch,
    });
    expect(await engine.htmlToPdf('<html><head></head><body>sheet</body></html>')).toEqual(FAKE_PDF);
    expect(url).toBe('http://pdf:3000/forms/chromium/convert/html');
    const file = form?.get('files') as File;
    expect(file.name).toBe('index.html');
    expect(await file.text()).toContain('data-wirehub-print-fonts');
    expect(form?.get('preferCssPageSize')).toBe('true');
    expect(form?.get('printBackground')).toBe('true');
    expect(form?.get('marginTop')).toBe('0');
  });

  it('says what went wrong: a refusal, not a PDF, unreachable, too slow', async () => {
    const answering = (res: () => Response | Promise<Response>) => gotenbergEngine('http://pdf:3000', { fetchImpl: (async () => res()) as unknown as typeof fetch, timeoutMs: 50 });
    await expect(answering(() => new Response('Bad Request', { status: 400 })).htmlToPdf('x')).rejects.toThrow(/answered 400: Bad Request/);
    await expect(answering(() => new Response('<html>', { status: 200 })).htmlToPdf('x')).rejects.toThrow(/did not return a PDF/);
    await expect(answering(() => Promise.reject(new TypeError('fetch failed'))).htmlToPdf('x')).rejects.toBeInstanceOf(PdfEngineError);
    const slow = gotenbergEngine('http://pdf:3000', {
      timeoutMs: 20,
      fetchImpl: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))) as typeof fetch,
    });
    await expect(slow.htmlToPdf('x')).rejects.toThrow(/did not answer within/);
  });
});

describe('the documents route', () => {
  let engine: ReturnType<typeof recordingEngine>;
  beforeEach(() => {
    engine = recordingEngine();
  });

  it('without an engine: the headless PDF, and the headers say so', async () => {
    const deps = hubDeps();
    for (const kind of SHEETS) {
      const res = await get(`/api/designs/${ID}/documents/${kind}?format=pdf`, deps);
      expect(res.status).toBe(200);
      expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe(kind === 'drawing' ? 'raster' : 'text-layout');
      expect(res.headers?.['X-WireHub-PDF-Fallback']).toMatch(/No browser PDF engine is configured \(WIREHUB_PDF_ENGINE_URL\)/);
    }
    // the schematic and the label sheet are printed by the engine when there is one, so without it they are raster and say why
    for (const kind of ['schematic', 'labels']) {
      const res = await get(`/api/designs/${ID}/documents/${kind}?format=pdf`, deps);
      expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe('raster');
      expect(res.headers?.['X-WireHub-PDF-Fallback']).toMatch(/No browser PDF engine is configured/);
    }
    expect((await get(`/api/designs/${ID}/documents/formboard?format=pdf&scale=0.1`, deps)).headers?.['X-WireHub-PDF-Renderer']).toBe('vector');
    // not a PDF: no PDF headers
    expect((await get(`/api/designs/${ID}/documents/bom?format=html`, deps)).headers?.['X-WireHub-PDF-Renderer']).toBeUndefined();
  });

  it('with an engine: the HTML sheet, stamped with its state, printed by the engine', async () => {
    const deps = hubDeps({ pdfEngine: engine });
    for (const kind of SHEETS) {
      const res = await get(`/api/designs/${ID}/documents/${kind}?format=pdf&paper=letter`, deps);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe('application/pdf');
      expect(res.bytes).toEqual(FAKE_PDF);
      expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe('browser');
      expect(res.headers?.['X-WireHub-PDF-Fallback']).toBeUndefined();
      expect(res.headers?.['Content-Disposition']).toBe(`inline; filename="${ID}-${kind}.pdf"`);
      // what was sent is the html format's own answer
      const html = new TextDecoder().decode((await get(`/api/designs/${ID}/documents/${kind}?format=html&paper=letter`, deps)).bytes);
      expect(engine.sent.at(-1)).toBe(html);
      // the state is in the title block and the corner stamp: no watermark across the content
      expect(html).toMatch(/class="wh-stamp"|data-state-stamp="UNRELEASED"/);
      expect(html).not.toContain('cs-unreleased-mark');
    }
    expect(engine.sent[0]).toContain('@page{size:215.9mm 279.4mm');
    // the schematic and the labels are printed by the engine too, inside the same frame: vector, text kept as text
    for (const kind of ['schematic', 'labels']) {
      const res = await get(`/api/designs/${ID}/documents/${kind}?format=pdf&paper=letter`, deps);
      expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe('browser');
      expect(res.headers?.['X-WireHub-PDF-Fallback']).toBeUndefined();
      const page = engine.sent.at(-1) ?? '';
      expect(page).toMatch(/<svg[^>]*class="wh-sheet"|<svg[^>]*data-pages=/);
      expect(page).toContain('data-state-stamp="UNRELEASED"');
      expect(page).toContain('<text');
      expect(page).not.toContain('<image');
    }
    // the formboard keeps its own vector PDF
    expect((await get(`/api/designs/${ID}/documents/formboard?format=pdf&scale=0.1`, deps)).headers?.['X-WireHub-PDF-Renderer']).toBe('vector');
    expect(engine.sent).toHaveLength(SHEETS.length + 2);
  });

  it('a saved revision prints without the mark', async () => {
    const deps = hubDeps({ pdfEngine: engine });
    expect((await routeWorkbenchRequest({ method: 'POST', path: `/api/designs/${ID}/versions`, body: { note: 'first' } }, deps)).status).toBe(201);
    expect((await get(`/api/designs/${ID}/documents/build-sheet?format=pdf&rev=latest`, deps)).headers?.['X-WireHub-PDF-Renderer']).toBe('browser');
    expect(engine.sent.at(-1)).not.toContain('class="wh-stamp"');
  });

  it('an engine that fails: still a PDF, the headless one, and the header says why', async () => {
    const deps = hubDeps({ pdfEngine: recordingEngine(async () => Promise.reject(new PdfEngineError('the engine at http://engine.test answered 503'))) });
    const res = await get(`/api/designs/${ID}/documents/bom?format=pdf`, deps);
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.bytes!.subarray(0, 8))).toBe('%PDF-1.4');
    expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe('text-layout');
    expect(res.headers?.['X-WireHub-PDF-Fallback']).toBe('The browser PDF engine failed (the engine at http://engine.test answered 503), so this is the headless PDF, not the printed HTML sheet.');
  });

  it('the hub branding is on the sheets the server draws, as the browser registers it', async () => {
    const docs = memoryDocStore({ [BRANDING_PATH]: { organisation: 'Example Works Ltd', notes: ['EXAMPLE NOTE ONE', 'EXAMPLE NOTE TWO', 'EXAMPLE NOTE THREE'], src: 'test' } });
    const deps = hubDeps({ pdfEngine: engine, docs });
    await get(`/api/designs/${ID}/documents/drawing?format=pdf`, deps);
    expect(engine.sent.at(-1)).toContain('EXAMPLE NOTE TWO');
    // registered only while that sheet was drawn
    const plain = new TextDecoder().decode((await get(`/api/designs/${ID}/documents/drawing?format=html`, hubDeps())).bytes);
    expect(plain).not.toContain('EXAMPLE NOTE TWO');
  });

  it('a wire stock spec sheet: printed by the engine, or the headless pages with the reason', async () => {
    const wire = db.wires[0]!;
    const res = await get(`/api/definitions/wires/${wire.id}/wire-spec?format=pdf&paper=letter`, hubDeps({ pdfEngine: engine }));
    expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe('browser');
    expect(res.headers?.['Content-Disposition']).toMatch(/filename="WSS_.*\.pdf"/);
    expect(engine.sent.at(-1)).toMatch(/@page\{size:215\.9mm 279\.4mm/i);
    const plain = await get(`/api/definitions/wires/${wire.id}/wire-spec?format=pdf`, hubDeps());
    expect(plain.headers?.['X-WireHub-PDF-Renderer']).toBe('text-layout');
    expect(plain.headers?.['X-WireHub-PDF-Fallback']).toMatch(/WIREHUB_PDF_ENGINE_URL/);
  });

  it('the render command passes the fallback note on', async () => {
    const lines: string[] = [];
    const source = httpSource('http://studio.test', 't', (async () =>
      new Response(FAKE_PDF, { status: 200, headers: { 'content-disposition': 'inline; filename="x-bom.pdf"', 'x-wirehub-pdf-fallback': 'No browser PDF engine is configured.' } })) as unknown as typeof fetch);
    await renderToFiles(source, { design: 'x', what: 'bom', format: 'pdf', out: '-', query: {} }, { stdout: () => {}, log: (line) => lines.push(line) });
    expect(lines).toEqual(['note: No browser PDF engine is configured. (/api/designs/x/documents/bom?format=pdf)']);
  });
});

// A running engine: `docker compose --profile pdf up -d pdf` publishes nothing,
// so for a local run start the same image on a port, e.g.
//   docker run --rm -p 127.0.0.1:3000:3000 gotenberg/gotenberg:8.37.0-chromium
//   WIREHUB_TEST_PDF_ENGINE_URL=http://127.0.0.1:3000 pnpm --filter studio exec vitest run --project workbench-api test/browser-pdf.server.test.ts
const LIVE = process.env['WIREHUB_TEST_PDF_ENGINE_URL']?.trim() ?? '';

describe.skipIf(LIVE === '')(`a real engine (${LIVE === '' ? 'skipped: set WIREHUB_TEST_PDF_ENGINE_URL to a running Gotenberg to run these' : LIVE})`, () => {
  const live = (): WorkbenchDeps => hubDeps({ pdfEngine: gotenbergEngine(LIVE, { timeoutMs: 60_000 }) });

  /** Each page's MediaBox, in points, as Chromium (Skia) writes it. */
  function pageSizes(bytes: Uint8Array): [number, number][] {
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toMatch(/\/Producer \(Skia\/PDF/);
    return [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Math.round(Number(m[1])), Math.round(Number(m[2]))]);
  }

  it(
    'prints every sheet of every starter design at its own page size',
    async () => {
      const deps = live();
      for (const id of STARTERS) {
        for (const kind of SHEETS) {
          for (const paper of ['A4', 'letter'] as const) {
            if (kind === 'drawing' && paper === 'letter') continue; // the drawing sheet is one size
            const res = await get(`/api/designs/${id}/documents/${kind}?format=pdf&paper=${paper}`, deps);
            expect(res.status, `${id} ${kind}`).toBe(200);
            expect(res.headers?.['X-WireHub-PDF-Renderer'], `${id} ${kind}: ${res.headers?.['X-WireHub-PDF-Fallback']}`).toBe('browser');
            const sizes = pageSizes(res.bytes!);
            expect(sizes.length, `${id} ${kind}`).toBeGreaterThanOrEqual(1);
            const want = kind === 'drawing' ? [792, 612] : paper === 'A4' ? [595, 842] : [612, 792];
            for (const size of sizes) expect(size, `${id} ${kind} ${paper}`).toEqual(want);
          }
        }
      }
    },
    300_000,
  );

  it('prints a wire stock spec sheet', async () => {
    const res = await get(`/api/definitions/wires/${db.wires[0]!.id}/wire-spec?format=pdf`, live());
    expect(res.headers?.['X-WireHub-PDF-Renderer']).toBe('browser');
    expect(pageSizes(res.bytes!).every(([w, h]) => w === 595 && h === 842)).toBe(true);
  }, 60_000);
});
