/**
 * The owner's choices about runtime code modules (`specs/runtime-modules.md`
 * §3): the catalog document `data/settings/code-modules.json`, written through
 * the same change-set path as the pack it sits beside, and the install-level
 * kill switch `WIREHUB_ALLOW_CODE_MODULES`.
 *
 * ```jsonc
 * { "src": "…", "allow": true,
 *   "modules": { "acme-erp": { "enabled": true, "by": "Ada", "on": "2026-10-05T…" } },
 *   "keys": [{ "key": "RW…", "label": "ACME", "by": "Ada", "on": "…" }] }
 * ```
 *
 * A module is enabled only when its entry says so: installing with consent
 * writes it, so a module nobody consented to never runs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileReplacing } from '@wirehub/catalog';
import { normalStoreKey } from '@wirehub/catalog/src/server.ts';

export const CODE_MODULES_DOC = 'data/settings/code-modules.json';
/** relative to the catalog's `data/` directory */
export const CODE_MODULES_FILE = 'settings/code-modules.json';

export interface PinnedKey {
  /** a minisign public key, `RW…` */
  key: string;
  label?: string;
  by?: string;
  on?: string;
}

export interface CodeModuleSettings {
  src: string;
  /** the Settings toggle (default on); the environment's `WIREHUB_ALLOW_CODE_MODULES=false` overrides it */
  allow?: boolean;
  modules: Record<string, { enabled: boolean; by?: string; on?: string }>;
  /** publisher keys an owner pinned, for uploads */
  keys: PinnedKey[];
}

const SRC = 'the code modules this hub runs and the publisher keys its owners trust for uploads (specs/runtime-modules.md)';

export const emptySettings = (): CodeModuleSettings => ({ src: SRC, modules: {}, keys: [] });

/** A stored document as settings, tolerant of a missing or partial one. */
export function settingsOf(value: unknown): CodeModuleSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptySettings();
  const v = value as Partial<CodeModuleSettings>;
  const modules: CodeModuleSettings['modules'] = {};
  for (const [id, entry] of Object.entries(v.modules ?? {})) {
    if (typeof entry === 'object' && entry !== null) modules[id] = { enabled: entry.enabled === true, ...(typeof entry.by === 'string' ? { by: entry.by } : {}), ...(typeof entry.on === 'string' ? { on: entry.on } : {}) };
  }
  const keys = (Array.isArray(v.keys) ? v.keys : []).filter((k): k is PinnedKey => typeof k === 'object' && k !== null && typeof (k as PinnedKey).key === 'string');
  return { src: typeof v.src === 'string' ? v.src : SRC, ...(typeof v.allow === 'boolean' ? { allow: v.allow } : {}), modules, keys };
}

/** The document in a catalog directory (`<dataDir>/settings/code-modules.json`). */
export function readSettingsFile(dataDir: string): CodeModuleSettings {
  const path = join(dataDir, CODE_MODULES_FILE);
  if (!existsSync(path)) return emptySettings();
  try {
    return settingsOf(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    return emptySettings();
  }
}

/** Change the document in a catalog directory (the file backend's own, or the database backend's scratch copy). */
export function updateSettingsFile(dataDir: string, change: (settings: CodeModuleSettings) => void): CodeModuleSettings {
  const settings = readSettingsFile(dataDir);
  change(settings);
  const ordered: CodeModuleSettings = {
    src: settings.src,
    ...(settings.allow === undefined ? {} : { allow: settings.allow }),
    modules: Object.fromEntries(Object.entries(settings.modules).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    keys: settings.keys,
  };
  writeFileReplacing(join(dataDir, CODE_MODULES_FILE), `${JSON.stringify(ordered, null, 2)}\n`);
  return ordered;
}

/** `WIREHUB_ALLOW_CODE_MODULES`: install-level, default true; `false`/`0`/`off`/`no` turns every runtime module off. */
export function codeModulesAllowedByEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = (env['WIREHUB_ALLOW_CODE_MODULES'] ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

/** Is `key` one the owners pinned? */
export function isPinned(settings: CodeModuleSettings, key: string): boolean {
  let wanted: string;
  try {
    wanted = normalStoreKey(key);
  } catch {
    return false;
  }
  return settings.keys.some((k) => {
    try {
      return normalStoreKey(k.key) === wanted;
    } catch {
      return false;
    }
  });
}
