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
 */

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
