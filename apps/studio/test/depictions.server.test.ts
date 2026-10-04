/**
 * The artwork API.
 *
 * `handleDepictionRequest` is a pure function of `(request, deps)`, so every
 * endpoint runs here with no server, no socket and no filesystem — the store is
 * a pair of `Map`s. What that leaves out (that the real store writes the bytes
 * it claims) is covered by the path-safety cases, which exercise the one place
 * an id becomes a directory.
 *
 * The four things this file exists to hold still:
 *
 * 1. An upload runs the *importer's* normalisation, so the GUI and the CLI
 *    cannot drift — an SVG comes back sanitised and mm-true, a raster comes
 *    back byte-identical with a declared scale.
 * 2. A format the ladder refuses is refused **with the ladder's own words**.
 * 3. An anchor write is validated against the live definition library, and a
 *    write aimed at a mirrored view is refused outright — the mirror rule is
 *    the whole reason this tool owns the flip.
 * 4. A definition id is a slug, never a path.
 */

import { loadDb, loadDesigns } from '@wirehub/catalog';
import type { Db } from '@wirehub/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { transactingDepictionDeps, type WorkbenchDeps } from '../server/api.ts';
import { commitChangeSet } from '../server/storage/unit-of-work.ts';

import {
  DEPICTION_ROUTES,
  depictionPaths,
  formatMetaJson,
  handleDepictionRequest,
  isDepictionPath,
  isDepictionDefId,
  parseMultipart,
  type DepictionApiResponse,
  type DepictionDeps,
  type DepictionStore,
  usedTerminals,
} from '../server/depictions.ts';

const db: Db = loadDb();

/** A real curated board, and a real connector — both with terminals to anchor. */
const BOARD = 'pair-terminal-board';
const CONNECTOR = 'de9-female';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Deliberately dirty: script, style, area fill, webfont, external image. */
const DIRTY_SVG = [
  '<?xml version="1.0"?>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 200 100">',
  '  <style>.x{fill:red}</style>',
  '  <script>alert(1)</script>',
  '  <rect x="10" y="10" width="180" height="80" fill="#ff0000" stroke="#000" stroke-width="2"',
  '        style="opacity:.5" onclick="boom()"/>',
  '  <text x="20" y="50" font-family="Comic Sans" fill="blue">P1</text>',
  '  <image href="http://example.invalid/x.png" x="0" y="0" width="10" height="10"/>',
  '</svg>',
].join('\n');

/** A 4×2 PNG, built from its own header — no encoder, no fixture file. */
function tinyPng(width = 4, height = 2): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: number[]): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be = (value: number): number[] => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  const chunk = (type: string, data: number[]): number[] => {
    const body = [...[...type].map((c) => c.charCodeAt(0)), ...data];
    return [...be(data.length), ...body, ...be(crc(body))];
  };
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be(width), ...be(height), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
    ...chunk('IEND', []),
  ]);
}

/* ------------------------------------------------------------------ *
 * The store, backed by Maps
 * ------------------------------------------------------------------ */

function memoryStore(): DepictionStore & {
  metas: Map<string, string>;
  assets: Map<string, Uint8Array>;
} {
  // stored as text exactly as the real one writes it, so a test can see that a
  // refused write really left the previous bytes in place
  const metas = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  return {
    metas,
    assets,
    listDefIds: () => [...metas.keys()].sort(),
    readMeta: (defId) => {
      const text = metas.get(defId);
      return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
    },
    writeMeta: (defId, meta) => void metas.set(defId, formatMetaJson(meta)),
    readAsset: (defId, file) => assets.get(`${defId}/${file}`),
    writeAsset: (defId, file, content) =>
      void assets.set(
        `${defId}/${file}`,
        typeof content === 'string' ? new TextEncoder().encode(content) : content,
      ),
    // no directory, so `validateDepiction` skips the file-exists check — the
    // store already knows the bytes are there, it just wrote them
    dirFor: () => undefined,
  };
}

let store: ReturnType<typeof memoryStore>;
let deps: DepictionDeps;

beforeEach(async () => {
  store = memoryStore();
  deps = { store, loadDb: () => db };
});

