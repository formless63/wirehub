import { expect, it } from 'vitest';
import type { Db, PcbaDefinition } from '@wirehub/model';
import type { DepictionMeta } from '../src/artwork.ts';
import { journeySteps } from '../src/board-journey.ts';

const def: PcbaDefinition = { id: 'synthetic-board', label: 'Synthetic board', partNumber: 'SYN-00001', revision: '2', terminals: [], internalLinks: [], src: 'synthetic example' };
const db: Db = { connectors: [], components: [], pcbas: [def], wires: [] };
function steps(kind?: 'kicad' | 'gerber') {
  const meta: DepictionMeta | undefined = kind === undefined ? undefined : {
    defId: def.id, src: 'synthetic example', views: { 'board-top': { file: 'board-top.svg', kind: 'vector', sourceKind: kind, src: 'synthetic example', mmPerUnit: 1 } },
    anchorFrame: 'board-top', pinAnchors: {},
  };
  return journeySteps({ db, def, meta, files: [], draft: undefined, guidesNeeded: [] });
}
it('does not nag a board whose art is its native KiCad render', () => {
  const native = steps('kicad');
  expect(native[0]).toMatchObject({ state: 'done', note: 'KiCad' });
  expect(native[4]).toMatchObject({ state: 'none' });
  expect(native[4]!.title).toContain('Gerber');
});
it('keeps Gerber and absent-art step states unchanged', () => {
  expect(steps('gerber')[0]).toMatchObject({ state: 'done', note: 'imported' });
  expect(steps('gerber')[4]).toMatchObject({ state: 'none', note: 'not needed' });
  expect(steps()[0]).toMatchObject({ state: 'todo', note: 'needs board art' });
});
