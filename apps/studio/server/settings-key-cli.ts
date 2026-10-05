#!/usr/bin/env -S node --experimental-strip-types
/**
 * The settings key's commands (`docs/self-hosting.md` "Rotating the settings key"):
 *
 *   settings-key-cli.ts generate   print a new key (32 random bytes, base64url)
 *   settings-key-cli.ts status     how many stored secrets are under the current key, a previous one, or none
 *   settings-key-cli.ts rotate     re-encrypt every stored secret under the current key
 *
 * `status` and `rotate` read the same environment the server does — `WIREHUB_SETTINGS_KEY`
 * (the new key) and `WIREHUB_SETTINGS_KEY_PREVIOUS` or the secrets volume's `settings_key_previous`
 * (the old ones) — and the same store: the secrets file beside the sign-in data on the file backend,
 * `studio.settings_secret` on Postgres (`WIREHUB_BACKEND=pg`, `DATABASE_URL`, `WIREHUB_ORG`).
 * Run it where the server runs, with `--import ./server/boot-env.ts` so `*_FILE` variables resolve:
 *
 *   node --experimental-strip-types --import ./server/boot-env.ts server/settings-key-cli.ts rotate
 *
 * It is safe while the hub is running: each secret is swapped from its old ciphertext to the new
 * in one step, and a secret saved meanwhile is left as saved. Running it twice does nothing.
 */

import { pathToFileURL } from 'node:url';

import { fileSecretsPath } from './default-deps.ts';
import type { Env } from './env.ts';
import { fileSecretStore, generateSettingsKey, rotateSecrets, rotationStatus, settingsCipherFromEnv, type SecretStore, type SettingsCipher } from './settings-secrets.ts';

export class SettingsKeyCliError extends Error {}

/** The store and org the secrets are bound to, for the backend the environment names; `close` releases the connection. */
async function openStore(env: Env): Promise<{ store: SecretStore; org: string; close: () => Promise<void> }> {
  if ((env['WIREHUB_BACKEND'] ?? 'files').trim() !== 'pg') return { store: fileSecretStore(fileSecretsPath(env)), org: 'files', close: async () => {} };
  const { pgAppConfigFromEnv } = await import('./pg/config.ts');
  const { openPg, resolveOrgId } = await import('./pg/db.ts');
  const { pgSecretStore } = await import('./pg/settings-secrets.ts');
  const config = pgAppConfigFromEnv(env);
  const handle = openPg(config.url, { max: 2, applicationName: 'wirehub-settings-key' });
  const org = await resolveOrgId(handle.db, config.org);
  if (org === undefined) {
    await handle.close();
    throw new SettingsKeyCliError('This database has no organisation yet, so there are no secrets to rotate.');
  }
  return { store: pgSecretStore(handle.db, org), org, close: () => handle.close() };
}

function cipherOf(env: Env): SettingsCipher {
  const lines: string[] = [];
  const cipher = settingsCipherFromEnv(env, (line) => lines.push(line));
  if (cipher === undefined) throw new SettingsKeyCliError(lines[0] ?? 'There is no settings key: set WIREHUB_SETTINGS_KEY (or WIREHUB_SETTINGS_KEY_FILE).');
  return cipher;
}

/** Run `status` or `rotate` against the environment's store; returns the lines to print. */
export async function runSettingsKeyCommand(command: 'status' | 'rotate', env: Env): Promise<string[]> {
  const cipher = cipherOf(env);
  const { store, org, close } = await openStore(env);
  try {
    if (command === 'status') {
      const s = await rotationStatus(store, cipher, org);
      return [
        `${s.total} stored secret${s.total === 1 ? '' : 's'}: ${s.total - s.stale - s.unreadable} under the current key, ${s.stale} under a previous key, ${s.unreadable} that no key reads.`,
        `${cipher.previousKeys} previous key${cipher.previousKeys === 1 ? '' : 's'} configured.`,
      ];
    }
    const r = await rotateSecrets(store, cipher, org);
    const out = [`${r.rotated.length} re-encrypted under the current key, ${r.current} already under it.`];
    if (r.skipped.length > 0) out.push(`Changed while rotating, run again to check: ${r.skipped.join(', ')}.`);
    if (r.unreadable.length > 0) out.push(`No key reads these; enter them again in Settings: ${r.unreadable.join(', ')}.`);
    else if (r.skipped.length === 0) out.push(cipher.previousKeys > 0 ? 'Done: the previous key can now be removed from the server.' : 'Done.');
    return out;
  } finally {
    await close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command] = process.argv.slice(2);
  try {
    if (command === 'generate') console.log(generateSettingsKey());
    else if (command === 'status' || command === 'rotate') for (const line of await runSettingsKeyCommand(command, process.env)) console.log(line);
    else {
      console.error('usage: settings-key-cli.ts generate | status | rotate');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
