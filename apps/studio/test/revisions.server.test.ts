/** Revisions of library records over the API on the real file backend, and a module's revision source. */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry, defineModule } from '@wirehub/modules';
import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-revisions-files-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
mkdirSync(join(work, 'packs'));
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
process.env.WIREHUB_PACKS_DIR = join(work, 'packs');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  delete process.env.WIREHUB_PACKS_DIR;
  rmSync(work, { recursive: true, force: true });
});

const call = async (deps: any, method: string, path: string, body?: unknown, user?: any, headers?: Record<string, string>) => {
  const { handleWorkbenchRequest } = await import('../server/api.ts');
  return (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as never;
};

describe('revisions of library records on files', () => {
  it('runs the revisions flow', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { runRevisionsFlow } = await import('./revisions-flow.ts');
    const deps = defaultWorkbenchDeps();
    await runRevisionsFlow({ call: (method, path, body, user, headers) => call(deps, method, path, body, user, headers) });
  }, 60_000);

  it('lists a module source\'s revisions beside the hub\'s, and a failing source as an error', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const deps = defaultWorkbenchDeps();
    deps.modules = createRegistry([
      defineModule({
        id: 'share-revisions',
        label: 'Revisions from a file share',
        version: '0.1.0',
        revisionSources: [
          { id: 'share', label: 'File share', kinds: ['pcbas'], list: ({ id }) => [{ rev: 'Rev1', note: `first of ${id}`, src: 'synthetic example: a file share' }] },
          { id: 'broken', label: 'Broken source', list: () => Promise.reject(new Error('share offline')) },
        ],
      }),
    ]);
    const board = await call(deps, 'GET', '/api/revisions/pcbas/pair-terminal-board') as { status: number; body: any };
    expect(board.status).toBe(200);
    expect(board.body.external.map((e: any) => [e.module, e.source, e.revisions.map((r: any) => r.rev), e.error])).toEqual([
      ['share-revisions', 'share', ['Rev1'], undefined],
      ['share-revisions', 'broken', [], 'share offline'],
    ]);
    // the share answers only for boards
    const plug = await call(deps, 'GET', '/api/revisions/connectors/de9-male') as { body: any };
    expect(plug.body.external.map((e: any) => e.source)).toEqual(['broken']);
  });
});
