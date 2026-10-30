/**
 * Data-loss boundary: removing assets never drops one a current record, version or history entry
 * still names (`asset-remove.ts`, searched in a real catalog directory and its git history).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorkbenchDeps } from '../server/api.ts';
import { fileAssetReferences, removeUnreferencedAssets } from '../server/asset-remove.ts';
import { memoryAssetStore } from '../server/assets.ts';

describe('removeUnreferencedAssets', () => {
  it('removes only what nothing names; history needs a named replacement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-asset-remove-'));
    const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore' });
    const assets = memoryAssetStore();
    const [inUse, inVersion, inHistory, replaced, free, clean] = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((b) => assets.put(Buffer.from(b), 'image/png', `${b}.png`, 'synthetic test')));
    mkdirSync(join(dir, 'knowledge/notes'), { recursive: true });
    mkdirSync(join(dir, 'designs/_versions/x'), { recursive: true });
    git('init', '-q');
    // history: a note that once named two photos
    writeFileSync(join(dir, 'knowledge/notes/old.json'), JSON.stringify({ attachments: [{ asset: inHistory!.id }, { asset: replaced!.id }] }));
    git('add', '-A');
    git('commit', '-qm', 'old');
    writeFileSync(join(dir, 'knowledge/notes/old.json'), JSON.stringify({ attachments: [] }));
    writeFileSync(join(dir, 'knowledge/notes/now.json'), JSON.stringify({ attachments: [{ asset: inUse!.id }] }));
    writeFileSync(join(dir, 'designs/_versions/x/1.json'), JSON.stringify({ photo: inVersion!.id }));
    git('add', '-A');
    git('commit', '-qm', 'now');
    const deps = { assets, assetReferences: fileAssetReferences(dir) } as unknown as WorkbenchDeps;
    const ids = [inUse!.id, inVersion!.id, inHistory!.id, replaced!.id, free!.id];
    const replacedBy = { [replaced!.id]: clean!.id, [inUse!.id]: clean!.id, [inVersion!.id]: clean!.id };

    const dry = await removeUnreferencedAssets(deps, ids, { dryRun: true, replacedBy });
    expect(dry.removed.map((r) => r.id).sort()).toEqual([replaced!.id, free!.id].sort());
    expect((await assets.list()).length).toBe(6);

    const out = await removeUnreferencedAssets(deps, ids, { replacedBy });
    expect(out.removed.map((r) => r.id).sort()).toEqual([replaced!.id, free!.id].sort());
    expect(out.kept.map((k) => k.id).sort()).toEqual([inUse!.id, inVersion!.id, inHistory!.id].sort());
    const left = new Set((await assets.list()).map((r) => r.id));
    for (const id of [inUse!.id, inVersion!.id, inHistory!.id, clean!.id]) expect(left.has(id)).toBe(true);
  });
});
