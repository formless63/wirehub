/** The revision-source extension point: filtered by kind, ids checked, counted as a point, the API minor raised. */

import { describe, expect, it } from 'vitest';

import { MODULE_API_VERSION, apiCompatibility, createRegistry, defineModule, extensionPointsOf, manifestProblems } from '../src/index.ts';

const share = defineModule({
  id: 'share',
  label: 'File share revisions',
  version: '1.0.0',
  revisionSources: [
    { id: 'boards', label: 'Boards on the share', kinds: ['pcbas'], list: () => [{ rev: 'Rev1', src: 'synthetic example' }] },
    { id: 'everything', label: 'Everything', list: () => [] },
  ],
});

describe('revision sources', () => {
  it('are listed by kind, every source when no kind is asked for', () => {
    const registry = createRegistry([share]);
    expect(registry.revisionSources().map((s) => `${s.module}/${s.id}`)).toEqual(['share/boards', 'share/everything']);
    expect(registry.revisionSources('pcbas').map((s) => s.id)).toEqual(['boards', 'everything']);
    expect(registry.revisionSources('connectors').map((s) => s.id)).toEqual(['everything']);
    expect(extensionPointsOf(share)).toEqual(['revisionSources']);
  });

  it('need kebab ids, unique within the module', () => {
    const bad = defineModule({ ...share, revisionSources: [{ id: 'Bad Id', label: 'x', list: () => [] }, { id: 'twice', label: 'a', list: () => [] }, { id: 'twice', label: 'b', list: () => [] }] });
    expect(manifestProblems([bad]).join(' | ')).toMatch(/'Bad Id' is not a kebab-case id.*two revision sources with id 'twice'/);
  });

  it('came with module API 1.2, which still runs 1.0 and 1.1 modules', () => {
    expect(MODULE_API_VERSION).toBe('1.5');
    expect(apiCompatibility('1.1')).toEqual({ ok: true });
    expect(apiCompatibility('1.6').ok).toBe(false);
  });
});
