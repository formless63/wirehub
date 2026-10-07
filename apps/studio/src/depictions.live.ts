/** Live catalog artwork, including installed packs and uploaded depictions. */
import type { ArtworkAdapter, DepictionArtwork, DepictionSource } from '@wirehub/editor-react';
import type { DepictionMeta } from '@wirehub/catalog';
import type { LazyDepictions } from './depictions.browser.ts';

export interface LiveDepictions extends LazyDepictions {
  refresh(): Promise<void>;
}

export function liveDepictions(
  fallback: LazyDepictions,
  adapter: Pick<ArtworkAdapter, 'detail' | 'artwork'>,
  list: () => Promise<string[]>,
): LiveDepictions {
  let known: Set<string> | undefined;
  const loaded = new Map<string, { meta: DepictionMeta; art: Map<string, DepictionArtwork>; complete: boolean }>();
  const pending = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let generation = 0;
  let snapshot: DepictionSource;
  let refreshing: Promise<void> | undefined;
  const publish = (): void => {
    snapshot = {
      meta(id) {
        if (known === undefined) return fallback.current().meta(id);
        if (!loaded.has(id) && known.has(id)) void loadOne(id);
        return loaded.get(id)?.meta;
      },
      artwork(id, view) {
        if (known === undefined) return fallback.current().artwork(id, view);
        if (!loaded.has(id) && known.has(id)) void loadOne(id);
        return loaded.get(id)?.art.get(view);
      },
    };
    for (const listener of [...listeners]) listener();
  };
  const loadOne = (id: string): Promise<void> => {
    if (known === undefined) return fallback.load([id]);
    if (!known.has(id) || loaded.get(id)?.complete === true) return Promise.resolve();
    const existing = pending.get(id);
    if (existing !== undefined) return existing;
    const epoch = generation;
    const task = (async () => {
      try {
        const detail = await adapter.detail(id);
        if (!detail.ok || detail.value.meta === undefined || detail.value.meta.defId !== id) return;
        const meta = detail.value.meta;
        const art = new Map<string, DepictionArtwork>();
        await Promise.all(Object.keys(meta.views).map(async (view) => {
          const result = await adapter.artwork(id, view);
          if (result.ok && result.value.kind === meta.views[view]?.kind) art.set(view, result.value);
        }));
        if (epoch !== generation) return;
        // Keep readable faces available, but allow an explicit load to retry
        // a temporarily missing view. Rendering itself only requests entries
        // with no metadata, so a failed view cannot create a render/retry loop.
        loaded.set(id, { meta, art, complete: art.size === Object.keys(meta.views).length });
        publish();
      } catch {
        // Missing/unreachable artwork keeps the abstract rendering fallback.
      } finally {
        if (epoch === generation) pending.delete(id);
      }
    })();
    pending.set(id, task);
    return task;
  };
  const refresh = (): Promise<void> => {
    if (refreshing !== undefined) return refreshing;
    const task = (async () => {
      try {
        const ids = await list();
        generation += 1;
        known = new Set(ids);
        loaded.clear();
        pending.clear();
        publish();
      } catch {
        // Keep the previous source on a temporary connection failure.
      } finally {
        refreshing = undefined;
      }
    })();
    refreshing = task;
    return task;
  };
  publish();
  fallback.subscribe(() => { if (known === undefined) publish(); });
  return {
    current: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => void listeners.delete(listener); },
    known: () => known === undefined ? fallback.known() : [...known],
    load: async (ids) => { await refreshIfUnknown(); await Promise.all([...new Set(ids)].map(loadOne)); },
    refresh,
  };
  async function refreshIfUnknown(): Promise<void> { if (known === undefined) await refresh(); }
}
