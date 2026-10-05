/**
 * Jobs on the file backend (Postgres plan Phase C): a module import runs as
 * a job in this process and publishes as one change set; a stale plan is
 * refused; the model-cache sweep rebuilds imported models from their
 * sources; a STEP upload converts through the `convert` job exactly as it
 * does in process. The real file stores, over a temporary copy of the
 * starter catalog (`WIREHUB_CATALOG_DIR`, set before the modules load).
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'wirehub-jobs-'));
cpSync(fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url)), join(work, 'data'), { recursive: true });
process.env.WIREHUB_CATALOG_DIR = join(work, 'data');
afterAll(() => {
  delete process.env.WIREHUB_CATALOG_DIR;
  rmSync(work, { recursive: true, force: true });
});

const fixtures = fileURLToPath(new URL('./fixtures/models/', import.meta.url));
const TETRA = new Uint8Array(readFileSync(join(fixtures, 'tetra.stl')));
const CUBE_STEP = new Uint8Array(readFileSync(join(fixtures, 'cube-colours.stp')));

describe('the import job on the file backend', () => {
  it('runs in process, plans, publishes once as one change set, and the catalog says what the importer proposed', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { exampleRegistry } = await import('./fixtures/example-importer.ts');
    const { importScenario } = await import('./jobs-scenario.ts');
    const deps = defaultWorkbenchDeps({ modules: exampleRegistry });
    // the service closes over the deps it was made with: give it these
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../server/jobs/handlers.ts');
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import', 'model-cache'] });
    const { log, exported } = await importScenario(deps);
    expect(log).toEqual([
      'start: 202 queued',
      'run: done',
      'job: 200 done by Importer Person',
      'result: proposed 2, changes 1, requests ["POST /api/definitions/mechanicals"], notes ["2 part(s) read from example.parts.csv"]',
      'proposal: {"definitions":{"mechanicals":[{"id":"hd15-backshell-test","label":"HD-15 backshell (imported)"}]},"designs":[],"existing":["mechanicals/de9-backshell"],"existingDesigns":[],"notes":["2 part(s) read from example.parts.csv"]}',
      expect.stringMatching(/^plan: changed data\/mechanicals\.json \d+$/),
      'publish: 200 applied 1',
      'publish again: 409',
      expect.stringContaining('de9-backshell=DE-9 metal backshell with strain relief'),
    ]);
    expect(log[8]).toContain('hd15-backshell-test=HD-15 backshell (imported)');
    const mechanicals = JSON.parse(readFileSync(join(work, 'data', 'mechanicals.json'), 'utf8')) as { id: string }[];
    expect(mechanicals.map((m) => m.id).at(-1)).toBe('hd15-backshell-test');
    expect(exported.files['data/mechanicals.json']).toBe(readFileSync(join(work, 'data', 'mechanicals.json'), 'utf8'));
  }, 60_000);

  it('refuses a plan whose records moved since the run (409, nothing written), and an importer that does not take the file', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { exampleRegistry, exampleBody, EXAMPLE_IMPORT_PATH } = await import('./fixtures/example-importer.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../server/jobs/handlers.ts');
    const deps = defaultWorkbenchDeps({ modules: exampleRegistry });
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'] });

    const csv = 'mod-backshell-x,Another backshell,SHL-00091,shell';
    const started = await handleWorkbenchRequest({ method: 'POST', path: EXAMPLE_IMPORT_PATH, body: exampleBody(csv) }, deps);
    const id = (started.body as { job: { id: string } }).job.id;
    expect((await deps.jobs.wait(id, 30_000)).status).toBe('done');
    // someone edits the list the plan adds to
    const before = readFileSync(join(work, 'data', 'mechanicals.json'), 'utf8');
    const current = (JSON.parse(before) as { id: string; label: string }[]).find((m) => m.id === 'de9-backshell')!;
    const { contentETag } = await import('../server/etag.ts');
    const edit = await handleWorkbenchRequest({ method: 'PUT', path: '/api/definitions/mechanicals/de9-backshell', body: { ...current, label: 'Edited meanwhile' }, headers: { 'if-match': contentETag(current) } }, deps);
    expect(edit.status).toBe(200);
    const edited = readFileSync(join(work, 'data', 'mechanicals.json'), 'utf8');
    const publish = await handleWorkbenchRequest({ method: 'POST', path: `/api/jobs/${id}/publish` }, deps);
    expect(publish.status).toBe(409);
    expect((publish.body as { error: string }).error).toContain('changed since the import ran');
    expect(readFileSync(join(work, 'data', 'mechanicals.json'), 'utf8')).toBe(edited);

    const wrong = await handleWorkbenchRequest({ method: 'POST', path: EXAMPLE_IMPORT_PATH, body: { fileName: 'x.txt', base64: 'eA==', job: true } }, deps);
    expect(wrong.status).toBe(400);
    const unknown = await handleWorkbenchRequest({ method: 'POST', path: '/api/modules/example-parts/_import/nope', body: exampleBody() }, deps);
    expect(unknown.status).toBe(404);
    // without `job`, the same route still previews in the request (module-io.ts)
    const preview = await handleWorkbenchRequest({ method: 'POST', path: EXAMPLE_IMPORT_PATH, body: { ...exampleBody(), job: undefined } }, deps);
    expect(preview.status).toBe(200);
    expect((preview.body as { accepted: boolean }).accepted).toBe(false);
  }, 60_000);

  it('fails the job, with the route\'s words, when a proposed record is refused', async () => {
    const { defaultWorkbenchDeps } = await import('../server/default-deps.ts');
    const { handleWorkbenchRequest } = await import('../server/api.ts');
    const { exampleRegistry, exampleBody, EXAMPLE_IMPORT_PATH } = await import('./fixtures/example-importer.ts');
    const deps = defaultWorkbenchDeps({ modules: exampleRegistry });
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { baseJobHandlers } = await import('../server/jobs/handlers.ts');
    const store = memoryJobStore();
    deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'] });
    // an id the library already uses for a connector: refused like a person's POST
    const started = await handleWorkbenchRequest({ method: 'POST', path: EXAMPLE_IMPORT_PATH, body: exampleBody('Bad Id,Label,SHL-00092,shell') }, deps);
    const job = await deps.jobs.wait((started.body as { job: { id: string } }).job.id, 30_000);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/1 of 1 proposed record\(s\) were refused; the first, POST \/api\/definitions\/mechanicals:/);
  }, 60_000);
});

describe('the model-cache job', () => {
  it('builds every live key from its sources, once, and says why it could not build the others', async () => {
    const { runModelCacheJob, liveModelLinks, parseWindow, inWindow } = await import('../server/jobs/model-cache.ts');
    const { memoryModelCache, sourceKey, sha256Hex } = await import('../server/models/cache.ts');
    const { memoryModelLinkStore } = await import('../server/models/links.ts');
    const { folderSources } = await import('../server/models/build.ts');
    const { MAX_MODEL_TRIANGLES } = await import('../server/models/finish.ts');
    const sources = join(work, 'sources');
    mkdirSync(join(sources, 'housings'), { recursive: true });
    writeFileSync(join(sources, 'housings', 'tetra.stl'), TETRA);
    const files = [{ path: 'housings/tetra.stl', sha256: sha256Hex(TETRA) }];
    const key = sourceKey(files, MAX_MODEL_TRIANGLES);
    const missing = [{ path: 'housings/gone.stl', sha256: 'a'.repeat(64) }];
    const changed = [{ path: 'housings/tetra.stl', sha256: 'b'.repeat(64) }];
    const links = memoryModelLinkStore([
      { record: 'mechanicals/de9-backshell', asset: key, files, sourceKind: 'resin-print', src: 'synthetic example' },
      // a second record showing the same model: one build
      { record: 'mechanicals/hd15-backshell', asset: key, files, sourceKind: 'resin-print', src: 'synthetic example' },
      { record: 'connectors/de9-male', asset: sourceKey(missing, MAX_MODEL_TRIANGLES), files: missing, sourceKind: 'vendor', src: 'synthetic example' },
      { record: 'connectors/de9-female', asset: sourceKey(changed, MAX_MODEL_TRIANGLES), files: changed, sourceKind: 'vendor', src: 'synthetic example' },
      // keyed by another converter version: stale
      { record: 'connectors/hd15-male', asset: 'c'.repeat(64), files, sourceKind: 'vendor', src: 'synthetic example' },
      // an upload: not a live key
      { record: 'components/r-150', asset: 'd'.repeat(64), sourceKind: 'uploaded', src: 'synthetic example' },
    ]);
    expect(liveModelLinks(await links.list()).length).toBe(4);
    const cache = memoryModelCache();
    const job = { id: 'j1', kind: 'model-cache' as const, status: 'running' as const, request: { reason: 'boot' }, steps: [], createdAt: '' };
    const deps = { modelLinks: links, modelCache: cache } as never;
    const outcome = await runModelCacheJob({ job, step: async () => {} }, { deps, sources: folderSources(sources) });
    expect(outcome.result['live']).toBe(4);
    expect((outcome.result['built'] as { key: string }[]).map((b) => b.key)).toEqual([key]);
    const failed = outcome.result['failed'] as { record: string; error: string }[];
    expect(failed.map((f) => f.record).sort()).toEqual(['connectors/de9-female', 'connectors/de9-male', 'connectors/hd15-male']);
    expect(failed.find((f) => f.record === 'connectors/de9-male')!.error).toContain('not readable here');
    expect(failed.find((f) => f.record === 'connectors/de9-female')!.error).toContain('has changed since');
    expect(failed.find((f) => f.record === 'connectors/hd15-male')!.error).toContain('another converter version');
    expect(cache.files.has(key)).toBe(true);
    // a second sweep builds nothing: the key is there
    const again = await runModelCacheJob({ job, step: async () => {} }, { deps, sources: folderSources(sources) });
    expect(again.result['built']).toEqual([]);
    expect(again.result['present']).toBe(1);
    // the night window
    const window = parseWindow('22:00-06:00');
    expect(inWindow(window, new Date(2026, 0, 1, 23, 0))).toBe(true);
    expect(inWindow(window, new Date(2026, 0, 1, 12, 0))).toBe(false);
    expect(parseWindow('nonsense')).toBeUndefined();
    cache.files.clear();
    const deferred = await runModelCacheJob({ job, step: async () => {} }, { deps, sources: folderSources(sources), window: window!, now: () => new Date(2026, 0, 1, 12, 0) });
    expect(deferred.result['built']).toEqual([]);
    expect(deferred.result['deferred']).toContain(key);
    expect((deferred.result['deferred'] as string[]).length).toBe(4);
  }, 60_000);

  it('is queued by a commit that adds an imported link, once per burst', async () => {
    const { modelCacheTrigger } = await import('../server/jobs/model-cache.ts');
    const queued: string[] = [];
    const jobs = { kinds: ['model-cache'], enqueue: async (kind: string) => void queued.push(kind) } as never;
    const trigger = modelCacheTrigger(() => jobs, 10);
    const link = { record: 'mechanicals/x', asset: 'a'.repeat(64), files: [], sourceKind: 'vendor', src: 's' };
    trigger({ changes: [{ kind: 'model-link', key: 'mechanicals/x', op: 'put', value: link }], context: { method: 'PUT', path: '/api/models/mechanicals/x' } });
    trigger({ changes: [{ kind: 'model-link', key: 'mechanicals/x', op: 'put', value: link }], context: { method: 'PUT', path: '/api/models/mechanicals/x' } });
    // an upload's link (no files) and other records queue nothing
    trigger({ changes: [{ kind: 'model-link', key: 'mechanicals/y', op: 'put', value: { ...link, files: undefined } }], context: { method: 'PUT', path: '/' } });
    trigger({ changes: [{ kind: 'design', key: 'd', op: 'put', value: {} }], context: { method: 'PUT', path: '/' } });
    await new Promise((done) => setTimeout(done, 50));
    expect(queued).toEqual(['model-cache']);
  });
});

describe('the convert job', () => {
  it('converts a STEP upload through the job exactly as in process, deterministically, and answers a refusal in the same words', async () => {
    const { fsBlobStore } = await import('../server/blobs.ts');
    const { createJobService, inlineJobRunner, memoryJobStore } = await import('../server/jobs/service.ts');
    const { runConvertJob, remoteConvert } = await import('../server/jobs/convert.ts');
    const { convertModel, ModelRefusal } = await import('../server/models/convert.ts');
    const { sha256Hex } = await import('../server/models/cache.ts');
    const blobs = fsBlobStore(join(work, 'blobs'));
    const orgId = '00000000-0000-7000-8000-000000000001';
    const store = memoryJobStore();
    const jobs = createJobService({ store, runner: inlineJobRunner(store, () => ({ convert: (context) => runConvertJob(context, { blobs, orgId }) })), kinds: ['convert'], pollMs: 20 });
    const convert = remoteConvert({ jobs, blobs, orgId: () => orgId });
    const viaJob = await convert(CUBE_STEP, 'cube.step');
    const local = await convertModel(CUBE_STEP, 'cube.step');
    expect(viaJob.format).toBe('step');
    expect(sha256Hex(viaJob.glb)).toBe(sha256Hex(local.glb));
    expect(viaJob.stats.triangles).toBe(local.stats.triangles);
    // the determinism check (§5.5): the same input twice, the same bytes
    expect(sha256Hex((await convert(CUBE_STEP, 'cube.step')).glb)).toBe(sha256Hex(viaJob.glb));
    // the job leaves nothing behind in the blob store
    expect(await blobs.list!(`${orgId}/jobs/`)).toEqual([]);
    expect((await jobs.list({ kind: 'convert' })).every((j) => j.status === 'done')).toBe(true);
    // STL and GLB stay in process: no job
    await convert(TETRA, 'tetra.stl');
    expect((await jobs.list({ kind: 'convert' })).length).toBe(2);
    // a STEP the converter refuses: the same words as in process
    const broken = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
    const viaJobError = await convert(broken, 'broken.step').catch((e: unknown) => e);
    const localError = await convertModel(broken, 'broken.step').catch((e: unknown) => e);
    expect(viaJobError).toBeInstanceOf(ModelRefusal);
    expect((viaJobError as Error).message).toBe((localError as Error).message);
  }, 120_000);
});
