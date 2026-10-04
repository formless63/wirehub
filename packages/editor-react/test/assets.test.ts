/**
 * The shared asset picker's pure logic: search
 * matching, size formatting, and the recently-used ordering — no DOM, no
 * adapter, so these run against every edge case cheaply. The picker
 * component itself is `asset-picker.dom.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import {
  formatAssetSize,
  matchesAssetQuery,
  orderAssets,
  withAssetUsed,
  type SharedAsset,
} from '../src/assets.ts';

function asset(id: string, originalName: string, src = 'test fixture'): SharedAsset {
  return { id, mime: 'image/jpeg', originalName, src, bytes: 1024, dataUri: `data:image/jpeg;base64,${id}` };
}

describe('matchesAssetQuery', () => {
  const scart = asset('a', 'scart-connector.jpg', 'Photographed on the bench, 2026-01-04');

  it('matches everything for an empty query', () => {
    expect(matchesAssetQuery(scart, '')).toBe(true);
    expect(matchesAssetQuery(scart, '   ')).toBe(true);
  });

  it('matches the filename, case-insensitively', () => {
    expect(matchesAssetQuery(scart, 'SCART')).toBe(true);
    expect(matchesAssetQuery(scart, 'connector')).toBe(true);
  });

  it('also matches the src/provenance text', () => {
    expect(matchesAssetQuery(scart, 'bench')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesAssetQuery(scart, 'hdmi')).toBe(false);
  });
});

describe('formatAssetSize', () => {
  it('bytes under a kilobyte', () => {
    expect(formatAssetSize(512)).toBe('512 B');
  });

  it('kilobytes, rounded', () => {
    expect(formatAssetSize(68717)).toBe('67 KB');
  });

  it('megabytes, one decimal', () => {
    expect(formatAssetSize(2_500_000)).toBe('2.4 MB');
  });
});

describe('withAssetUsed', () => {
  it('puts the used id first', () => {
    expect(withAssetUsed(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });

  it('moves an already-recent id to the front instead of duplicating it', () => {
    expect(withAssetUsed(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => `id${i}`);
    expect(withAssetUsed(many, 'new').length).toBeLessThanOrEqual(12);
  });
});

describe('orderAssets', () => {
  const a = asset('a', 'a.jpg');
  const b = asset('b', 'b.jpg');
  const c = asset('c', 'c.jpg');

  it('recently-used first, in recency order, then the rest alphabetically', () => {
    const ordered = orderAssets([c, a, b], ['b', 'a']);
    expect(ordered.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('with no recent ids, everything sorts alphabetically by name', () => {
    const ordered = orderAssets([c, a, b], []);
    expect(ordered.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a recent id the asset list no longer has', () => {
    const ordered = orderAssets([a, b], ['gone', 'b']);
    expect(ordered.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
