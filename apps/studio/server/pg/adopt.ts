/**
 * Adopting a file deployment (the compose stack's migrate step, plan §9.5 /
 * Phase S): on a database with no organisation, a file catalog that was in
 * use — its first-run setup completed, or its catalog differs from the
 * pristine starter the image carries — is imported as one organisation, its
 * installed packs flattened in. A fresh install is left alone: first-run setup
 * (`/setup`) creates the organisation and its catalog. Nothing happens once any
 * organisation exists, so the step runs on every start.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ASSET_MIME_EXT } from '@wirehub/catalog/src/codec/index.ts';
import { annotateErrors, readCatalogTree, readFlattenedCatalog } from '@wirehub/catalog/src/codec/tree.ts';

import type { BlobStore } from '../blobs.ts';
import { orgCount, type Db } from './db.ts';
import { importCatalog } from './import.ts';

export interface AdoptOptions {
  /** the catalog directory's parent (holds `data/`) */
  root: string;
  packs?: string;
  /** a pristine copy of the starter `data/` (the image's `/app/starter-catalog`) */
  starter?: string;
  org?: string;
  name?: string;
  blobs?: BlobStore;
}

export type AdoptOutcome = { kind: 'has-org' | 'fresh'; message: string } | { kind: 'adopted'; message: string; orgId: string };

export async function adoptFileCatalog(db: Db, options: AdoptOptions): Promise<AdoptOutcome> {
  if ((await orgCount(db)) > 0) return { kind: 'has-org', message: 'the database holds an organisation already; nothing to do' };
  const files = readFlattenedCatalog(options.root, options.packs);
  const setup = files.get('data/setup.json');
  const completed = typeof setup === 'string' && (JSON.parse(setup) as { completed?: boolean }).completed === true;
  let changed = false;
  if (options.starter !== undefined && existsSync(options.starter)) {
    const starter = readCatalogTree(options.starter, { dataDir: options.starter, depictionsDir: join(options.starter, '..', 'no-depictions') });
    const text = (m: ReadonlyMap<string, unknown>): [string, unknown][] => [...m.entries()].filter(([p, c]) => p.startsWith('data/') && typeof c === 'string');
    const mine = text(files);
    changed = mine.length !== text(starter).length || mine.some(([p, c]) => starter.get(p) !== c);
  }
  if (!completed && !changed) return { kind: 'fresh', message: 'a fresh install — first-run setup (/setup) creates the organisation and its catalog' };
  const org = options.org ?? 'main';
  const store = options.blobs;
  const report = await importCatalog(db, {
    org: { slug: org, name: options.name ?? 'WireHub', create: true },
    files,
    ...(store === undefined ? {} : { blobs: store }),
    // an upload the file backend kept in the blob store rather than in data/assets/
    fetchMissing: async (blob) => {
      const ext = ASSET_MIME_EXT[blob.mediaType];
      if (store === undefined || ext === undefined) return undefined;
      const bytes = await store.get(`assets/${blob.sha256}.${ext}`);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
    // a file the codec refuses is named with where it came from: the catalog, or a pack
    annotate: (errors) => annotateErrors(errors, options.root, options.packs),
    message: 'Adopt the file catalog into the database',
  });
  return { kind: 'adopted', orgId: report.orgId, message: `imported the file deployment's catalog (${files.size} files) as org '${org}', version ${report.version}` };
}
