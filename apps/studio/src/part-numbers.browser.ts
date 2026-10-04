/**
 * The part-number data the PN suggest and the title blocks read — live from
 * `GET /api/part-numbers`, so a drawing PN saved or a design created since
 * the page was built is counted. When the workbench cannot be reached, this
 * browser's last copy stands in, flagged `live: false`: it only ever feeds
 * suggestions and read-only views, never a write.
 *
 * The scheme is the built-in prefix scheme configured by the catalog's
 * `part-numbers.json` (absent: its defaults). A module that brings its own
 * scheme registers it at build time (`docs/modules.md`).
 */

import { DEFAULT_PART_NUMBER_SCHEME, parsePrefixSchemeConfig, prefixPartNumberScheme, type CableDesign, type PartNumberScheme } from '@wirehub/model';
import type { DrawingMeta } from '@wirehub/docs';
import type { PartNumberData } from '@wirehub/editor-react';

import { fetchOrRecall } from './catalog.browser.ts';
import { registeredPartNumberScheme } from './modules.browser.ts';

export const partNumbersKey = ['studio', 'partNumbers'] as const;

export interface PartNumbersQueryData {
  data: PartNumberData;
  /** false: the workbench could not be reached and `data` is this browser's last copy */
  live: boolean;
}

interface Payload {
  /** the catalog's `part-numbers.json` as stored, or absent */
  scheme?: unknown;
  designs: CableDesign[];
  drawings: Record<string, DrawingMeta>;
}

function schemeOf(json: unknown): PartNumberScheme {
  const registered = registeredPartNumberScheme();
  if (registered !== undefined) return registered;
  if (json === undefined || json === null) return DEFAULT_PART_NUMBER_SCHEME;
  try {
    return prefixPartNumberScheme(parsePrefixSchemeConfig(json));
  } catch {
    return DEFAULT_PART_NUMBER_SCHEME;
  }
}

export function parsePartNumberPayload(body: Payload): PartNumberData {
  return {
    scheme: schemeOf(body.scheme),
    designs: body.designs,
    drawings: body.drawings,
  };
}

/** `undefined`: the workbench could not be reached and this browser has no copy yet. */
export async function loadPartNumberData(base = '/api'): Promise<PartNumbersQueryData | undefined> {
  const out = await fetchOrRecall<Payload>('part-numbers', `${base}/part-numbers`);
  return out === undefined ? undefined : { data: parsePartNumberPayload(out.value), live: out.live };
}