async function call(
  method: string,
  path: string,
  options: { json?: unknown; raw?: Uint8Array; contentType?: string } = {},
): Promise<DepictionApiResponse> {
  const raw =
    options.raw ??
    (options.json === undefined
      ? undefined
      : new TextEncoder().encode(JSON.stringify(options.json)));
  return await handleDepictionRequest(
    {
      method,
      path,
      ...(raw === undefined ? {} : { raw }),
      ...(options.contentType === undefined
        ? options.json === undefined
          ? {}
          : { contentType: 'application/json' }
        : { contentType: options.contentType }),
    },
    deps,
  );
}

/** Upload a file as JSON+base64, the encoding a script would use. */
async function upload(
  defId: string,
  view: string,
  fileName: string,
  bytes: Uint8Array | string,
  extra: Record<string, unknown> = {},
): Promise<DepictionApiResponse> {
  const data = Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
    .toString('base64');
  return await call('POST', `/api/depictions/${defId}/${view}`, {
    json: { fileName, data, ...extra },
  });
}

function body(response: DepictionApiResponse): any {
  if ('bytes' in response) throw new Error('expected a JSON response, got bytes');
  return response.body;
}

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

describe('a definition id is a slug, never a path', () => {
  it.each([
    '../../etc/passwd',
    '..',
    '.',
    'a/b',
    'a\\b',
    'Foo',
    'has space',
    'trailing-',
    '',
    'x'.repeat(101),
  ])('refuses %j', (id) => {
    expect(isDepictionDefId(id)).toBe(false);
  });

  it('accepts the ids the catalog actually uses', async () => {
    for (const id of ['pca-00112-rev5', BOARD, CONNECTOR]) {
      expect(isDepictionDefId(id)).toBe(true);
    }
  });

  it('refuses an evil id at the router, before any path is built', async () => {
    const response = await call('GET', '/api/depictions/..%2f..%2fetc%2fpasswd');
    expect(response.status).toBe(400);
    expect(body(response).hint).toContain('lowercase words joined by hyphens');
  });

  it('refuses an evil id on the write path too, and writes nothing', async () => {
    const response = await upload('../../tmp/evil', 'board-top', 'x.svg', DIRTY_SVG);
    expect(response.status).toBe(400);
    expect(store.metas.size).toBe(0);
    expect(store.assets.size).toBe(0);
  });

  it('throws rather than returning a path an id could escape through', async () => {
    expect(() => depictionPaths('../evil', '/root')).toThrow();
    expect(() => depictionPaths(BOARD, '/root').asset('../../etc/passwd')).toThrow();
    expect(() => depictionPaths(BOARD, '/root').asset('sub/dir.svg')).toThrow();
    expect(depictionPaths(BOARD, '/root').asset('board-top.svg')).toBe(
      `/root/${BOARD}/board-top.svg`,
    );
  });

  it('claims only its own paths', async () => {
    expect(isDepictionPath('/api/depictions')).toBe(true);
    expect(isDepictionPath('/api/depictions/x/board-top')).toBe(true);
    expect(isDepictionPath('/api/designs/x')).toBe(false);
    expect(isDepictionPath('/api/definitions/connectors')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe('reading a depiction', () => {
  it('lists the definitions that have one', async () => {
    expect(body(await call('GET', '/api/depictions')).depictions).toEqual([]);
    await upload(BOARD, 'board-top', 'b.svg', DIRTY_SVG);
    expect(body(await call('GET', '/api/depictions')).depictions).toEqual([BOARD]);
  });

  it('answers for a definition with no artwork at all, with its checklist', async () => {
    const detail = body(await call('GET', `/api/depictions/${CONNECTOR}`));
    expect(detail.exists).toBe(false);
    expect(detail.views).toEqual([]);
    // the checklist is the point: you can see what there is to anchor before
    // there is anything to anchor it onto
    expect(detail.definition.kind).toBe('connector');
    expect(detail.definition.terminals.length).toBeGreaterThan(8);
    expect(detail.uploadableViews).not.toContain('solder-side');
    expect(detail.uploadableViews).not.toContain('board-bottom');
  });

  it('serves the asset bytes with the right media type', async () => {
    await upload(BOARD, 'board-top', 'b.svg', DIRTY_SVG);
    const response = await call('GET', `/api/depictions/${BOARD}/board-top`);
    if (!('bytes' in response)) throw new Error('expected bytes');
    expect(response.contentType).toContain('image/svg+xml');
    expect(new TextDecoder().decode(response.bytes)).toContain('<svg');

    const png = await call('GET', `/api/depictions/${BOARD}/mating-face`);
    expect(png.status).toBe(404);
    expect(body(png).hint).toContain('Upload a file for this view first');
  });

  it('refuses methods it does not answer', async () => {
    expect((await call('DELETE', `/api/depictions/${BOARD}`)).status).toBe(405);
    expect((await call('PUT', `/api/depictions/${BOARD}/board-top`)).status).toBe(405);
    expect((await call('POST', `/api/depictions/${BOARD}/anchors`)).status).toBe(405);
    expect(DEPICTION_ROUTES.length).toBeGreaterThan(0);
  });

  it('says plainly when a path segment is not a view kind', async () => {
    const response = await call('GET', `/api/depictions/${BOARD}/back-of-envelope`);
    expect(response.status).toBe(404);
    expect(body(response).hint).toContain('board-top');
  });
});

/* ------------------------------------------------------------------ *
 * Uploading — the happy paths
 * ------------------------------------------------------------------ */

describe('uploading vector artwork', () => {
  it('normalises it exactly as the importer does, and merges the manifest', async () => {
    const response = await upload(BOARD, 'board-top', 'board.svg', DIRTY_SVG, {
      src: 'Drawn from the KiCad board outline.',
    });
    expect(response.status).toBe(201);
    const report = body(response);
    expect(report.kind).toBe('vector');
    // 200 user units wide at 20 mm across → a 20 × 10 mm frame, mm-true
    expect(report.frame).toEqual({ widthUnits: 20, heightUnits: 10, mmPerUnit: 1 });
    expect(report.warnings.join(' ')).toContain('script');
    expect(report.warnings.join(' ')).toContain('currentColor');

    const svg = new TextDecoder().decode(store.assets.get(`${BOARD}/board-top.svg`) as Uint8Array);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<style');
    expect(svg).not.toContain('onclick');
    expect(svg).not.toContain('example.invalid');
    expect(svg).not.toContain('Comic Sans');
    expect(svg).toContain('width="20mm"');

    const meta = JSON.parse(store.metas.get(BOARD) as string);
    expect(meta.defId).toBe(BOARD);
    expect(meta.anchorFrame).toBe('board-top');
    expect(meta.views['board-top'].file).toBe('board-top.svg');
    expect(meta.views['board-top'].src).toContain('Drawn from the KiCad board outline.');
    // the to-do list is the checklist the anchoring screen works from
    expect(meta.pinAnchorsTodo.length).toBeGreaterThan(0);
  });

  it('merges a second view into the manifest rather than replacing it', async () => {
    await upload(BOARD, 'board-top', 'a.svg', DIRTY_SVG);
    await upload(BOARD, 'illustration', 'b.svg', DIRTY_SVG);
    const meta = JSON.parse(store.metas.get(BOARD) as string);
    expect(Object.keys(meta.views).sort()).toEqual(['board-top', 'illustration']);
    // the frame the anchors are measured on does not move because a second
    // picture arrived
    expect(meta.anchorFrame).toBe('board-top');
  });

  it('never lets the request choose the file name', async () => {
    await upload(BOARD, 'board-top', '../../evil.svg', DIRTY_SVG, { out: '../../evil.svg' });
    expect([...store.assets.keys()]).toEqual([`${BOARD}/board-top.svg`]);
  });

  it('takes a multipart body as well as base64 JSON', async () => {
    const boundary = '----csTest';
    const text = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="widthMm"',
      '',
      '40',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="face.svg"',
      'Content-Type: image/svg+xml',
      '',
      DIRTY_SVG,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const response = await call('POST', `/api/depictions/${CONNECTOR}/mating-face`, {
      raw: new TextEncoder().encode(text),
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    expect(response.status).toBe(201);
    // the width field came through: 200 units across, declared 40 mm wide
    expect(body(response).frame.widthUnits).toBe(40);
  });
});

describe('uploading raster artwork', () => {
  it('demands a scale, and says how to give one', async () => {
    const response = await upload(CONNECTOR, 'mating-face', 'face.png', tinyPng());
    expect(response.status).toBe(422);
    const refusal = body(response);
    expect(refusal.guidance.join('\n')).toContain('4×2 px');
    expect(refusal.guidance.join('\n')).toContain('Real width (mm)');
    // and it is a refusal, not a half-import
    expect(store.metas.size).toBe(0);
    expect(store.assets.size).toBe(0);
  });

  it('copies the bytes unchanged once the scale is declared', async () => {
    const bytes = tinyPng();
    const response = await upload(CONNECTOR, 'mating-face', 'face.png', bytes, { widthMm: 10 });
    expect(response.status).toBe(201);
    const report = body(response);
    expect(report.kind).toBe('raster');
    // 4 px across a 10 mm part
    expect(report.frame).toEqual({ widthUnits: 4, heightUnits: 2, mmPerUnit: 2.5 });
    expect(report.warnings.join(' ')).toContain('copied as-is');
    expect([...(store.assets.get(`${CONNECTOR}/mating-face.png`) as Uint8Array)]).toEqual([
      ...bytes,
    ]);
  });

  it('refuses a scale that is not a positive number', async () => {
    expect((await upload(CONNECTOR, 'mating-face', 'f.png', tinyPng(), { widthMm: 0 })).status).toBe(400);
    expect((await upload(CONNECTOR, 'mating-face', 'f.png', tinyPng(), { widthMm: 'wide' })).status).toBe(
      400,
    );
    expect(store.assets.size).toBe(0);
  });

  it('refuses a file whose header is not the format its name claims', async () => {
    const response = await upload(CONNECTOR, 'mating-face', 'face.png', 'not a png at all', {
      widthMm: 10,
    });
    expect(response.status).toBe(422);
    expect(body(response).guidance.join(' ')).toContain('Re-export the image');
  });
});

/* ------------------------------------------------------------------ *
 * Uploading — refusals carry the ladder
 * ------------------------------------------------------------------ */

describe('a format the ladder will not take is refused in its own words', () => {
  it('names the rung and the one command that gets off it, for DXF', async () => {
    const response = await upload(BOARD, 'board-top', 'outline.dxf', 'DXF bytes');
    expect(response.status).toBe(415);
    const refusal = body(response);
    const guidance = refusal.guidance.join('\n');
    expect(guidance).toContain('ladder rung 2');
    expect(guidance).toContain('export plain SVG');
    expect(refusal.hint).toContain('Nothing was written');
    expect(store.metas.size).toBe(0);
  });

  it('does the same for PDF, and points at pdftocairo', async () => {
    const guidance = body(await upload(BOARD, 'board-top', 'sheet.pdf', '%PDF-1.4')).guidance.join('\n');
    expect(guidance).toContain('ladder rung 4');
    expect(guidance).toContain('pdftocairo');
  });

  it('still says something useful for a format nobody has heard of', async () => {
    const response = await upload(BOARD, 'board-top', 'thing.wibble', 'x');
    expect(response.status).toBe(415);
    expect(body(response).guidance.join('\n')).toContain('.svg');
  });

  it('refuses an upload with no file in it', async () => {
    expect((await call('POST', `/api/depictions/${BOARD}/board-top`)).status).toBe(400);
    expect(
      (await call('POST', `/api/depictions/${BOARD}/board-top`, { json: { fileName: 'a.svg' } })).status,
    ).toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * Anchoring
 * ------------------------------------------------------------------ */

describe('anchor writes', () => {
  const terminalsOf = async (defId: string): Promise<string[]> =>
    body(await call('GET', `/api/depictions/${defId}`)).definition.terminals.map(
      (t: { id: string }) => t.id,
    );

  beforeEach(async () => {
    await upload(BOARD, 'board-top', 'b.svg', DIRTY_SVG);
  });

  it('writes anchors the definition recognises, and reports what is left', async () => {
    const [first, second] = await terminalsOf(BOARD);
    const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      json: {
        anchorFrame: 'board-top',
        pinAnchors: { [first as string]: { x: 3, y: 4 }, [second as string]: { x: 5, y: 6 } },
      },
    });
    expect(response.status).toBe(200);
    const detail = body(response);
    expect(detail.pinAnchors[first as string]).toEqual({ x: 3, y: 4 });
    expect(detail.unanchored).not.toContain(first);
    expect(detail.unanchored.length).toBeGreaterThan(0);

    const meta = JSON.parse(store.metas.get(BOARD) as string);
    // key order matches what the importer writes, so the file diffs cleanly
    expect(Object.keys(meta)).toEqual([
      'defId',
      'views',
      'pinAnchors',
      'pinAnchorsTodo',
      'anchorFrame',
      'src',
    ]);
  });

  // 3pn.4: the gerber tier's `side`/`pads` fields used to be stripped on the
  // way through this endpoint — the client sent them, `readAnchorBody` kept
  // only `{x, y, note}`, and every save silently flattened a side-aware
  // anchor to a plain one. This is the round-trip that regressed.
  it('keeps side-aware pads on an anchor round-trip, not just x/y/note', async () => {
    const [first] = await terminalsOf(BOARD);
    const anchor = {
      x: 12.5,
      y: 4,
      side: 'top' as const,
      pads: [
        { ref: 'R2', pad: '1', x: 12.5, y: 4, side: 'top' as const },
        { ref: 'R2', pad: '2', x: 12.5, y: 9, side: 'bottom' as const },
      ],
    };
    const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      json: { anchorFrame: 'board-top', pinAnchors: { [first as string]: anchor } },
    });
    expect(response.status).toBe(200);
    const saved = body(response).pinAnchors[first as string];
    expect(saved).toEqual(anchor);

    // and it is what actually landed on disk, not just what the response echoes
    const onDisk = JSON.parse(store.metas.get(BOARD) as string).pinAnchors[first as string];
    expect(onDisk).toEqual(anchor);

    // a second save that touches nothing keeps it — the ordinary "reload,
    // save again" path a host's own re-serialisation must not erode
    const again = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      json: { anchorFrame: 'board-top', pinAnchors: { [first as string]: anchor } },
    });
    expect(body(again).pinAnchors[first as string]).toEqual(anchor);
  });

  it('refuses an anchor naming something that is not a terminal, and writes nothing', async () => {
    const before = store.metas.get(BOARD);
    const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      json: { anchorFrame: 'board-top', pinAnchors: { 'not-a-pin': { x: 1, y: 1 } } },
    });
    expect(response.status).toBe(422);
    const refusal = body(response);
    expect(refusal.issues.some((issue: { code: string }) => issue.code === 'unknown-pin-anchor')).toBe(
      true,
    );
    expect(refusal.hint).toContain('Nothing was written');
    expect(store.metas.get(BOARD)).toBe(before);
  });

  // sent as text, not as an object literal: `__proto__` in a literal is a
  // prototype assignment and would never reach the wire, which is exactly the
  // reason it is worth testing that the *parsed* key is refused
  it.each([
    ['a path', '"../../etc/passwd"'],
    ['a script', '"<script>alert(1)</script>"'],
    ['a prototype key', '"__proto__"'],
    ['a constructor key', '"constructor"'],
  ])('refuses %s as an anchor id', async (_what, key) => {
    const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      raw: new TextEncoder().encode(
        `{"anchorFrame":"board-top","pinAnchors":{${key}:{"x":1,"y":1}}}`,
      ),
      contentType: 'application/json',
    });
    expect(response.status).toBe(422);
    expect(body(response).issues.some((i: { code: string }) => i.code === 'unknown-pin-anchor')).toBe(
      true,
    );
    expect(JSON.parse(store.metas.get(BOARD) as string).pinAnchors).toEqual({});
  });

  it('refuses positions that are not numbers', async () => {
    const [first] = await terminalsOf(BOARD);
    for (const anchor of [{ x: 'left', y: 2 }, { x: Number.NaN, y: 2 }, { x: 1 }, 'over there']) {
      const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
        json: { anchorFrame: 'board-top', pinAnchors: { [first as string]: anchor } },
      });
      expect(response.status).toBe(400);
    }
  });

  /* --- the mirror rule ------------------------------------------- */

  it('refuses an anchor write aimed at a mirrored view, and explains the flip', async () => {
    // give the board an underside that declares itself a mirror of the top
    await upload(BOARD, 'board-bottom', 'bb.svg', DIRTY_SVG, {
      mirrorOf: 'board-top',
      mirrorAxis: 'x',
    });
    const [first] = await terminalsOf(BOARD);
    const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      json: { anchorFrame: 'board-bottom', pinAnchors: { [first as string]: { x: 1, y: 1 } } },
    });
    expect(response.status).toBe(409);
    const refusal = body(response);
    expect(refusal.error).toContain('generated by flipping board-top over');
    expect(refusal.hint).toContain('Place the anchors on board-top');
    expect(refusal.hint).toContain('classic wiring error');
    expect(JSON.parse(store.metas.get(BOARD) as string).pinAnchors).toEqual({});
  });

  it('reflects the anchors into the mirrored view instead of asking for them', async () => {
    await upload(BOARD, 'board-bottom', 'bb.svg', DIRTY_SVG, { mirrorOf: 'board-top' });
    const [first] = await terminalsOf(BOARD);
    const detail = body(
      await call('PUT', `/api/depictions/${BOARD}/anchors`, {
        json: { anchorFrame: 'board-top', pinAnchors: { [first as string]: { x: 3, y: 4 } } },
      }),
    );
    const bottom = detail.views.find((view: { view: string }) => view.view === 'board-bottom');
    expect(bottom.derived).toBe(true);
    // the frame is 20 mm across, so x = 3 lands at 17 on the other side; y is
    // untouched, because turning a board over is a left↔right flip
    expect(bottom.anchors[first as string]).toEqual({ x: 17, y: 4 });
  });

  it('refuses an anchor frame the depiction does not have', async () => {
    const response = await call('PUT', `/api/depictions/${BOARD}/anchors`, {
      json: { anchorFrame: 'mating-face', pinAnchors: {} },
    });
    expect(response.status).toBe(400);
    expect(body(response).hint).toContain('board-top');
  });

  it('refuses anchors for a definition with no artwork at all', async () => {
    const response = await call('PUT', `/api/depictions/${CONNECTOR}/anchors`, {
      json: { anchorFrame: 'mating-face', pinAnchors: {} },
    });
    expect(response.status).toBe(404);
    expect(body(response).hint).toContain('Upload a picture of the part first');
  });

  it('takes an alias as a legitimate anchor id for a connector pin', async () => {
    await upload(CONNECTOR, 'mating-face', 'f.svg', DIRTY_SVG);
    const aliased = db.connectors
      .find((connector) => connector.id === CONNECTOR)
      ?.pins.find((pin) => (pin.aliases ?? []).length > 0);
    if (aliased === undefined) return;
    const alias = (aliased.aliases as string[])[0] as string;
    const response = await call('PUT', `/api/depictions/${CONNECTOR}/anchors`, {
      json: { anchorFrame: 'mating-face', pinAnchors: { [alias]: { x: 1, y: 2 } } },
    });
    expect(response.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * The multipart reader
 * ------------------------------------------------------------------ */

describe('multipart parsing', () => {
  it('keeps binary payloads byte-exact', async () => {
    const boundary = 'X';
    const png = tinyPng();
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const raw = new Uint8Array(head.length + png.length + tail.length);
    raw.set(head, 0);
    raw.set(png, head.length);
    raw.set(tail, head.length + png.length);

    const parts = parseMultipart(raw, boundary);
    expect(parts).toHaveLength(1);
    expect(parts?.[0]?.fileName).toBe('a.png');
    expect([...(parts?.[0]?.bytes as Uint8Array)]).toEqual([...png]);
  });

  it('answers undefined rather than half-reading a body it cannot follow', async () => {
    expect(parseMultipart(new TextEncoder().encode('nothing like a form'), 'X')).toBeUndefined();
    expect(parseMultipart(new TextEncoder().encode('--X\r\nbroken'), 'X')).toBeUndefined();
    expect(parseMultipart(new Uint8Array(), '')).toBeUndefined();
  });
});

describe('pins the designs actually use', () => {
  const designs = loadDesigns();

  it('lists, per terminal, the designs that solder to it on an instance of the definition', async () => {
    const used = usedTerminals(designs, CONNECTOR);
    expect(Object.keys(used).length).toBeGreaterThan(0);
    for (const [terminal, ids] of Object.entries(used)) {
      for (const id of ids) {
        const d = designs.find((x) => x.id === id)!;
        const inst = new Set(d.instances.connectors.filter((c) => c.def === CONNECTOR).map((c) => c.id));
        expect(d.joints.some((j) => [j.a, j.b].some((e) => inst.has(e.instance) && e.terminal === terminal))).toBe(true);
      }
    }
  });

  it('counts an alias under its terminal id', async () => {
    const design = designs.find((d) => d.instances.connectors.some((c) => c.def === CONNECTOR))!;
    const inst = design.instances.connectors.find((c) => c.def === CONNECTOR)!.id;
    const one = { ...design, joints: [{ a: { instance: inst, terminal: 'twenty' }, b: { instance: inst, terminal: '20' } }] };
    expect(usedTerminals([one], CONNECTOR, [{ id: '20', aliases: ['twenty'] }])).toEqual({ '20': [design.id] });
  });

  it('the detail carries usedBy when the host scans designs, and nothing when it does not', async () => {
    await upload(BOARD, 'board-top', 'b.svg', DIRTY_SVG);
    expect(body(await call('GET', `/api/depictions/${BOARD}`)).usedBy).toBeUndefined();
    deps = { ...deps, loadDesigns: () => designs };
    const detail = body(await call('GET', `/api/depictions/${BOARD}`));
    expect(detail.usedBy).toEqual(usedTerminals(designs, BOARD, detail.definition.terminals));
  });
});

/* ------------------------------------------------------------------ *
 * Artwork in the change set (Postgres plan task B7, file backend first)
 * ------------------------------------------------------------------ */

describe('artwork writes commit as one change set', () => {
  const workbench = (): WorkbenchDeps => ({
    designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: true }), remove: () => {} },
    loadDb: () => db,
  });

  it('stages the asset and the manifest, then commits both through the store', async () => {
    const seen: string[] = [];
    const base = deps;
    deps = transactingDepictionDeps(base, { ...workbench(), commit: async (set) => {
      seen.push(...set.changes.map((c) => `${c.kind} ${c.key} ${c.op}`));
      return commitChangeSet({ ...workbench(), depictions: store }, set);
    } });
    const response = await upload(BOARD, 'board-top', 'board.svg', DIRTY_SVG);
    expect(response.status).toBe(201);
    expect(seen).toEqual([`depiction-asset ${BOARD}/board-top.svg put`, `depiction-meta ${BOARD} put`]);
    expect(store.metas.has(BOARD)).toBe(true);
    expect(store.assets.has(`${BOARD}/board-top.svg`)).toBe(true);
  });

  it('a manifest changed after the request read it refuses the whole set', async () => {
    await upload(BOARD, 'board-top', 'board.svg', DIRTY_SVG);
    const before = store.metas.get(BOARD);
    const base = deps;
    deps = transactingDepictionDeps(base, { ...workbench(), commit: async (set) => {
      // another writer lands between the read and the commit
      store.metas.set(BOARD, formatMetaJson({ ...JSON.parse(before as string), src: 'changed elsewhere' }));
      return commitChangeSet({ ...workbench(), depictions: store }, set);
    } });
    const response = await upload(BOARD, 'illustration', 'b.svg', DIRTY_SVG);
    expect(response.status).toBe(409);
    expect(store.assets.has(`${BOARD}/illustration.svg`)).toBe(false);
  });
});
