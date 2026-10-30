/**
 * The compare view's frozen side (`<kind>/<id>@<design>:<rev>`): the copy of a library record a
 * saved design version froze, with that version's own 2D art — for an input whose captured copy
 * matches no saved record revision (the version's Inputs panel links it).
 */

import type { FrozenRecordsAdapter } from '@wirehub/editor-react';
import type { FrozenDefinitions } from '@wirehub/model';

import { getVersion, getVersionArtwork } from '../versions.browser.ts';

const VIEW_ORDER = ['board-top', 'board-bottom', 'mating-face', 'solder-side', 'illustration'];
const rank = (path: string): number => {
  const n = VIEW_ORDER.findIndex((v) => path.includes(v));
  return n < 0 ? VIEW_ORDER.length : n;
};

/** The version's drawn art for `id` as an image source: vector first, then raster, top view first. */
function artOf(id: string, art: { vector: Record<string, string>; raster: Record<string, string> }): string | undefined {
  const own = (paths: string[]): string[] => paths.filter((p) => p.startsWith(`${id}/`) && !/symbol|photo/.test(p)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const vector = own(Object.keys(art.vector))[0];
  if (vector !== undefined) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(art.vector[vector]!)}`;
  const raster = own(Object.keys(art.raster))[0];
  return raster === undefined ? undefined : art.raster[raster];
}

export const frozenRecords: FrozenRecordsAdapter = {
  async read({ kind, id, design, rev }) {
    const file = await getVersion(design, rev);
    if (!file.ok) return file;
    const list = (file.value.definitions as unknown as Record<string, { id: string }[] | undefined>)[kind as keyof FrozenDefinitions];
    const record = list?.find((r) => r.id === id);
    if (record === undefined) return { ok: false, message: `Rev ${rev} of ${design} froze no copy of ${id}` };
    const art = await getVersionArtwork(design, rev);
    const src = art.ok ? artOf(id, art.value) : undefined;
    return { ok: true, value: { record, ...(src === undefined ? {} : { art: src }) } };
  },
};
