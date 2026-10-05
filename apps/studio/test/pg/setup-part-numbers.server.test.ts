/** First-run setup's part-number step (plan §9.2 item 4): edited prefixes land in part-numbers.json. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fsBlobStore } from '../../server/blobs.ts';
import { openPgBackend, type PgBackend } from '../../server/pg/deps.ts';
import { partNumbersFile } from '../../server/pg/setup-mode.ts';
import { createStandaloneApp } from '../../server/standalone-app.ts';
import { describePg, freshDatabase, type TestDatabase } from './harness.ts';

describe('partNumbersFile', () => {
  it('writes nothing for the defaults, a file for edits, and refuses nonsense', () => {
    expect(partNumbersFile(undefined)).toBeUndefined();
    expect(partNumbersFile({ prefixes: { connector: 'CON', component: 'CMP', wire: 'WIR', pcba: 'PCA', 'bare-pcb': 'PCB', shell: 'SHL', fastener: 'HW', 'mechanical-other': 'MEC', kit: 'KIT', design: 'CBL' }, digits: 5 })).toBeUndefined();
    const made = partNumbersFile({ prefixes: { connector: 'C', wire: 'W', design: 'X', kit: '' }, digits: 6 });
    expect(made && 'text' in made && JSON.parse(made.text)).toMatchObject({ prefixes: { connector: 'C', wire: 'W', design: 'X' }, digits: 6, separator: '-' });
    expect(partNumbersFile({ prefixes: { connector: 'lower' } })).toMatchObject({ error: expect.stringContaining('capitals') });
    expect(partNumbersFile({ prefixes: { connector: 'AB', wire: 'AB' } })).toMatchObject({ error: expect.stringContaining('two kinds') });
    expect(partNumbersFile({ prefixes: { bogus: 'AB' } })).toMatchObject({ error: expect.stringContaining('not a part-number kind') });
    expect(partNumbersFile({ prefixes: {}, digits: 99 })).toMatchObject({ error: expect.stringContaining('digits') });
  });
});

describePg('setup with a part-number scheme', () => {
  let database: TestDatabase;
  let backend: PgBackend;
  let work: string;
  beforeAll(async () => {
    database = await freshDatabase();
    work = mkdtempSync(join(tmpdir(), 'wirehub-setup-pn-'));
    mkdirSync(join(work, 'dist'));
    writeFileSync(join(work, 'dist', 'index.html'), '<!doctype html><title>studio</title>');
    backend = await openPgBackend({ DATABASE_URL: database.appUrl, WIREHUB_SETUP_PROMPT: '1' }, { blobs: fsBlobStore(join(work, 'blobs')) });
  }, 60_000);
  afterAll(async () => {
    await backend?.close();
    await database?.drop();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('offers the default scheme, refuses a bad one, and stores the edited one', async () => {
    const app = createStandaloneApp({ distDir: join(work, 'dist'), deps: backend.deps, depictionDeps: backend.depictionDeps });
    const post = (body: unknown) => app.request('http://studio.test/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://studio.test' }, body: JSON.stringify(body) });
    const view = (await (await app.request('http://studio.test/api/setup')).json()) as { create: { partNumbers: { scheme: string; prefixes: Record<string, string>; digits: number } } };
    expect(view.create.partNumbers).toMatchObject({ scheme: 'prefix', prefixes: { connector: 'CON' }, digits: 5 });

    const form = { org: { name: 'Pn Shop', slug: 'pn-shop' }, catalog: 'empty', modules: [] };
    expect((await post({ ...form, partNumbers: { prefixes: { connector: 'nope' } } })).status).toBe(400);
    expect(backend.setupMode()).toBe(true);
    const done = await post({ ...form, partNumbers: { prefixes: { connector: 'C', wire: 'W', design: 'ASM' }, digits: 6 } });
    expect(done.status, await done.clone().text()).toBe(200);
    const pn = (await (await app.request('http://studio.test/api/part-numbers')).json()) as { scheme?: { prefixes?: Record<string, string> }; suggestions?: unknown };
    expect(JSON.stringify(pn)).toContain('"ASM"');
    const exported = (await (await app.request('http://studio.test/api/export')).json()) as { files?: Record<string, string> };
    expect(JSON.stringify(exported)).toContain('part-numbers.json');
  });
});
