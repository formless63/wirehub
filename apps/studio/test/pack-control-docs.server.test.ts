import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PACK_HOST_CONTROL_FILES } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';
import { isPackFilePath, readPackBytes, writePackFiles } from '../server/pack-archive.ts';
import { zipFiles } from './pack-bundle-flow.ts';

const manifest = { format: 1, id: 'synthetic', name: 'Synthetic', version: '1.0.0', license: 'CC0-1.0' };
const encoder = new TextEncoder();

describe('archive host control boundary', () => {
  it.each(PACK_HOST_CONTROL_FILES)('rejects %s in JSON, ZIP and wrapped ZIP', (path) => {
    expect(isPackFilePath(path)).toBe(false);
    expect(() => readPackBytes(encoder.encode(JSON.stringify({ format: 1, manifest, files: { [path]: {} } })))).toThrow(/not a path/);
    for (const prefix of ['', 'pack/']) {
      expect(() => readPackBytes(zipFiles({ [`${prefix}wirehub-pack.json`]: JSON.stringify(manifest), [`${prefix}${path}`]: '{}' }))).toThrow(/reserved host control state/);
    }
  });

  it('preflights direct archive writes before creating any files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirehub-control-'));
    try {
      const files = new Map([['wirehub-pack.json', encoder.encode(JSON.stringify(manifest))], ['packs.json', encoder.encode('{}')]]);
      expect(() => writePackFiles(dir, files)).toThrow(/not a path/);
      expect(existsSync(join(dir, 'wirehub-pack.json'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts ordinary auxiliary settings', () => {
    for (const file of ['branding', 'engineering', 'custom']) {
      expect(isPackFilePath(`settings/${file}.json`)).toBe(true);
    }
  });
});
