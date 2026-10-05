/**
 * A board's model link is keyed to its Gerber art (cs-d97): art that comes or
 * goes outside an upload through /api/depictions (a pack update or disable)
 * re-keys the link. The pieces: `rekeyBoardLinks` over the stores, and the
 * file backend's `afterInstall` hook that calls it.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-rekey-'));
const catalogPackage = fileURLToPath(new URL('../../../packages/catalog', import.meta.url));
cpSync(join(catalogPackage, 'data'), join(work, 'catalog', 'data'), { recursive: true });
cpSync(join(catalogPackage, 'depictions'), join(work, 'catalog', 'depictions'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'catalog', 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

const src = 'synthetic example: board art';
const view = (file: string) => ({ file, kind: 'vector', mmPerUnit: 1, sourceKind: 'gerber', widthUnits: 4, heightUnits: 4, src });
const meta = { defId: 'rekey-board', views: { 'board-top': view('board-top.svg'), 'board-bottom': view('board-bottom.svg') }, src, license: 'CC0-1.0' };
const svg = (mark: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><title>${mark}</title></svg>\n`;

describe('re-keying a board link when its art changes outside an upload', () => {
  it('the file backend: a pack operation\'s afterInstall hook re-keys pcbas/<id> as art comes, changes and goes', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { sha256Hex, sourceKey } = await import('../server/models/cache.ts');
    const deps = defaultWorkbenchDeps();
    const step = { path: 'models/rekey-board.step', sha256: sha256Hex(new TextEncoder().encode('step')) };
    const bare = { record: 'pcbas/rekey-board', asset: sourceKey([step], 50000), files: [step], sourceKind: 'kicad-board' as const, src };
    await deps.modelLinks!.put(bare);
    const link = async () => (await deps.modelLinks!.get('pcbas/rekey-board'))!;
    const hook = deps.setup!.afterInstall!;

    await hook();
    expect((await link()).asset).toBe(bare.asset);

    // art arrives (a pack installed or updated)
    await deps.depictions!.writeMeta('rekey-board', meta);
    await deps.depictions!.writeAsset('rekey-board', 'board-top.svg', svg('top1'));
    await deps.depictions!.writeAsset('rekey-board', 'board-bottom.svg', svg('bottom1'));
    await hook();
    const keyed = await link();
    expect(keyed.files!.map((f) => f.path).filter((p) => p.startsWith('depictions/'))).toEqual(['depictions/rekey-board/board-bottom.svg', 'depictions/rekey-board/board-top.svg']);
    expect(keyed.asset).not.toBe(bare.asset);

    // the art is replaced
    await deps.depictions!.writeAsset('rekey-board', 'board-top.svg', svg('top2'));
    await hook();
    expect((await link()).asset).not.toBe(keyed.asset);

    // the art goes (a pack disabled): the link is its bare model again
    for (const file of ['board-top.svg', 'board-bottom.svg', 'meta.json']) await deps.depictions!.removeAsset!('rekey-board', file);
    await hook();
    expect((await link()).asset).toBe(bare.asset);
    expect((await link()).files).toEqual([step]);
  });
});
