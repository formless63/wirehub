/**
 * The import gate, S1 (`specs/postgres-backend.md` §1, §7.2; task A7):
 * a file catalog and its import into Postgres answer identically.
 *
 * | check | compares |
 * | --- | --- |
 * | `codec-identity` | `render(explode(tree))` and the tree, byte for byte |
 * | `export-identity` | the pg snapshot rendered as files (the on-demand export) and the tree: text byte for byte, binaries by sha256 through the blob store |
 * | `sql-etags` | the database's generated `etag` of every record, revision, doc and model link, and `contentETag` of the body in JS |
 * | `validation` | `validateDb`, and `validateDesign` per design (with the design library, `Db.assemblies`), over the file catalog and the pg snapshot |
 * | `documents` | per design: schematic SVG, build sheet, BOM and continuity spec, as strings (sub-assemblies flattened alike) |
 * | `refs-vs-usage` | `usageFromEdges(referencesOf …)` and the model's `definitionUsage`, for every definition; the `subassembly` edges and `subassemblyParents`, for every design |
 * | `api-parity` | every GET route × every id through `handleWorkbenchRequest`: status, body (JSON text, key order included), ETag header — files vs pg |
 *
 * The file side of `api-parity` is the file backend's stores themselves
 * (`defaultWorkbenchDeps`) when the tree is the live catalog, and the
 * snapshot stores over the directory on disk otherwise (any catalog: a
 * deployment's, the starter with packs installed).
 * | `derived-blobs` | with `models` (after the `model-cache` job): every live model key built in `derived_blob` at the current converter version; and, given the file backend's model cache, the same bytes for every key both hold (the builder is deterministic, §5.5) |
 */

import { createCatalog, memoryCatalogSource, type Catalog } from '@wirehub/catalog';
import { codePointCompare, contentSha, dataFileMap, explode, isBlobRef, render, sha256Hex, type CatalogFiles, type CatalogRows, type FileContent } from '@wirehub/catalog/src/codec/index.ts';
import { bomToMarkdown, deriveBom, deriveTestSpec, renderBuildSheet, testSpecToMarkdown } from '@wirehub/docs';
import { definitionUsage, subassemblyParents, validateDb, validateDesign, withAssemblies, type UsageKind } from '@wirehub/model';
import { renderSchematic } from '@wirehub/render-svg';
import { sql } from 'kysely';

import { handleWorkbenchRequest, type ApiResponse, type WorkbenchDeps } from '../api.ts';
import type { BlobStore } from '../blobs.ts';
import { DEFINITION_KINDS } from '../definition-store.ts';
import { contentETag } from '../etag.ts';
import { inOrg, type Db } from './db.ts';
import { pgWorkbenchDeps, type SnapshotSource } from './deps.ts';
import { usageFromEdges, referencesOf, type SourcedEdge } from './refs.ts';
import { blobObjectKey } from './keys.ts';
import type { Snapshot } from './snapshot.ts';
import { liveModelLinks } from '../jobs/model-cache.ts';
import type { ModelCache } from '../models/cache.ts';
import type { ModelLink } from '../models/links.ts';
import { pgModelCache } from './model-cache.ts';

export interface GateCheck {
  name: string;
  /** how many things were compared */
  compared: number;
  /** each difference, as a sentence (empty = identical) */
  diffs: string[];
  ms: number;
}

export interface GateReport {
  ok: boolean;
  checks: GateCheck[];
  /** the GET paths `api-parity` compared */
  routes: string[];
}

export interface GateOptions {
  /** the file catalog, read with `readCatalogTree(root)` */
  tree: CatalogFiles;
  /** the directory holding its `data/` (and `depictions/`) */
  root: string;
  /** the pg side */
  pg: { db: Db; cache: SnapshotSource; blobs?: BlobStore };
  /** the real file backend's deps, when `root` is the live catalog (they read nowhere else) */
  filesDeps?: WorkbenchDeps;
  /** compare derived blobs (C6): run after the `model-cache` job; `fileCache` is the file backend's built models */
  models?: { fileCache?: ModelCache };
}

