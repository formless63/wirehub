/** A pack carrying a numbering scheme and validation rules, on the file backend (a copy of the starter catalog, packs layered). */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { StudioUser } from '../server/me.ts';
import { fileDocStore } from '../server/storage/doc-store.ts';
import { runDeclarativePackFlow } from './declarative-pack-flow.ts';

describe('a data pack with a scheme and rules (file backend)', () => {
  let root = '';
  let deps: WorkbenchDeps;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-declarative-pack-'));
    const packs = join(root, 'packs');
    const dataDir = join(root, 'catalog/data');
    cpSync(dataPath(''), dataDir, { recursive: true });
    const view = () => createCatalog(catalogWithPacksSource(dataDir, packs));
    const docs = fileDocStore(join(root, 'catalog'));
    deps = {
      designs: { list: () => view().listDesignSummaries(), has: (id: string) => view().designExists(id), read: (id: string) => view().loadDesign(id), write: () => ({ changed: false }), remove: () => undefined } as never,
      loadDb: () => view().loadDb(),
      loadPartNumberFiles: () => ({ scheme: view().readJsonFile('part-numbers.json') }),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(dataDir, packs).packs }),
      docs,
      setup: { dataDir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs without switching the scheme, runs the pack\'s rules, lets an owner adopt the scheme, and disables cleanly', async () => {
    // the pack lifecycle raises pack.installed for the webhooks: installed, then disabled
    const events: { type: string; subject: { id: string }; summary?: Record<string, unknown> }[] = [];
    deps.webhooks = { emit: async (list) => void events.push(...list), jobFinished: async () => {}, catalogChanged: async () => {}, test: async () => undefined, redeliver: async () => undefined };
    await runDeclarativePackFlow({
      call: async (method, path, body, user?: StudioUser, headers?: Record<string, string>) =>
        (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string> },
    });
    expect(events.filter((e) => e.type === 'pack.installed').map((e) => [e.subject.id, e.summary?.['action']])).toEqual([['rules-pack', 'installed'], ['rules-pack', 'disabled']]);
  });
});
