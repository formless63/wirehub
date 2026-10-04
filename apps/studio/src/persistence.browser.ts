/**
 * The studio's `PersistenceAdapter`: the workbench API, over `fetch`.
 *
 * This is the *only* file in the studio that knows a URL. `CableEditor` is
 * handed the adapter and never learns where anything is kept — which is what
 * lets the same editor sit inside the ERP later with a different adapter and
 * no change at all.
 *
 * Nothing here throws. Every failure — a validator refusal, a name already in
 * use, a dev server that is not running — comes back as a sentence and a next
 * step, because that is what the screen has to show.
 */

import {
  withAssetUsed,
  type AssetsAdapter,
  type DesignSummary,
  type DrawingAdapter,
  type DrawingSidecar,
  type Outcome,
  type PersistenceAdapter,
  type SharedAsset,
  type VendorDocument,
  type VendorDocumentsAdapter,
} from '@cable-studio/editor-react';
import type { DrawingMeta } from '@cable-studio/docs';
import type { CableDesign, Issue } from '@cable-studio/model';

import type { CableListEntry } from './cable-list.ts';

/** The error body the workbench API answers with. */
interface ApiError {
  error?: string;
  hint?: string;
  issues?: Issue[];
}

/**
 * A response the workbench never sent — the dev server is down, the page is a
 * static bundle, the network blinked. The advice has to be actionable: this
 * API lives inside the dev server, so "start it" is the whole fix.
 */
function unreachable<T>(error: unknown): Outcome<T> {
  return {
    ok: false,
    message: 'The studio could not reach the workbench.',
    hint: `Nothing was changed. The workbench runs inside the studio's dev server — start it with \`pnpm --filter studio dev\` and try again. (${
      error instanceof Error ? error.message : String(error)
    })`,
  };
}

export async function request<T>(
  input: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> } = { method: 'GET' },
  onResponse?: (response: Response) => void,
): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetch(input, {
      method: init.method,
      ...(init.body === undefined
        ? { ...(init.headers === undefined ? {} : { headers: init.headers }) }
        : {
            headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
            body: JSON.stringify(init.body),
          }),
    });
  } catch (error) {
    return unreachable(error);
  }
  onResponse?.(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return response.ok
      ? unreachable(error)
      : {
          ok: false,
          message: 'The workbench answered with something the studio could not read.',
          hint: `Nothing was changed. Check the terminal running the studio. (HTTP ${response.status})`,
          status: response.status,
        };
  }

  if (response.ok) return { ok: true, value: payload as T };

  const body = (payload ?? {}) as ApiError;
  return {
    ok: false,
    message: body.error ?? `The workbench refused that (HTTP ${response.status}).`,
    ...(body.hint === undefined ? {} : { hint: body.hint }),
    ...(body.issues === undefined ? {} : { issues: body.issues }),
    status: response.status,
  };
}

/** An id is a path segment here, so it is encoded — the API refuses it anyway. */
function designUrl(base: string, id: string, action?: string): string {
  const path = `${base}/designs/${encodeURIComponent(id)}`;
  return action === undefined ? path : `${path}/${action}`;
}

/**
 * The stale-write guard, client side: every design GET
 * or write answers with an `ETag` (a content hash — `server/etag.ts`); this
 * adapter remembers the last one it saw per id and sends it back as
 * `If-Match` on the next save, so a save that would silently overwrite a
 * change made elsewhere (another tab, the other owner, a `git pull`) comes
 * back 409 instead. A mismatch names nothing more specific than "changed" —
 * this is a Map of the *versions seen*, not the documents themselves — but the
 * server's 409 body carries an `issues[0].code === 'stale-write'` marker that
 * `studio-context.tsx` reads to show the right toast without guessing from
 * the message text.
 */
export function workbenchPersistence(base = '/api'): PersistenceAdapter {
  const versions = new Map<string, string>();
  const remember = (id: string) => (response: Response): void => {
    const etag = response.headers.get('etag');
    if (etag !== null) versions.set(id, etag);
    else if (response.status === 404) versions.delete(id);
  };
  const ifMatchOf = (id: string): Record<string, string> | undefined => {
    const etag = versions.get(id);
    return etag === undefined ? undefined : { 'if-match': etag };
  };

  return {
    async list(): Promise<Outcome<DesignSummary[]>> {
      const result = await request<{ designs: DesignSummary[] }>(`${base}/designs`);
      return result.ok ? { ok: true, value: result.value.designs } : result;
    },

    load: (id) => request<CableDesign>(designUrl(base, id), { method: 'GET' }, remember(id)),

    save: (design) =>
      request<CableDesign>(
        designUrl(base, design.id),
        { method: 'PUT', body: design, ...(ifMatchOf(design.id) === undefined ? {} : { headers: ifMatchOf(design.id) }) },
        remember(design.id),
      ),

    create: (design) =>
      request<CableDesign>(`${base}/designs`, { method: 'POST', body: design }, remember(design.id)),

    duplicate: (id, newId, newLabel) =>
      request<CableDesign>(
        designUrl(base, id, 'duplicate'),
        { method: 'POST', body: { newId, newLabel } },
        remember(newId),
      ),

    rename: (id, newId, newLabel) =>
      request<CableDesign>(
        designUrl(base, id, 'rename'),
        { method: 'POST', body: { newId, newLabel }, ...(ifMatchOf(id) === undefined ? {} : { headers: ifMatchOf(id) }) },
        (response) => {
          remember(newId)(response);
          if (newId !== id) versions.delete(id);
        },
      ),

    remove: (id, confirm) =>
      request<{ deleted: string }>(designUrl(base, id), {
        method: 'DELETE',
        body: { confirm },
      }).then((result) => {
        if (result.ok) versions.delete(id);
        return result.ok ? { ok: true, value: { id: result.value.deleted } } : result;
      }),
  };
}

