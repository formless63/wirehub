import { describe, expect, it } from 'vitest';

import { exportsForView } from '../src/devices/device-exports.browser.ts';

const run = (id: string, rev?: number): { id: string; params: { design?: { id: string; rev?: number } } } => ({ id, params: { design: { id: 'synthetic-device', ...(rev === undefined ? {} : { rev }) } } });

describe('device exports offered by a view', () => {
  // newest first, as the API lists them: a working-copy export made after Rev 0 from changed inputs
  const runs = [run('working-new'), run('rev1', 1), run('rev0', 0), run('working-old')];

  it('a saved version offers only exports made from it, never a working-copy export', () => {
    expect(exportsForView(runs, 0).map((r) => r.id)).toEqual(['rev0']);
    expect(exportsForView(runs, 2)).toEqual([]);
    expect(exportsForView(runs, undefined).map((r) => r.id)).toEqual(['working-new', 'rev1', 'rev0', 'working-old']);
  });
});
