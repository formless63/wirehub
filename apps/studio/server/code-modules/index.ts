/**
 * Runtime code modules (`specs/runtime-modules.md`): one call that gives a
 * process the host over its workbench deps and keeps it following the catalog.
 */

import type { LiveModuleRegistry, WireHubModule } from '@wirehub/modules';

import type { WorkbenchDeps } from '../api.ts';
import { createCodeModuleHost, type CodeModuleHost } from './host.ts';
import { depsCodeModuleSource } from './sources.ts';

export interface AttachOptions {
  builtins: readonly WireHubModule[];
  live: LiveModuleRegistry;
  /** the file backend's directories (its code lives in the pack layers); absent: the blob store by sha256 */
  files?: { dataDir: string; packsDir?: string };
  env?: () => Readonly<Record<string, string | undefined>>;
  cacheDir?: string;
  log?: (line: string) => void;
  /** stand in for the import of an entry (`CodeModuleHostOptions.importModule`, tests) */
  importModule?: (url: string, bytes: Uint8Array) => Promise<Record<string, unknown>>;
  /** look again this often in case a notification was missed (ms; 0: never). Default 60 s. */
  pollMs?: number;
}

/**
 * Make `deps` load runtime code modules into `options.live` (which should be
 * `deps.modules`): `deps.codeModules` is set, and every catalog event (a commit
 * here on files, any process's NOTIFY on Postgres) syncs the set. Returns the
 * host and a stop function; the caller runs the first `sync()` (and
 * `markBooted()`) at a point of its choosing.
 */
export function attachCodeModules(deps: WorkbenchDeps, options: AttachOptions): { host: CodeModuleHost; stop: () => void } {
  const host = createCodeModuleHost({
    builtins: options.builtins,
    live: options.live,
    source: depsCodeModuleSource(() => deps, options.files === undefined ? {} : { files: options.files }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
  });
  deps.codeModules = host;
  const unsubscribe = deps.events?.subscribe((event) => {
    if (event.type === 'catalog') void host.sync();
  });
  const pollMs = options.pollMs ?? 60_000;
  const timer = pollMs > 0 ? setInterval(() => void host.sync(), pollMs) : undefined;
  timer?.unref?.();
  return {
    host,
    stop: () => {
      unsubscribe?.();
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

export type { CodeModuleHost, CodeModuleStatus } from './host.ts';
