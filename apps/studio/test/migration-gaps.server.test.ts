/** Gaps a private shop's migration found, on the file backend (a copy of the starter catalog, packs layered). */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogWithPacksSource, createCatalog, dataPath, installedAcross } from '@wirehub/catalog';
import { createRegistry } from '@wirehub/modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import type { StudioUser } from '../server/me.ts';
import { fileDocStore } from '../server/storage/doc-store.ts';
import { memoryAssetStore } from '../server/assets.ts';
import { depictionBlob } from '../server/default-deps.ts';
import { runBenchRulesPackFlow, runVendorPdfPackFlow, runPadMapPreviewFlow, runSchemeAndSelectorsFlow, type FlowCall } from './migration-gaps-flow.ts';

describe('migration gaps (file backend)', () => {
  let root = '';
  let deps: WorkbenchDeps;
  let call: FlowCall;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wirehub-migration-gaps-'));
    const packs = join(root, 'packs');
    const dataDir = join(root, 'catalog/data');
    cpSync(dataPath(''), dataDir, { recursive: true });
    const view = () => createCatalog(catalogWithPacksSource(dataDir, packs));
    deps = {
      designs: { list: () => view().listDesignSummaries(), has: (id: string) => view().designExists(id), read: (id: string) => view().loadDesign(id), write: () => ({ changed: false }), remove: () => undefined } as never,
      loadDb: () => view().loadDb(),
      loadPartNumberFiles: () => ({ scheme: view().readJsonFile('part-numbers.json') }),
      modules: createRegistry([]),
      installedPacks: () => ({ src: 'x', packs: installedAcross(dataDir, packs).packs }),
      docs: fileDocStore(join(root, 'catalog')),
      assets: memoryAssetStore(),
      blob: async (sha: string) => depictionBlob(sha, packs, join(root, 'catalog')),
      setup: { dataDir, packsDir: packs, prompt: false, now: () => '2026-10-05T12:00:00.000Z' },
    };
    call = async (method, path, body, user?: StudioUser, headers?: Record<string, string>) =>
      (await handleWorkbenchRequest({ method, path, ...(user === undefined ? {} : { user }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) }, deps)) as { status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a pack preview loads the pack\'s PCBA pad table: preview validation equals post-install validation', async () => {
    await runPadMapPreviewFlow(call);
  });

  it('a data pack\'s bench-rules.json is read at runtime and follows install, update and disable', async () => {
    await runBenchRulesPackFlow(call);
  });

  it('a numbering scheme with exclusions, unions and multi-segment matches, and cable-end rule selectors, through the API', async () => {
    await runSchemeAndSelectorsFlow(call);
  });

  it('signed vendor PDFs in a pack: pinned, installed, linked, served with safe headers, replaced and removed', async () => {
    await runVendorPdfPackFlow(call, { strictRemoval: true });
  });
});
