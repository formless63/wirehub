import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fileCatalogVersion } from '../server/storage/catalog-version.ts';

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('fileCatalogVersion', () => {
  it('changes when a build file, device or rule file is written', () => {
    root = mkdtempSync(join(tmpdir(), 'catalog-version-'));
    for (const dir of ['builds', 'devices', 'rules']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'connectors.json'), '[]');
    let before = fileCatalogVersion(root);
    for (const file of ['builds/PCA-00101.json', 'devices/example.json', 'rules/policy.json']) {
      writeFileSync(join(root, file), '{"x":1}');
      const after = fileCatalogVersion(root);
      expect(after).not.toBe(before);
      before = after;
    }
  });
});
