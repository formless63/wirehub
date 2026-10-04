/**
 * The environment helper: `WIREHUB_*` names first, the pre-rename `STUDIO_*`
 * names as a deprecated fallback, and one warning naming every legacy
 * variable in use.
 */

import { describe, expect, it } from 'vitest';

import { studioBackupFromEnv } from '../server/backup/backup.ts';
import { blobStoreFromEnv } from '../server/blobs.ts';
import { envVar, legacyEnvNames, legacyEnvWarning } from '../server/env.ts';
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