/**
 * `/cables`' rows, over the same `GET /api/designs` `workbenchPersistence().list()`
 * uses — the response carries the richer `CableListEntry` shape
 * (`cable-list.ts`, `server/api.ts`'s `getDesigns`); `PersistenceAdapter.list()`
 * stays typed at `DesignSummary[]` (id+label) because that is the whole
 * contract editor-react's pickers need, so this is a second, studio-local
 * reader of the same bytes rather than a widened adapter type.
 */
export async function fetchCableList(base = '/api'): Promise<Outcome<CableListEntry[]>> {
  const result = await request<{ designs: CableListEntry[] }>(`${base}/designs`);
  return result.ok ? { ok: true, value: result.value.designs } : result;
}

/**
 * The drawing sheet's sidecars, over the same API.
 *
 * `noteTag` is the extra beyond `DrawingAdapter` that lets a caller who knows
 * a *different* request just rewrote this design's drawing (a version save,
 * `cable-studio-50a` drawing-form bug) hand this adapter the fresh `ETag`
 * straight from that response, instead of this form finding out only when
 * its own next save comes back 409. It only updates the remembered tag —
 * `useDrawingSidecar`'s stale-write recovery (`documents.ts`'s
 * `mergeDrawingMeta`) is still what saves an open form's unsaved edits.
 */
export function workbenchDrawings(base = '/api'): DrawingAdapter & { noteTag: (id: string, etag: string) => void } {
  const url = (id: string, action?: string): string =>
    `${base}/drawings/${encodeURIComponent(id)}${action === undefined ? '' : `/${action}`}`;
  // the same stale-write guard as the designs: the sidecar's version, as last seen
  const versions = new Map<string, string>();
  const remember = (id: string) => (response: Response): void => {
    const etag = response.headers.get('etag');
    if (etag !== null) versions.set(id, etag);
  };
  const guarded = (id: string): { headers?: Record<string, string> } => {
    const etag = versions.get(id);
    return etag === undefined ? {} : { headers: { 'if-match': etag } };
  };
  return {
    load: (id) => request<DrawingSidecar>(url(id), { method: 'GET' }, remember(id)),
    save: (id, meta) => request<DrawingMeta>(url(id), { method: 'PUT', body: meta, ...guarded(id) }, remember(id)),
    savePhoto: (id, photo) =>
      request<{ photo?: string }>(url(id, 'photo'), { method: 'PUT', body: { photo }, ...guarded(id) }, remember(id)),
    noteTag: (id, etag) => versions.set(id, etag),
  };
}

/**
 * The shared asset library, over the same API.
 *
 * "Recently used" lives in this browser's own `localStorage` — the same
 * reasoning as `layout.browser.ts`'s pane sizes: which asset this viewer
 * picked most recently is a fact about *them*, not a thing the workbench
 * API should be asked to remember for anyone who opens it.
 */
const RECENT_ASSETS_KEY = 'cable-studio/assets/1/recent';

function readRecentIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_ASSETS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function workbenchAssets(base = '/api'): AssetsAdapter {
  return {
    list: () => request<{ assets: SharedAsset[] }>(`${base}/assets`).then((result) => (result.ok ? { ok: true, value: result.value.assets } : result)),
    recentIds: readRecentIds,
    noteUsed: (id) => {
      try {
        window.localStorage.setItem(RECENT_ASSETS_KEY, JSON.stringify(withAssetUsed(readRecentIds(), id)));
      } catch {
        // out of quota, or storage denied — the pick still worked, it just
        // will not sort to the top next time
      }
    },
  };
}

/**
 * The shared asset store's files as a wire stock's vendor documents
 *: every stored file, listed without its bytes, and
 * opened in-app from `GET /api/assets/:id`.
 */
export function workbenchDocuments(base = '/api'): VendorDocumentsAdapter {
  return {
    list: () =>
      request<{ assets: VendorDocument[] }>(`${base}/assets/index`).then((result) =>
        result.ok ? { ok: true, value: result.value.assets } : result,
      ),
    href: (id) => `${base}/assets/${encodeURIComponent(id)}`,
  };
}