const MAX_DIFFS = 50;

async function check(name: string, run: (diff: (line: string) => void) => Promise<number> | number): Promise<GateCheck> {
  const started = performance.now();
  const diffs: string[] = [];
  let total = 0;
  const diff = (line: string): void => {
    total += 1;
    if (diffs.length < MAX_DIFFS) diffs.push(line);
  };
  let compared = 0;
  try {
    compared = await run(diff);
  } catch (error) {
    diff(`threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  if (total > diffs.length) diffs.push(`… and ${total - diffs.length} more`);
  return { name, compared, diffs, ms: Math.round(performance.now() - started) };
}

const bytesEqual = (a: FileContent, b: FileContent): boolean => contentSha(a) === contentSha(b);

/** Compare two trees: text exactly, bytes by hash, and the path sets. */
function compareTrees(expected: CatalogFiles, actual: ReadonlyMap<string, string | Uint8Array>, diff: (line: string) => void, options: { binaries: 'compare' | 'skip-missing' }): number {
  let n = 0;
  for (const [path, want] of expected) {
    n += 1;
    const got = actual.get(path);
    if (got === undefined) {
      if (typeof want !== 'string' && options.binaries === 'skip-missing') continue;
      diff(`${path}: missing`);
    } else if (typeof want === 'string') {
      if (got !== want) diff(`${path}: text differs`);
    } else if (typeof got === 'string' || !bytesEqual(want, got)) diff(`${path}: bytes differ`);
  }
  for (const path of actual.keys()) if (!expected.has(path)) diff(`${path}: not in the file catalog`);
  return n;
}

/** A blob store over the binary files of a tree (the file side's bytes), keyed like the pg store. */
export function treeBlobStore(tree: CatalogFiles, orgId: string): BlobStore {
  const bySha = new Map<string, Uint8Array>();
  for (const content of tree.values()) if (typeof content !== 'string' && !isBlobRef(content)) bySha.set(sha256Hex(content), content);
  const shaOf = (key: string): string | undefined => (key.startsWith(`${orgId}/sha256/`) ? key.slice(key.lastIndexOf('/') + 1) : undefined);
  return {
    describe: 'the file catalog tree',
    get: async (key) => {
      const bytes = bySha.get(shaOf(key) ?? '');
      return bytes === undefined ? undefined : Buffer.from(bytes);
    },
    has: async (key) => bySha.has(shaOf(key) ?? ''),
    put: async () => {
      throw new Error('read-only');
    },
    delete: async () => {
      throw new Error('read-only');
    },
  };
}

/** A snapshot of a directory on disk: the catalog loaders over the files themselves. */
export function directorySnapshot(root: string, rows: CatalogRows, tree: CatalogFiles): Snapshot {
  // the tree as read (a deployment's packs flattened into it), through the same loaders
  const source = memoryCatalogSource(dataFileMap(tree as ReadonlyMap<string, string | Uint8Array>), { name: `the file catalog at ${root}` });
  const blobOf = new Map<string, string>();
  for (const [path, content] of tree) if (typeof content !== 'string') blobOf.set(path, contentSha(content));
  return { version: 'files', rows, files: tree, source, catalog: createCatalog(source), blobOf, loadMs: 0 };
}

/** Every GET route of the workbench API, with every id the catalog has. */
export function gateRoutes(catalog: Catalog, rows: CatalogRows): string[] {
  const enc = encodeURIComponent;
  const designs = catalog.listDesignIds();
  const out = ['/api', '/api/designs', '/api/db', '/api/part-numbers', '/api/drawings', '/api/assets', '/api/assets/index', '/api/definitions', '/api/models', '/api/vocab', '/api/wire-library', '/api/wire-library/strip-practice', '/api/builds', '/api/me', '/api/backup', '/api/locks'];
  for (const id of designs) {
    out.push(`/api/designs/${enc(id)}`, `/api/drawings/${enc(id)}`, `/api/designs/${enc(id)}/versions`);
  }
  for (const r of rows.revisions) out.push(`/api/designs/${enc(r.design)}/versions/${r.rev}`, `/api/designs/${enc(r.design)}/versions/${r.rev}/artwork`);
  for (const a of rows.assets) out.push(`/api/assets/${a.sha256}`);
  const plural: Record<string, string> = { connector: 'connectors', component: 'components', wire: 'wires', pcba: 'pcbas', body: 'bodies', interface: 'interfaces', mechanical: 'mechanicals', kit: 'kits' };
  for (const kind of DEFINITION_KINDS) out.push(`/api/definitions/${kind}`);
  for (const r of rows.records) {
    const kind = plural[r.kind];
    if (kind !== undefined) out.push(`/api/definitions/${kind}/${enc(r.slug)}`, `/api/definitions/${kind}/${enc(r.slug)}/usage`, `/api/models/${kind}/${enc(r.slug)}`);
  }
  for (const b of rows.blobs) out.push(`/api/blobs/${b.sha256}`);
  for (const l of rows.modelLinks) out.push(`/api/models/${l.recordKey.split('/').map(enc).join('/')}`);
  for (const id of catalog.listVocabIds()) out.push(`/api/vocab/${enc(id)}`);
  for (const r of rows.records) if (r.kind === 'build') out.push(`/api/builds/${enc(r.slug)}`);
  // a missing id answers the same 404 on both
  out.push('/api/designs/no-such-design', '/api/definitions/connectors/no-such-part', '/api/vocab/no-such-list');
  return [...new Set(out)];
}

/** The parts of a response the browser sees, as comparable text. */
function responseText(response: ApiResponse): string {
  const body = response.bytes !== undefined ? `bytes:${sha256Hex(response.bytes)}:${response.contentType ?? ''}` : JSON.stringify(response.body);
  return `${response.status} etag=${response.headers?.etag ?? response.headers?.ETag ?? '-'} ${body}`;
}

async function apiParity(routes: string[], a: WorkbenchDeps, b: WorkbenchDeps, label: string, diff: (line: string) => void): Promise<number> {
  for (const path of routes) {
    const answer = async (deps: WorkbenchDeps): Promise<string> => {
      try {
        return responseText(await handleWorkbenchRequest({ method: 'GET', path }, deps));
      } catch (error) {
        return `threw ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    const [l, r] = [await answer(a), await answer(b)];
    if (l !== r) diff(`${label} GET ${path}: ${l.slice(0, 160)} ≠ ${r.slice(0, 160)}`);
  }
  return routes.length;
}

export async function runGate(options: GateOptions): Promise<GateReport> {
  const { tree, root } = options;
  const exploded = explode(tree);
  const checks: GateCheck[] = [];
  let routes: string[] = [];

  checks.push(
    await check('codec-identity', (diff) => {
      for (const error of exploded.errors) diff(error);
      if (exploded.errors.length > 0) return tree.size;
      const blobs = new Map(exploded.rows.blobs.flatMap((b) => (b.bytes === undefined ? [] : [[b.sha256, b.bytes] as const])));
      return compareTrees(tree, render(exploded.rows, { blobs: (sha) => blobs.get(sha) }), diff, { binaries: 'compare' });
    }),
  );

  const snapshot = await options.pg.cache.get();
  const pgBlobs = options.pg.blobs;
  checks.push(
    await check('export-identity', async (diff) => {
      const blobs = new Map<string, Uint8Array>();
      if (pgBlobs !== undefined) {
        for (const b of snapshot.rows.blobs) {
          const bytes = await pgBlobs.get(blobObjectKey(options.pg.cache.orgId, b.sha256));
          if (bytes !== undefined) blobs.set(b.sha256, new Uint8Array(bytes));
        }
      }
      const exported = render(snapshot.rows, { blobs: (sha) => blobs.get(sha) });
      return compareTrees(tree, exported, diff, { binaries: 'compare' });
    }),
  );

  checks.push(
    await check('sql-etags', async (diff) => {
      type Row = { k: string; body: string; etag: string; json: boolean };
      return inOrg(options.pg.db, options.pg.cache.orgId, async (tx) => {
        let n = 0;
        const tables = [
          sql<Row>`SELECT e.kind || '/' || e.slug || '#' || r.collection AS k, r.body::text AS body, r.etag, true AS json FROM studio.record r JOIN studio.entity e ON e.id = r.entity_id`,
          sql<Row>`SELECT 'revision/' || design_id || '/' || rev AS k, body::text AS body, etag, true AS json FROM studio.design_revision`,
          sql<Row>`SELECT 'working/' || design_id AS k, body::text AS body, etag, true AS json FROM studio.design_working`,
          sql<Row>`SELECT 'draft/' || design_id || '/' || n AS k, body::text AS body, etag, true AS json FROM studio.design_draft`,
          sql<Row>`SELECT 'model-link/' || record_key AS k, body::text AS body, etag, true AS json FROM studio.model_link`,
          sql<Row>`SELECT 'doc/' || path AS k, body, etag, media_type = 'application/json' AS json FROM studio.catalog_doc`,
        ];
        for (const query of tables) {
          for (const row of (await query.execute(tx)).rows) {
            n += 1;
            // JSON: contentETag(value) = sha256(JSON.stringify(value)); a text doc: the sha256 of its text
            const want = row.json ? contentETag(JSON.parse(row.body)) : `"${sha256Hex(row.body).slice(0, 32)}"`;
            if (row.etag !== want) diff(`${row.k}: database etag ${row.etag} ≠ contentETag ${want}`);
          }
        }
        return n;
      });
    }),
  );

  const fileCatalog = createCatalog(memoryCatalogSource(dataFileMap(tree as ReadonlyMap<string, string | Uint8Array>), { name: 'the file catalog' }));
  const pgCatalog = snapshot.catalog;
  const fileDb = fileCatalog.loadDb();
  const pgDb = pgCatalog.loadDb();
  const designIds = fileCatalog.listDesignIds();
  // designs and documents read with the design library, so sub-assemblies are checked and flattened alike
  const fileLib = withAssemblies(fileDb, { working: fileCatalog.loadDesigns() });
  const pgLib = withAssemblies(pgDb, { working: pgCatalog.loadDesigns() });

  checks.push(
    await check('validation', (diff) => {
      if (JSON.stringify(fileDb) !== JSON.stringify(pgDb)) diff('loadDb() differs');
      if (JSON.stringify(validateDb(fileDb)) !== JSON.stringify(validateDb(pgDb))) diff('validateDb issues differ');
      if (JSON.stringify(designIds) !== JSON.stringify(pgCatalog.listDesignIds())) diff('design ids differ');
      for (const id of designIds) {
        const a = validateDesign(fileCatalog.loadDesign(id), fileLib);
        const b = validateDesign(pgCatalog.loadDesign(id), pgLib);
        if (JSON.stringify(a) !== JSON.stringify(b)) diff(`validateDesign(${id}) differs`);
      }
      return designIds.length + 2;
    }),
  );

  checks.push(
    await check('documents', (diff) => {
      for (const id of designIds) {
        const [fd, pd] = [fileCatalog.loadDesign(id), pgCatalog.loadDesign(id)];
        const views: [string, () => string, () => string][] = [
          ['schematic', () => renderSchematic(fd, fileLib, { depictions: false }), () => renderSchematic(pd, pgLib, { depictions: false })],
          ['build sheet', () => renderBuildSheet(fd, fileLib, { depictions: false }), () => renderBuildSheet(pd, pgLib, { depictions: false })],
          ['BOM', () => bomToMarkdown(deriveBom(fd, fileLib)), () => bomToMarkdown(deriveBom(pd, pgLib))],
          ['continuity spec', () => testSpecToMarkdown(deriveTestSpec(fd, fileLib)), () => testSpecToMarkdown(deriveTestSpec(pd, pgLib))],
        ];
        for (const [name, a, b] of views) if (a() !== b()) diff(`${name} of ${id} differs`);
      }
      return designIds.length * 4;
    }),
  );

  checks.push(
    await check('refs-vs-usage', (diff) => {
      const edges: SourcedEdge[] = snapshot.rows.records.flatMap((r) =>
        referencesOf(r.kind, r.collection, JSON.parse(r.body)).map((e) => ({ ...e, fromKind: r.kind, fromSlug: r.slug })),
      );
      const designs = pgCatalog.loadDesigns();
      let n = 0;
      for (const kind of DEFINITION_KINDS) {
        const records = (pgCatalog.readJsonFile<{ id: string }[]>(`${kind}.json`) ?? []).map((r) => r.id);
        for (const id of records) {
          n += 1;
          const model = definitionUsage(pgDb, designs, kind as UsageKind, id);
          const want = { designs: [...new Set(model.designs.map((d) => d.id))].sort(), definitions: [...new Set(model.definitions)].sort() };
          const got = usageFromEdges(edges, kind, id);
          if (JSON.stringify(want) !== JSON.stringify(got)) diff(`${kind}/${id}: model ${JSON.stringify(want)} ≠ edges ${JSON.stringify(got)}`);
        }
      }
      // a design placed as a sub-assembly: the designs that place it
      for (const id of designIds) {
        n += 1;
        const want = subassemblyParents(designs, id).map((p) => p.id);
        const got = [...new Set(edges.filter((e) => e.toKind === 'design' && e.toSlug === id && e.role === 'subassembly').map((e) => e.fromSlug))].sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) diff(`design/${id}: placed by ${JSON.stringify(want)} ≠ edges ${JSON.stringify(got)}`);
      }
      return n;
    }),
  );

  routes = gateRoutes(fileCatalog, exploded.rows).sort(codePointCompare);
  const pgDeps = pgWorkbenchDeps({ cache: options.pg.cache, ...(pgBlobs === undefined ? {} : { blobs: pgBlobs }) });
  const dirSnapshot = directorySnapshot(root, exploded.rows, tree);
  const dirDeps = pgWorkbenchDeps({ cache: { orgId: 'files', get: async () => dirSnapshot, version: async () => 'files' }, blobs: treeBlobStore(tree, 'files') });
  checks.push(await check('api-parity', (diff) => apiParity(routes, dirDeps, pgDeps, 'directory vs pg', diff)));
  if (options.filesDeps !== undefined) {
    const filesDeps = options.filesDeps;
    checks.push(await check('api-parity-file-stores', (diff) => apiParity(routes, filesDeps, pgDeps, 'file stores vs pg', diff)));
  }

  if (options.models !== undefined) {
    const fileCache = options.models.fileCache;
    checks.push(
      await check('derived-blobs', async (diff) => {
        const links = liveModelLinks(snapshot.files.get('data/models.json') === undefined ? [] : (JSON.parse(snapshot.files.get('data/models.json') as string) as { links: ModelLink[] }).links);
        const pgCache = pgModelCache(options.pg.db, options.pg.cache.orgId, pgBlobs);
        for (const link of links) {
          const built = await pgCache.get(link.asset);
          if (built === undefined) {
            diff(`${link.record}: live model key ${link.asset} is not built`);
            continue;
          }
          const theirs = await fileCache?.get(link.asset);
          if (theirs !== undefined && sha256Hex(new Uint8Array(theirs)) !== sha256Hex(new Uint8Array(built))) diff(`${link.record}: key ${link.asset} built to different bytes on files and pg`);
        }
        return links.length;
      }),
    );
  }

  return { ok: checks.every((c) => c.diffs.length === 0), checks, routes };
}

/** One line per check, for a terminal or a commit message. */
export function formatGateReport(report: GateReport): string {
  const lines = report.checks.map((c) => `${c.diffs.length === 0 ? 'ok  ' : 'FAIL'} ${c.name.padEnd(24)} ${String(c.compared).padStart(6)} compared, ${c.diffs.length} diff(s), ${c.ms} ms`);
  for (const c of report.checks) for (const d of c.diffs) lines.push(`     ${c.name}: ${d}`);
  lines.push(report.ok ? 'S1 gate: green' : 'S1 gate: RED');
  return lines.join('\n');
}
