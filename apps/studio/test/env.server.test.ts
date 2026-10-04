/**
 * The environment helper: `WIREHUB_*` names first, the pre-rename `STUDIO_*`
 * names as a deprecated fallback, and one warning naming every legacy
 * variable in use.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { studioBackupFromEnv } from '../server/backup/backup.ts';
import { blobStoreFromEnv } from '../server/blobs.ts';
import { checkoutPacksDir, envVar, legacyEnvNames, legacyEnvWarning, prepareHostEnv, resolveFileEnv } from '../server/env.ts';
import { localStudioUser } from '../server/me.ts';

const noGit = (): undefined => undefined;

describe('envVar', () => {
  it('reads the WIREHUB_ name', () => {
    expect(envVar('BLOBS', { WIREHUB_BLOBS: 's3' })).toBe('s3');
  });

  it('falls back to the STUDIO_ name when the WIREHUB_ one is unset', () => {
    expect(envVar('BLOBS', { STUDIO_BLOBS: 'fs:/tmp/x' })).toBe('fs:/tmp/x');
  });

  it('prefers the WIREHUB_ name when both are set, even when it is empty', () => {
    expect(envVar('LOCAL_USER', { WIREHUB_LOCAL_USER: 'New', STUDIO_LOCAL_USER: 'Old' })).toBe('New');
    expect(envVar('LOCAL_USER', { WIREHUB_LOCAL_USER: '', STUDIO_LOCAL_USER: 'Old' })).toBe('');
  });

  it('is undefined when neither is set', () => {
    expect(envVar('GIT_DIR', {})).toBeUndefined();
  });
});

describe('the legacy warning', () => {
  it('is silent when only WIREHUB_ names are used', () => {
    expect(legacyEnvNames({ WIREHUB_BLOBS: 's3', HOST: '0.0.0.0' })).toEqual([]);
    expect(legacyEnvWarning({ WIREHUB_BLOBS: 's3' })).toBeUndefined();
  });

  it('names every legacy variable that is actually read, in one sentence', () => {
    const env = { STUDIO_BLOBS: 's3', STUDIO_GIT_AUTOCOMMIT: 'true', STUDIO_LOCAL_USER: 'x', WIREHUB_LOCAL_USER: 'y' };
    expect(legacyEnvNames(env)).toEqual(['STUDIO_BLOBS', 'STUDIO_GIT_AUTOCOMMIT']);
    const warning = legacyEnvWarning(env)!;
    expect(warning).toContain('STUDIO_BLOBS → WIREHUB_BLOBS');
    expect(warning).toContain('STUDIO_GIT_AUTOCOMMIT → WIREHUB_GIT_AUTOCOMMIT');
    expect(warning).not.toContain('LOCAL_USER');
    expect(warning.split('\n')).toHaveLength(1);
  });
});

describe('the readers honour both names', () => {
  it('the blob store', () => {
    expect(blobStoreFromEnv({ STUDIO_BLOBS: 'fs:/tmp/legacy' })?.describe).toMatch(/^fs /);
    expect(blobStoreFromEnv({ WIREHUB_BLOBS: 'fs:/tmp/new' })?.describe).toMatch(/^fs /);
    expect(() => blobStoreFromEnv({ STUDIO_BLOBS: 'ftp' })).toThrow(/^WIREHUB_BLOBS must be/);
  });

  it('the local user', () => {
    expect(localStudioUser({ STUDIO_LOCAL_USER: 'Old bench' }, noGit).name).toBe('Old bench');
    expect(localStudioUser({ WIREHUB_LOCAL_USER: 'Bench', STUDIO_LOCAL_USER: 'Old bench' }, noGit).name).toBe('Bench');
  });

  it('the git export', () => {
    expect(studioBackupFromEnv({}, '/nowhere')).toBeUndefined();
    const legacy = studioBackupFromEnv({ STUDIO_GIT_AUTOCOMMIT: 'true', STUDIO_GIT_BRANCH: 'old' }, '/nowhere');
    expect(legacy?.status().branch).toBe('old');
    const renamed = studioBackupFromEnv({ WIREHUB_GIT_AUTOCOMMIT: 'true', WIREHUB_GIT_BRANCH: 'main', STUDIO_GIT_BRANCH: 'old' }, '/nowhere');
    expect(renamed?.status().branch).toBe('main');
  });
});

describe('NAME_FILE: any variable read from a file', () => {
  const withFiles = (files: Record<string, string>, run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'wirehub-file-env-'));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('sets every NAME from NAME_FILE, dropping one trailing newline', () => {
    withFiles({ secret: 'abc123\n', key: 'GK00ff\r\n', url: 'postgres://u:p@db/x' }, (dir) => {
      const env: Record<string, string | undefined> = {
        BETTER_AUTH_SECRET_FILE: join(dir, 'secret'),
        S3_ACCESS_KEY_ID_FILE: join(dir, 'key'),
        DATABASE_URL_FILE: join(dir, 'url'),
        WIREHUB_SETUP_CODE_FILE: join(dir, 'secret'),
      };
      const result = resolveFileEnv(env);
      expect(result.errors).toEqual([]);
      expect(result.loaded).toEqual(['BETTER_AUTH_SECRET', 'DATABASE_URL', 'S3_ACCESS_KEY_ID', 'WIREHUB_SETUP_CODE']);
      expect(env['BETTER_AUTH_SECRET']).toBe('abc123');
      expect(env['S3_ACCESS_KEY_ID']).toBe('GK00ff');
      expect(env['DATABASE_URL']).toBe('postgres://u:p@db/x');
    });
  });

  it('lets an explicit value win, but not an empty one', () => {
    withFiles({ secret: 'from-file' }, (dir) => {
      const env: Record<string, string | undefined> = {
        S3_SECRET_ACCESS_KEY: 'explicit',
        S3_SECRET_ACCESS_KEY_FILE: join(dir, 'secret'),
        BETTER_AUTH_SECRET: '',
        BETTER_AUTH_SECRET_FILE: join(dir, 'secret'),
      };
      const result = resolveFileEnv(env);
      expect(env['S3_SECRET_ACCESS_KEY']).toBe('explicit');
      expect(result.shadowed).toEqual(['S3_SECRET_ACCESS_KEY_FILE']);
      expect(env['BETTER_AUTH_SECRET']).toBe('from-file');
    });
  });

  it('names a file it cannot read instead of skipping it', () => {
    const env: Record<string, string | undefined> = { POSTGRES_PASSWORD_FILE: '/nonexistent/wirehub/secret' };
    const result = resolveFileEnv(env);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('POSTGRES_PASSWORD_FILE: cannot read /nonexistent/wirehub/secret');
    expect(env['POSTGRES_PASSWORD']).toBeUndefined();
  });

  it('ignores blank _FILE values and names that are not variables', () => {
    const env: Record<string, string | undefined> = { S3_ACCESS_KEY_ID_FILE: '', lower_file: '/x', _FILE: '/x' };
    expect(resolveFileEnv(env, () => 'never')).toEqual({ loaded: [], shadowed: [], errors: [] });
  });

  it('the hosts also default WIREHUB_PACKS_DIR to the checkout\'s data/packs', () => {
    const env: Record<string, string | undefined> = {};
    prepareHostEnv(env);
    expect(env['WIREHUB_PACKS_DIR']).toBe(checkoutPacksDir());
    expect(checkoutPacksDir()).toMatch(/data[\\/]packs$/);
    const set: Record<string, string | undefined> = { WIREHUB_PACKS_DIR: '/data/packs' };
    prepareHostEnv(set);
    expect(set['WIREHUB_PACKS_DIR']).toBe('/data/packs');
  });
});
