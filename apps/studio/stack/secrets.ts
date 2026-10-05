/**
 * The compose stack's secrets volume (`compose.yaml`, the `secrets` volume,
 * mounted at `/run/wirehub`): one file per secret, holding the value every
 * service uses. The one-shot services write it — `bootstrap` the passwords,
 * tokens and the setup code, `garage-init` the S3 keys Garage creates,
 * `backup-init` the restic password — and the long-running services read it
 * through `*_FILE` variables (`POSTGRES_PASSWORD_FILE`, `S3_SECRET_ACCESS_KEY_FILE`
 * …), so the default stack needs no `.env` at all.
 *
 * The rule for every secret (`ensureSecret`):
 *
 * 1. a value set explicitly (the deployer's `.env` or their Docker UI) is
 *    written to the file — an explicit setting always wins, and the file
 *    always holds what is in use;
 * 2. else an existing file is kept, never regenerated — a restart, an
 *    upgrade or a re-deploy changes nothing;
 * 3. else a fresh value is generated.
 *
 * Plain Node, no dependencies: these scripts run in the app image with
 * `node --experimental-strip-types` before the app starts.
 */

import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the secrets volume is mounted in every service. */
export const DEFAULT_SECRETS_DIR = '/run/wirehub';

/** The app image's user: files the one-shots write as root are handed to it, so later one-shots running as it can add theirs. */
export const APP_UID = 1000;
export const APP_GID = 1000;

export type Env = Readonly<Record<string, string | undefined>>;

/** `n` random bytes as hex. */
export function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** `n` random bytes as unpadded base64url. */
export function base64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** The setup code's alphabet (no 0/O, 1/I/L), the same as the app's (`server/setup.ts`). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A setup code, `XXXX-XXXX-XXXX`. */
export function setupCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((group) => group.join('')).join('-');
}

/** A value given in the environment: `NAME`, else the contents of `NAME_FILE`; blank counts as unset. */
export function explicitValue(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value !== undefined && value.trim() !== '') return value.trim();
  const file = env[`${name}_FILE`];
  if (file !== undefined && file !== '' && existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** The secrets directory in use: `WIREHUB_SECRETS_DIR`, else `/run/wirehub`. */
export function secretsDir(env: Env): string {
  return env['WIREHUB_SECRETS_DIR'] ?? DEFAULT_SECRETS_DIR;
}

/** A secret file's value, or `undefined` when it is missing or empty. */
export function readSecret(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').trim();
  return text === '' ? undefined : text;
}

/** Hand a path to the app user when running as root (best effort: a volume that refuses is left alone). */
function handOver(path: string): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  try {
    chownSync(path, APP_UID, APP_GID);
  } catch {
    // not ours to change; readers only need the mode below
  }
}

/** Create the secrets directory (readable by every service, writable by the app user). */
export function prepareDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  handOver(dir);
}

/**
 * Write a file atomically. Mode 0644: the services that read the volume run
 * as different users (Postgres as 999, the app as 1000, Garage as root), and
 * the volume is mounted only into this stack's containers.
 */
export function writeFile(dir: string, name: string, value: string): void {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, value.endsWith('\n') ? value : `${value}\n`, { mode: 0o644 });
  chmodSync(temp, 0o644);
  handOver(temp);
  renameSync(temp, path);
}

export type SecretSource = 'explicit' | 'kept' | 'generated';

/** One secret by the rule above; returns its value and where it came from. */
export function ensureSecret(dir: string, name: string, explicit: string | undefined, generate: () => string): { value: string; source: SecretSource } {
  const current = readSecret(dir, name);
  if (explicit !== undefined) {
    if (current !== explicit) writeFile(dir, name, explicit);
    return { value: explicit, source: 'explicit' };
  }
  if (current !== undefined) return { value: current, source: 'kept' };
  const value = generate();
  writeFile(dir, name, value);
  return { value, source: 'generated' };
}
