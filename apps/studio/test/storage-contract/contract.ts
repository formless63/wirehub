/**
 * The storage contract suite (`specs/postgres-backend.md` §10), read cases
 * (task A8): every store of a backend, holding the starter catalog, answers
 * what the starter catalog's files say. Run on the file backend, on the
 * in-memory codec snapshot and on Postgres; the write cases arrive with the
 * write path (B9).
 *
 * The expectations are read straight from `packages/catalog/data` with the
 * catalog loaders, never from any backend under test.
 */

import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../../server/api.ts';
import { DEFINITION_KINDS } from '../../server/definition-store.ts';

export interface ContractBackend {
  deps: WorkbenchDeps;
  close?: () => Promise<void>;
}

const truth = createCatalog(fsCatalogSource(dataPath(''), 'the starter catalog'));

export function describeStorageContract(name: string, make: () => Promise<ContractBackend>, wrap: typeof describe = describe): void {
  wrap(`storage contract (reads): ${name}`, () => {
    const get = (() => {
      let backend: Promise<ContractBackend> | undefined;
      return () => (backend ??= make());
    })();
    const deps = async (): Promise<WorkbenchDeps> => (await get()).deps;

    it('designs: list, has, read', async () => {
      const store = (await deps()).designs;
      const ids = truth.listDesignIds();
      expect((await store.list()).map((d) => d.id)).toEqual(ids);
      for (const id of ids) {
        expect(await store.has(id)).toBe(true);
        expect(await store.read(id)).toEqual(truth.loadDesign(id));
      }
      expect(await store.has('no-such-design')).toBe(false);
      expect(await store.read('no-such-design')).toBeUndefined();
    });

    it('definitions: every kind, connectors composed', async () => {
      const store = (await deps()).definitions!;
      for (const kind of DEFINITION_KINDS) {
        const want = kind === 'connectors' ? truth.loadConnectors() : (truth.readJsonFile<unknown[]>(`${kind}.json`) ?? []);
        expect(await store.list(kind), kind).toEqual(want);
      }
    });

    it('vocab and tags', async () => {
      const d = await deps();
      expect(await d.vocab!.ids()).toEqual(truth.listVocabIds());
      for (const id of truth.listVocabIds()) expect(await d.vocab!.read(id)).toEqual(truth.loadVocabList(id));
      expect(await d.vocab!.read('no-such-list')).toBeUndefined();
      expect(await d.tags!.tags()).toEqual(truth.loadSignalTags());
      expect(await d.tags!.review()).toEqual(truth.readJsonFile('tags/review.json'));
    });

    it('wire library, builds, model links, assets', async () => {
      const d = await deps();
      expect(await d.wireLibrary!.read()).toEqual(truth.loadWireLibrary());
      expect(await d.wireLibrary!.wires()).toEqual(truth.loadWires());
      expect(await d.wireLibrary!.practice?.()).toEqual(truth.loadStripPractice());
      expect(await d.builds!.list()).toEqual(truth.loadBoardBuilds().map((file, i) => ({ name: truth.source.list('builds')[i]?.replace(/\.json$/, ''), file })));
      expect(await d.modelLinks!.list()).toEqual(truth.readJsonFile<{ links: unknown[] }>('models.json')?.links ?? []);
      expect(await d.assets!.list()).toEqual(truth.readJsonFile('assets/index.json') ?? []);
    });

    it('drawings and versions', async () => {
      const d = await deps();
      for (const id of truth.listDesignIds()) {
        expect((await d.drawings!.read(id)).meta).toEqual(truth.readJsonFile(`drawings/${id}.json`) ?? {});
        expect(await d.versions!.revisions(id)).toEqual(truth.listDesignRevisions(id));
        expect(await d.versions!.working(id)).toEqual(truth.readJsonFile(`designs/_versions/${id}/working.json`) ?? {});
        expect(await d.versions!.drafts(id)).toEqual([]);
      }
    });

    it('loadDb, part numbers and a stable catalog version', async () => {
      const d = await deps();
      expect(await d.loadDb()).toEqual(truth.loadDb());
      expect((await d.loadPartNumberFiles?.())?.scheme).toEqual(truth.readJsonFile('part-numbers.json'));
      const a = await d.catalogVersion?.();
      const b = await d.catalogVersion?.();
      expect(a).toBeDefined();
      expect(b).toBe(a);
    });

    it('closes', async () => {
      await (await get()).close?.();
    });
  });
}
