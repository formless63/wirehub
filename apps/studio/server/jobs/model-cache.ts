/**
 * The `model-cache` job (`specs/postgres-backend.md` §5.5; task C6): build
 * every **live** model key that is not built yet. A live key is the `asset`
 * of an imported model link (one with `files`); the build goes into the
 * deployment's model cache — derived blobs on Postgres, the gitignored
 * `.model-cache/` on files — under that key, so the two backends compare
 * directly.
 *
 * Triggers: a commit that adds or changes an imported link (`afterCommit`),
 * the worker's boot (after a restore the cache is empty: the boot sweep
 * rebuilds it), and `POST /api/jobs`. One conversion at a time (the
 * conversion queue in `convert.ts`); `WIREHUB_CONVERT_WINDOW=HH:MM-HH:MM`
 * confines builds to a night window on a small machine.
 */

import type { WorkbenchDeps } from '../api.ts';
import { buildLinkedModel, chainSources, folderSources, type Converter, type SourceReader } from '../models/build.ts';
import type { ModelCache } from '../models/cache.ts';
import { ModelRefusal } from '../models/convert.ts';
import type { ModelLink } from '../models/links.ts';
import type { ChangeSet } from '../storage/change-set.ts';
import type { JobContext, JobOutcome, JobService } from './types.ts';

/** `HH:MM-HH:MM` → minutes since midnight; undefined when unset or unreadable. */
export function parseWindow(value: string | undefined): { from: number; to: number } | undefined {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? '');
  if (m === null) return undefined;
  const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return undefined;
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 };
}

/** Is `at` inside the window (which may wrap past midnight)? */
export function inWindow(window: { from: number; to: number } | undefined, at: Date): boolean {
  if (window === undefined) return true;
  const minute = at.getHours() * 60 + at.getMinutes();
  return window.from <= window.to ? minute >= window.from && minute < window.to : minute >= window.from || minute < window.to;
}

/** One link per live key: the keys a sweep must have built. */
export function liveModelLinks(links: readonly ModelLink[]): ModelLink[] {
  const seen = new Set<string>();
  const out: ModelLink[] = [];
  for (const link of links) {
    if (link.files === undefined || seen.has(link.asset)) continue;
    seen.add(link.asset);
    out.push(link);
  }
  return out;
}

export interface ModelCacheJobOptions {
  deps: WorkbenchDeps;
  /** where source files are read: the mounted sources, then the catalog's own art */
  sources?: SourceReader;
  window?: { from: number; to: number };
  now?: () => Date;
  convert?: Converter;
  /** a cache write with the build's provenance (pg: `derived_blob.inputs`, `triangles`, `job_id`) */
  put?: (key: string, glb: Uint8Array, meta: { triangles: number; inputs: unknown; jobId: string }) => Promise<void>;
}

/** The catalog's depiction art as a source (`depictions/<id>/board-top.svg`): text files of the catalog itself. */
export function catalogArtSources(deps: WorkbenchDeps): SourceReader {
  let files: Record<string, string> | undefined;
  return async (path) => {
    if (!path.startsWith('depictions/')) return undefined;
    files ??= (await deps.exportCatalog?.())?.files ?? {};
    const text = files[path];
    return text === undefined ? undefined : new TextEncoder().encode(text);
  };
}

/** The sources a deployment has: `WIREHUB_MODEL_SOURCES` (a folder), then the catalog's art. */
export function sourcesFromEnv(deps: WorkbenchDeps, env: Record<string, string | undefined> = process.env): SourceReader {
  const dir = (env.WIREHUB_MODEL_SOURCES ?? '').trim();
  return chainSources(dir === '' ? undefined : folderSources(dir), catalogArtSources(deps));
}

export async function runModelCacheJob(context: JobContext, options: ModelCacheJobOptions): Promise<JobOutcome> {
  const { deps } = options;
  const cache: ModelCache | undefined = deps.modelCache;
  if (cache === undefined || deps.modelLinks === undefined) return { result: { live: 0, built: [], skipped: 'this studio keeps no model cache' } };
  const live = liveModelLinks(await deps.modelLinks.list());
  const built: { key: string; record: string; triangles: number; ms: number; peakRssMb?: number }[] = [];
  const failed: { key: string; record: string; error: string; hint?: string }[] = [];
  const deferred: string[] = [];
  let present = 0;
  const sources = options.sources ?? sourcesFromEnv(deps);
  for (const link of live) {
    if (await cache.has(link.asset)) {
      present += 1;
      continue;
    }
    if (!inWindow(options.window, (options.now ?? (() => new Date()))())) {
      deferred.push(link.asset);
      continue;
    }
    await context.step(`building ${link.record} (${link.asset.slice(0, 12)}…)`);
    try {
      const out = await buildLinkedModel(link, sources, options.convert);
      if (options.put !== undefined) await options.put(out.key, out.glb, { triangles: out.converted.stats.triangles, inputs: out.inputs, jobId: context.job.id });
      else await cache.put(out.key, out.glb);
      built.push({
        key: out.key,
        record: link.record,
        triangles: out.converted.stats.triangles,
        ms: out.converted.stats.ms ?? 0,
        ...(out.converted.stats.peakRssMb === undefined ? {} : { peakRssMb: out.converted.stats.peakRssMb }),
      });
    } catch (error) {
      if (!(error instanceof ModelRefusal) && !(error instanceof Error)) throw error;
      failed.push({ key: link.asset, record: link.record, error: error.message, ...(error instanceof ModelRefusal ? { hint: error.hint } : {}) });
    }
  }
  return { result: { reason: context.job.request['reason'] ?? null, live: live.length, present, built, failed, deferred } };
}

/**
 * The commit hook: queue a sweep when a change set adds or changes an
 * imported model link (§5.5). Debounced per process so a batch of link
 * writes queues one sweep.
 */
export function modelCacheTrigger(jobs: () => JobService | undefined, debounceMs = 2000): (set: ChangeSet) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (set) => {
    const touches = set.changes.some((c) => c.kind === 'model-link' && c.op === 'put' && (c.value as ModelLink | undefined)?.files !== undefined);
    if (!touches) return;
    const service = jobs();
    if (service === undefined || !service.kinds.includes('model-cache')) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      service.enqueue('model-cache', { reason: 'commit' }).catch((error: unknown) => console.warn(`[jobs] could not queue a model build: ${error instanceof Error ? error.message : String(error)}`));
    }, debounceMs);
    timer.unref?.();
  };
}
