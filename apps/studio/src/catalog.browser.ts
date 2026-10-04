/**
 * The catalog, as the browser gets it: from the workbench API only
 *.
 *
 * The bundle carries none of the catalog: each screen asks the API
 * (`GET /api/db`, `/api/designs`,
 * `/api/part-numbers`, …) and, when the API cannot be reached, falls back to
 * the last answer this browser fetched (`offline-cache.browser.ts`), shown
 * read-only under the offline banner.
 *
 * What stays here is the small, data-free glue the screens share: the empty
 * placeholders a screen paints before its first answer lands, the
 * fetch-then-remember / recall pattern, and the document-facts rule.
 */

import type { DesignId } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import type { DocumentFacts } from '@wirehub/docs';

import { cableListEntry } from './cable-list.ts';
import { offlineCopyFrom, recall, remember } from './offline-cache.browser.ts';

/** The parts library before the workbench has answered: nothing, flagged not-live by the caller. */
export const EMPTY_DB: Db = {
  connectors: [],
  wires: [],
  components: [],
  pcbas: [],
  mechanicals: [],
  vocab: {},
  bodies: [],
  interfaces: [],
  kits: [],
};

/** A read that came from the API (`live`) or from this browser's last copy. */
export type LiveOrCached<T> = { value: T; live: true } | { value: T; live: false; savedAt: string };

/**
 * `GET <path>`; on success the answer is remembered under `key`, on any
 * failure (unreachable, non-2xx, unreadable JSON) the last remembered answer
 * comes back flagged `live: false`, and with none, `undefined`. Never throws.
 */
export async function fetchOrRecall<T>(key: string, path: string, parse: (body: unknown) => T = (body) => body as T): Promise<LiveOrCached<T> | undefined> {
  try {
    const response = await fetch(path);
    if (response.ok) {
      const value = parse(await response.json());
      void remember(key, value);
      return { value, live: true };
    }
  } catch {
    // the cached copy below
  }
  const cached = await recall<T>(key);
  return cached === undefined ? undefined : { value: cached.value, live: false, savedAt: cached.savedAt };
}

/**
 * The build sheet's and BOM's title-block short names: destination and stock
 * exactly as the cable list shows them, by the same rule (`cableListEntry`),
 * for the design and definitions being printed.
 */
export function documentFactsFor(): (design: CableDesign, db: Db) => DocumentFacts {
  const context: Parameters<typeof cableListEntry>[2] = { wireVendors: {} };
  return (design, db) => {
    const entry = cableListEntry(design, db, context);
    const stock = entry.wires.map((w) => (w.vendor === undefined ? w.name : `${w.name} · ${w.vendor}`)).join(' + ');
    return {
      ...(entry.destinationShort === '' ? {} : { destination: entry.destinationShort }),
      ...(stock === '' ? {} : { stock }),
    };
  };
}

/** When the offline copy on screen was fetched — what the offline banner names. */
export { offlineCopyFrom };

export type { DesignId };
export type { CableListEntry } from './cable-list.ts';
