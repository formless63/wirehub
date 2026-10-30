/** Cover stale-safety: automatic never picks an explicit capture; a changed captured source is `stale`. */

import { describe, expect, it } from 'vitest';

import { resolveCover, type RepresentationCandidate, type RepresentationView } from '../src/representations.ts';

const identity = { record: 'r1', revision: 'v1' };
const candidate = (view: string, over: Partial<RepresentationCandidate> = {}): RepresentationCandidate => ({
  view, label: view, identity, lineage: `${view}-L`, asset: `${view}-asset`, sourceKind: 'render', fidelity: 'derived', limitations: [], src: 'test', sources: [], ...over,
});
const view = (candidates: RepresentationCandidate[], choice: RepresentationView['choice']): RepresentationView => ({ identity, candidates, choice });

describe('resolveCover', () => {
  it('automatic skips captures, even when only a capture exists', () => {
    expect(resolveCover(view([candidate('cam', { sourceKind: 'capture' }), candidate('top')], null))).toMatchObject({ state: 'automatic', selected: { view: 'top' } });
    expect(resolveCover(view([candidate('cam', { sourceKind: 'capture' })], null))).toEqual({ state: 'unavailable' });
  });

  it('a chosen capture whose source changed is stale, with the automatic fallback shown', () => {
    const choice = { view: 'cam', lineage: 'cam-L' };
    expect(resolveCover(view([candidate('cam', { sourceKind: 'capture' }), candidate('top')], choice))).toMatchObject({ state: 'chosen', selected: { view: 'cam' } });
    const stale = candidate('cam', { sourceKind: 'capture', stale: 'source changed' });
    delete stale.asset;
    expect(resolveCover(view([stale, candidate('top')], choice))).toMatchObject({ state: 'stale', selected: { view: 'top' } });
  });
});
