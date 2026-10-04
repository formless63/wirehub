/**
 * The studio's `EditorLayoutStore`: the browser's own `localStorage`.
 *
 * Where a person dragged the parts of a cable, and how big they made the panes,
 * are facts about *them* and not about the cable — so they never go near the
 * design file or the workbench API. They belong to this browser, which is
 * exactly what `localStorage` is for. (The ERP will store the same two things
 * against a user account instead; the editor will not notice the difference.)
 *
 * Nothing here throws. Storage can be full, disabled, or private-mode hostile,
 * and a workbench whose pane sizes did not persist is still a workbench.
 */

import { isPaneSizes, type EditorLayoutStore } from '@cable-studio/editor-react';

const PREFIX = 'cable-studio/layout/1';
const PANES_KEY = `${PREFIX}/panes`;
const DETAIL_KEY = `${PREFIX}/detail`;
const PART_LABELS_KEY = `${PREFIX}/part-labels`;
const positionsKey = (designId: string): string => `${PREFIX}/positions/${designId}`;

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // out of quota, or storage denied: the arrangement lives for this page and
    // that is the whole cost
  }
}

/** `{ id: { x, y } }` and nothing else — a half-written record is no record. */
function asPositions(value: unknown): Record<string, { x: number; y: number }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, spot] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spot !== 'object' || spot === null) return undefined;
    const { x, y } = spot as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number') return undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    out[id] = { x, y };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function localLayoutStore(): EditorLayoutStore {
  return {
    positions: (designId) => asPositions(read(positionsKey(designId))),
    savePositions: (designId, positions) => write(positionsKey(designId), positions),
    panes: () => {
      const stored = read(PANES_KEY);
      return isPaneSizes(stored) ? stored : undefined;
    },
    savePanes: (sizes) => write(PANES_KEY, sizes),
    detail: () => {
      const stored = read(DETAIL_KEY);
      return stored === 'parts' || stored === 'pins' ? stored : undefined;
    },
    saveDetail: (detail) => write(DETAIL_KEY, detail),
    partLabels: () => {
      const stored = read(PART_LABELS_KEY);
      return typeof stored === 'boolean' ? stored : undefined;
    },
    savePartLabels: (visible) => write(PART_LABELS_KEY, visible),
  };
}
