/**
 * Where the code-module host reads from, per backend: the install record and
 * the owners' settings document through the workbench deps (both backends
 * answer them), and the code itself from the pack layer on disk (files) or the
 * blob store by sha256 (Postgres: the files are catalog files there).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installedPackDir, type InstalledPack } from '@wirehub/catalog';

import type { WorkbenchDeps } from '../api.ts';
import type { CodeModuleSource } from './host.ts';
import { CODE_MODULES_DOC, readSettingsFile, settingsOf } from './state.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface SourceOptions {
  /** the file backend: the catalog's data directory and the packs directory the layers are in */
  files?: { dataDir: string; packsDir?: string };
}

/** A source over the workbench deps (`installedPacks`, `docs`, and `blob` or the directories). */
export function depsCodeModuleSource(deps: () => WorkbenchDeps | undefined, options: SourceOptions = {}): CodeModuleSource {
  return {
    async state() {
      const current = deps();
      if (current === undefined) return { packs: [], settings: settingsOf(undefined) };
      const packs = ((await current.installedPacks?.())?.packs ?? []) as InstalledPack[];
      // the owners' document: the catalog directory on files, the catalog's documents on Postgres
      const dataDir = options.files?.dataDir ?? (current.setup?.transact === undefined ? current.setup?.dataDir : undefined);
      const settings = dataDir !== undefined && dataDir !== '' ? readSettingsFile(dataDir) : settingsOf(await current.docs?.read(CODE_MODULES_DOC));
      return { packs, settings };
    },
    async migrations(id, files) {
      const check = deps()?.moduleMigrationStatus;
      if (check === undefined) throw new Error('This module needs SQL migrations and requires the Postgres backend.');
      return check(id, files);
    },
    async bytes(pack, relative, sha) {
      if (options.files !== undefined) {
        const { dataDir, packsDir } = options.files;
        const candidates = [...(packsDir === undefined ? [] : [join(installedPackDir(packsDir, pack.id), relative)]), join(dataDir, relative)];
        for (const path of candidates) {
          if (!existsSync(path)) continue;
          const bytes = new Uint8Array(readFileSync(path));
          if (sha256(bytes) === sha) return bytes;
        }
        return undefined;
      }
      const found = await deps()?.blob?.(sha);
      return found?.bytes;
    },
  };
}
