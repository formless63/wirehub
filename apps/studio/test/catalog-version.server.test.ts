import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, defineModule } from '@wirehub/modules';
import { afterEach, describe, expect, it } from 'vitest';

import { fileCatalogVersion } from '../server/storage/catalog-version.ts';

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('fileCatalogVersion', () => {
  it('changes when a file the base reads is written', () => {
    root = mkdtempSync(join(tmpdir(), 'catalog-version-'));
    for (const dir of ['builds', 'vocab', 'tags']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'connectors.json'), '[]');
    let before = fileCatalogVersion(root);
    for (const file of ['builds/PCA-00101.json', 'vocab/families.json', 'tags/signal-tags.json']) {
      writeFileSync(join(root, file), '{"x":1}');
      const after = fileCatalogVersion(root);
      expect(after).not.toBe(before);
      before = after;
    }
  });

  it('ignores directories the base does not read, until a module declares them', () => {
    root = mkdtempSync(join(tmpdir(), 'catalog-version-'));
    for (const dir of ['devices', 'acme', 'derived/acme']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'connectors.json'), '[]');
    const plain = fileCatalogVersion(root);
    // the split's old devices/ and rules/ are no longer hard-coded
    writeFileSync(join(root, 'devices', 'example.json'), '{"x":1}');
    expect(fileCatalogVersion(root)).toBe(plain);
    // a module's documents and derived records are hashed once its registry says so
    const registry = createRegistry([defineModule({ id: 'acme', label: 'Acme', version: '1.0.0', documents: [{ path: 'data/acme/', class: 'imported' }], derived: [{ id: 'sum', label: 'Sum', files: ['sum.json'], derive: () => ({ 'sum.json': {} }) }] })]);
    const dirs = registry.catalogDirs();
    expect(dirs).toEqual(['acme', 'derived/acme']);
    const before = fileCatalogVersion(root, dirs);
    expect(before).toBe(plain);
    writeFileSync(join(root, 'acme', 'register.json'), '{"x":1}');
    const afterDoc = fileCatalogVersion(root, dirs);
    expect(afterDoc).not.toBe(before);
    writeFileSync(join(root, 'derived', 'acme', 'sum.json'), '{}');
    expect(fileCatalogVersion(root, dirs)).not.toBe(afterDoc);
    expect(fileCatalogVersion(root)).toBe(plain);
  });
});
