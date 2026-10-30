/**
 * A design's free tags (`CableDesign.tags`): what a tag may look like, and adding or removing tags
 * the way the editor's Notes panel does (trimmed, deduplicated, in order, kept before `src`).
 * Validation (`invalid-tags`), the editor and the bulk tagging route all read these.
 */

import type { CableDesign } from './model.ts';

/** One tag: a short word — letters, digits, spaces, dash, underscore, dot or slash, up to 40 characters. */
export const DESIGN_TAG = /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,39}$/;
/** At most this many tags on one design. */
export const MAX_DESIGN_TAGS = 50;

export function isDesignTag(value: unknown): value is string {
  return typeof value === 'string' && DESIGN_TAG.test(value);
}

/** Trimmed, blank ones dropped, the first of each kept. */
export function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
}

/**
 * `design` with `tags` as its tags: the field removed when there are none, otherwise placed
 * just before `src` (where the editor puts it), so a tag change is a small diff.
 */
export function withDesignTags(design: CableDesign, tags: readonly string[]): CableDesign {
  const { tags: _old, ...rest } = design;
  if (tags.length === 0) return rest as CableDesign;
  const entries = Object.entries(rest);
  const at = entries.findIndex(([key]) => key === 'src');
  if (at === -1) return { ...rest, tags: [...tags] } as CableDesign;
  return Object.fromEntries([...entries.slice(0, at), ['tags', [...tags]], ...entries.slice(at)]) as unknown as CableDesign;
}

/**
 * The tags `design` has after adding `add` (appended, in order, when not already there) and
 * removing `remove` (exact match). Returns `design` itself when nothing changes.
 */
export function retagDesign(design: CableDesign, add: readonly string[], remove: readonly string[]): CableDesign {
  const before = design.tags ?? [];
  const removing = new Set(cleanTags(remove));
  const after = cleanTags([...before, ...add]).filter((t) => !removing.has(t));
  if (after.length === before.length && after.every((t, i) => t === before[i])) return design;
  return withDesignTags(design, after);
}
