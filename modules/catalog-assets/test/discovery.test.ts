import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@wirehub/model';
import { manifestProblems } from '@wirehub/modules';
import { catalogAssets } from '../src/index.ts';
import { candidatesFromTree, KICAD, providerSearches, subjectForRecord } from '../src/discovery.ts';
import { listKicad, MAX_LIST_BYTES } from '../src/provider.ts';

const directory = 'Connector_RJ.3dshapes';
const entry = (name = 'RJ45_Amphenol_RJHSE538X.step') => ({ type: 'blob', name, path: `${directory}/${name}` });
const params = (extra?: Record<string, string>) => new URLSearchParams({ directory, ...extra });
const fetcherOf = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);

describe('reviewed CAD discovery', () => {
  it('keeps internal part numbers out of manufacturer searches and uses actual component MPNs', () => {
    const db = { connectors: [{ id: 'plug', label: 'Generic cable plug', partNumber: 'CON-00123' }], components: [{ id: 'jack', label: 'Jack', partNumber: 'CMP-00123', mpn: '123-ABC', manufacturer: 'Example maker' }] } as unknown as Db;
    expect(subjectForRecord(db, { kind: 'connectors', id: 'plug' })).toEqual({ label: 'Generic cable plug' });
    expect(subjectForRecord(db, { kind: 'components', id: 'jack' })).toEqual({ label: 'Jack', mpn: '123-ABC', manufacturer: 'Example maker' });
    expect(subjectForRecord(db, { kind: 'interfaces', id: 'plug' })).toBeUndefined();
  });

  it('offers fixed official provider search URLs, encoding user terms without inventing availability', () => {
    const links = providerSearches('ABC/123 & Variant');
    expect(links.map((p) => new URL(p.url).hostname)).toEqual(['www.te.com', 'www.snapeda.com', 'app.ultralibrarian.com']);
    expect(new URL(links[2]!.url).searchParams.get('queryText')).toBe('ABC/123 & Variant');
    expect(providerSearches('')).toEqual([]);
    expect(providerSearches('x'.repeat(121))).toEqual([]);
    expect(providerSearches('ABC\n123')).toEqual([]);
  });

  it('lists source-pinned STEP candidates while excluding traversal, foreign paths and unsupported formats', () => {
    const results = candidatesFromTree([entry(), entry('Example.wrl'), { ...entry(), path: 'Other.3dshapes/X.step' }, entry('../private.step'), entry('<svg>.step'), { ...entry(), type: 'tree' }], directory, 'amphenol');
    expect(results).toHaveLength(1);
    expect(results[0]!.match).toBe('unverified');
    expect(results[0]!.url).toContain(`/-/raw/${KICAD.commit}/Connector_RJ.3dshapes/`);
    expect(results[0]!.source).toContain('not verified');
    expect(results[0]!.license).toContain('KiCad libraries exception');
    expect(candidatesFromTree([entry()], directory, 'cable plug')).toEqual([]);
    expect(() => candidatesFromTree({ error: 'oops' }, directory, '')).toThrow();
  });

  it('uses the same pinned upstream version as the existing model builder', () => {
    const source = readFileSync(new URL('../../../apps/studio/server/models/kicad-library.ts', import.meta.url), 'utf8');
    expect(source).toContain(`tag: '${KICAD.tag}'`);
    expect(source).toContain(`commit: '${KICAD.commit}'`);
  });

  it('registers discovery only, without catalog or write contributions', () => {
    expect(manifestProblems([catalogAssets])).toEqual([]);
    expect(catalogAssets).not.toHaveProperty('catalogPacks');
    expect(catalogAssets).not.toHaveProperty('importers');
    expect(catalogAssets.integrations?.[0]?.routes?.[0]?.writes).not.toBe(true);
  });
});

describe('bounded public KiCad integration', () => {
  it('fetches one public pinned page and filters locally, retaining pagination after empty matches', async () => {
    const fetcher = fetcherOf(new Response(JSON.stringify([entry()]), { headers: { 'x-next-page': '3' } }));
    const out = await listKicad(params({ page: '2', q: 'cable plug' }), fetcher);
    expect(out).toMatchObject({ status: 200, body: { page: 2, candidates: [], hasMore: true, filteredPage: true } });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url).startsWith('https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-packages3D/repository/tree?')).toBe(true);
    expect(new URL(String(url)).searchParams.get('ref')).toBe(KICAD.commit);
    expect(new URL(String(url)).searchParams.has('q')).toBe(false);
    expect(options).toMatchObject({ redirect: 'error', headers: { Accept: 'application/json' } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.credentials).toBeUndefined();
  });

  it.each([{ directory: '../etc' }, { directory: 'https://example.invalid' }, { page: '21' }, { page: '0' }, { page: '1.5' }, { q: 'x'.repeat(121) }, { q: 'ABC\n123' }] as Record<string, string>[])('refuses invalid user input before any network call: %j', async (extra) => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await listKicad(params(extra), fetcher)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds streamed response bytes even without Content-Length and cancels the reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_LIST_BYTES + 1)); }, cancel });
    expect((await listKicad(params(), fetcherOf(new Response(body)))).status).toBe(502);
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects oversized declared length, malformed JSON, excess entries and upstream errors', async () => {
    for (const response of [
      new Response('[]', { headers: { 'content-length': String(MAX_LIST_BYTES + 1) } }),
      new Response('<html>gateway</html>'),
      new Response(JSON.stringify(Array.from({ length: 101 }, () => entry()))),
      new Response('rate limited', { status: 429 }),
    ]) expect((await listKicad(params(), fetcherOf(response))).status).toBe(502);
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    expect((await listKicad(params(), timeout)).status).toBe(502);
  });

  it('stops at the explicit page cap and handles absent pagination headers', async () => {
    const out = await listKicad(params({ page: '20' }), fetcherOf(new Response(JSON.stringify([entry()]), { headers: { 'x-next-page': '21' } })));
    expect(out).toMatchObject({ status: 200, body: { hasMore: false } });
    expect(await listKicad(params(), fetcherOf(new Response('[]')))).toMatchObject({ status: 200, body: { candidates: [], hasMore: false } });
  });
});
