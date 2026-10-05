/**
 * The server's own environment variables, read in one place.
 *
 * Every variable WireHub defines is named `WIREHUB_<NAME>`. Hubs set up before
 * the rename used `STUDIO_<NAME>`; those names are still read, as a
 * deprecated fallback, when the `WIREHUB_` one is unset. `serve.ts` logs one
 * warning at startup naming every legacy variable in use
 * (`legacyEnvWarning`).
 *
 * Standard names (`HOST`, `PORT`, `AUTH_ENABLED`, `S3_*` …) are not prefixed
 * and are read directly.
 *
 * Any variable can also come from a file, `NAME_FILE` (`resolveFileEnv`,
 * below), which the hosts apply once at startup (`prepareHostEnv`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Env = Readonly<Record<string, string | undefined>>;

/** The names, without prefix, that once had a `STUDIO_` form. */
export const WIREHUB_ENV_NAMES = [
  'BLOBS',
  'LOCAL_USER',
  'GIT_AUTOCOMMIT',
  'GIT_DIR',
  'GIT_REMOTE',
  'GIT_BRANCH',
  'MODEL_CACHE_DIR',
  'TEST_S3_URL',
] as const;

export type WireHubEnvName = (typeof WIREHUB_ENV_NAMES)[number];

/**
 * `WIREHUB_<name>`, else the deprecated `STUDIO_<name>`, else `undefined`.
 * An empty `WIREHUB_` value counts as set (it is how a host switches a
 * setting off), so it never falls through to the legacy name.
 */
export function envVar(name: WireHubEnvName, env: Env = process.env): string | undefined {
  return env[`WIREHUB_${name}`] ?? env[`STUDIO_${name}`];
}

/** The legacy `STUDIO_` variables that are set and actually read (their `WIREHUB_` form is unset). */
export function legacyEnvNames(env: Env = process.env): string[] {
  return WIREHUB_ENV_NAMES.filter((name) => env[`WIREHUB_${name}`] === undefined && env[`STUDIO_${name}`] !== undefined).map(
    (name) => `STUDIO_${name}`,
  );
}

/** One sentence naming every legacy variable in use, or `undefined` when there is none. */
export function legacyEnvWarning(env: Env = process.env): string | undefined {
  const legacy = legacyEnvNames(env);
  if (legacy.length === 0) return undefined;
  const renames = legacy.map((name) => `${name} → ${name.replace(/^STUDIO_/, 'WIREHUB_')}`).join(', ');
  return `Deprecated environment variable${legacy.length === 1 ? '' : 's'} in use; rename ${renames}. The STUDIO_ names will stop working in a future release.`;
}

/* ------------------------------------------------------------------ *
 * `NAME_FILE`: any variable read from a file
 * ------------------------------------------------------------------ */

const FILE_SUFFIX = /^([A-Z][A-Z0-9_]*)_FILE$/;

/** What `resolveFileEnv` did. */
export interface FileEnvResult {
  /** the variables now set from a file */
  loaded: string[];
  /** `NAME_FILE` ignored because `NAME` itself is set (the explicit value wins) */
  shadowed: string[];
  /** one sentence per file that could not be read */
  errors: string[];
}

/**
 * Every variable may be given as a file: `NAME_FILE=/path` sets `NAME` to the
 * file's contents (one trailing newline dropped), the Docker-secrets
 * convention. The compose stack hands the app its generated secrets this way
 * (`S3_SECRET_ACCESS_KEY_FILE`, `BETTER_AUTH_SECRET_FILE`, `DATABASE_URL_FILE`,
 * `WIREHUB_SETUP_CODE_FILE` …), and a deployer can point any of them at their
 * own secret files.
 *
 * - `NAME` set to a non-empty value wins over `NAME_FILE` (an explicit
 *   setting always beats a generated one); an **empty** `NAME` counts as
 *   unset here, so an `.env` line left blank does not hide the file.
 * - A `NAME_FILE` that cannot be read is an error, never silently skipped.
 *
 * Mutates `env` (normally `process.env`) once, at startup, before anything
 * reads it — so every reader, present or future, sees the resolved value.
 */
export function resolveFileEnv(env: Record<string, string | undefined>, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): FileEnvResult {
  const result: FileEnvResult = { loaded: [], shadowed: [], errors: [] };
  for (const key of Object.keys(env).sort()) {
    const match = FILE_SUFFIX.exec(key);
    const path = env[key];
    if (match === null || path === undefined || path === '') continue;
    const name = match[1] as string;
    const current = env[name];
    if (current !== undefined && current !== '') {
      result.shadowed.push(key);
      continue;
    }
    try {
      env[name] = read(path).replace(/\r?\n$/, '');
      result.loaded.push(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.errors.push(`${key}: cannot read ${path} (${reason}).`);
    }
  }
  return result;
}

/** The checkout's `data/packs/` (gitignored): where a source checkout keeps installed packs. */
export function checkoutPacksDir(): string {
  return fileURLToPath(new URL('../../../data/packs', import.meta.url));
}

/**
 * Everything a host does to its environment before it builds anything:
 * resolve `*_FILE` variables, and give `WIREHUB_PACKS_DIR` its default (a
 * checkout's `data/packs/`; the image sets `/data/packs`), so packs installed
 * at first-run setup never land in the starter catalog. Returns what
 * `resolveFileEnv` did; the caller reports errors and stops.
 */
export function prepareHostEnv(env: Record<string, string | undefined> = process.env): FileEnvResult {
  const result = resolveFileEnv(env);
  if (env['WIREHUB_PACKS_DIR'] === undefined || env['WIREHUB_PACKS_DIR'] === '') env['WIREHUB_PACKS_DIR'] = checkoutPacksDir();
  return result;
}
