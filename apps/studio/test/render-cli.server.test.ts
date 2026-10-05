/** `pnpm --filter studio render`: arguments, request paths, files written, both sources. */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDb, loadDesign } from '@wirehub/catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routeWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { formatDesignJson } from '../server/designs.ts';
import { memoryDrawingStore } from '../server/drawings.ts';
import { httpSource, localSource, parseRenderArgs, renderToFiles, requestPaths, RenderCliError } from '../scripts/render-lib.ts';

const design = loadDesign('de9-crossover');
const files = new Map([[design.id, formatDesignJson(design)]]);
const deps: WorkbenchDeps = {
  designs: {
    list: () => [{ id: design.id, label: design.label }],
    has: (id) => files.has(id),
    read: (id) => (files.has(id) ? JSON.parse(files.get(id) as string) : undefined),
    write: () => ({ changed: true }),
    remove: () => undefined,
  },
  loadDb: () => loadDb(),
  drawings: memoryDrawingStore(),
};
const source = localSource((request) => routeWorkbenchRequest(request, deps));

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'wirehub-render-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const quiet = { stdout: () => undefined, log: () => undefined };

describe('a wire stock spec sheet', () => {
  it('asks for the stock route, with the format and paper', () => {
    expect(requestPaths(parseRenderArgs(['shielded-2pair-24awg', 'wire-spec', '--format', 'pdf', '--paper', 'letter']))).toEqual([
      '/api/definitions/wires/shielded-2pair-24awg/wire-spec?paper=letter&format=pdf',
    ]);
    expect(requestPaths(parseRenderArgs(['x', 'wire-spec']))).toEqual(['/api/definitions/wires/x/wire-spec']);
  });
});

describe('arguments', () => {
  it('reads positionals and options, = or space', () => {
    expect(parseRenderArgs(['de9-crossover', 'bom', '--format', 'csv', '--rev=latest', '--out', 'x', '--paper', 'letter'])).toEqual({
      design: 'de9-crossover', what: 'bom', format: 'csv', rev: 'latest', out: 'x', query: { paper: 'letter' },
    });
    expect(parseRenderArgs(['d', 'bom']).out).toBe('.');
  });

  it('refuses what it does not know, with the usage', () => {
    expect(() => parseRenderArgs(['d'])).toThrow(/usage: pnpm --filter studio render/);
    expect(() => parseRenderArgs(['d', 'bom', '--format', 'docx'])).toThrow('--format must be one of html, svg, pdf, csv');
    expect(() => parseRenderArgs(['d', 'bom', '--wat', '1'])).toThrow('--wat is not an option');
    expect(() => parseRenderArgs(['d', 'bom', '--rev'])).toThrow('--rev needs a value');
  });
});

describe('request paths', () => {
  it('a document, an export, or all of them', () => {
    expect(requestPaths(parseRenderArgs(['d', 'bom', '--format', 'csv', '--rev', '2']))).toEqual(['/api/designs/d/documents/bom?rev=2&format=csv']);
    expect(requestPaths(parseRenderArgs(['d', 'labels.csv']))).toEqual(['/api/designs/d/exports/labels.csv']);
    expect(() => requestPaths(parseRenderArgs(['d', 'labels.csv', '--format', 'csv']))).toThrow(RenderCliError);
    const all = requestPaths(parseRenderArgs(['d', 'all']));
    expect(all).toHaveLength(12);
    expect(all).toContain('/api/designs/d/documents/schematic?format=pdf');
  });
});

describe('writing files', () => {
  it('renders each document into the directory under the name the answer proposes', async () => {
    const written = await renderToFiles(source, parseRenderArgs([design.id, 'all', '--out', dir]), quiet);
    expect(readdirSync(dir).sort()).toEqual(
      ['schematic.svg', 'schematic.pdf', 'build-sheet.html', 'build-sheet.pdf', 'bom.html', 'bom.pdf', 'test-spec.html', 'test-spec.pdf', 'drawing.svg', 'drawing.pdf', 'labels.svg', 'labels.pdf']
        .map((name) => `${design.id}-${name}`)
        .sort(),
    );
    expect(written).toHaveLength(12);
    expect(readFileSync(join(dir, `${design.id}-build-sheet.pdf`)).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('an export, csv, to a file or to stdout', async () => {
    await renderToFiles(source, parseRenderArgs([design.id, 'continuity.csv', '--out', dir]), quiet);
    expect(readFileSync(join(dir, `${design.id}-continuity.csv`), 'utf8').split('\r\n')[0]).toMatch(/^type,id,net/);
    let out = '';
    await renderToFiles(source, parseRenderArgs([design.id, 'bom', '--format', 'csv', '--out', '-']), { ...quiet, stdout: (bytes) => void (out += new TextDecoder().decode(bytes)) });
    expect(out.split('\r\n')[0]).toMatch(/^section,part_number/);
    await expect(renderToFiles(source, parseRenderArgs([design.id, 'all', '--out', '-']), quiet)).rejects.toThrow('--out - writes one file');
  });

  it('says what the studio said when it refuses', async () => {
    await expect(renderToFiles(source, parseRenderArgs(['nope', 'bom', '--out', dir]), quiet)).rejects.toThrow("There is no design called 'nope'.");
    await expect(renderToFiles(source, parseRenderArgs([design.id, 'schematic', '--format', 'csv', '--out', dir]), quiet)).rejects.toThrow('It comes as svg, pdf.');
  });
});

describe('over http', () => {
  it('sends the token and keeps the bytes', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers['authorization'] ?? null });
      return new Response(new Uint8Array([0, 255, 10, 13]), { status: 200, headers: { 'content-disposition': 'attachment; filename="x-bom.csv"' } });
    }) as unknown as typeof fetch;
    const http = httpSource('https://hub.example/', 'cst_dev_abc', fake);
    await renderToFiles(http, parseRenderArgs(['x', 'bom.csv', '--out', dir]), quiet);
    expect(seen).toEqual([{ url: 'https://hub.example/api/designs/x/exports/bom.csv', auth: 'Bearer cst_dev_abc' }]);
    expect([...readFileSync(join(dir, 'x-bom.csv'))]).toEqual([0, 255, 10, 13]);
    const refusing = httpSource('https://hub.example', 't', (async () => new Response(JSON.stringify({ error: 'No.', hint: 'Sign in.' }), { status: 401 })) as unknown as typeof fetch);
    await expect(renderToFiles(refusing, parseRenderArgs(['x', 'bom', '--out', dir]), quiet)).rejects.toThrow('No. Sign in.');
  });
});
