/**
 * The studio's `DefinitionsAdapter`: the workbench's definition endpoints, over
 * `fetch`.
 *
 * The sibling of `persistence.browser.ts`, and for the same reason: the editor
 * is handed an adapter and never learns where the parts library is kept, so the
 * same Library view sits inside the ERP later with a different adapter and no
 * change at all.
 *
 * Nothing here throws. A validator refusal, a definition something else is
 * still using, a dev server that is not running — each comes back as a sentence
 * and a next step, because that is what the screen has to show.
 */

import type {
  DefinitionKind,
  DefinitionList,
  DefinitionRecord,
  DefinitionUsage,
  DefinitionsAdapter,
  Outcome,
} from '@cable-studio/editor-react';
import type { Db, Issue } from '@cable-studio/model';

interface ApiError {
  error?: string;
  hint?: string;
  issues?: Issue[];
}

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
        };
  }

  if (response.ok) return { ok: true, value: payload as T };

  const body = (payload ?? {}) as ApiError;
  return {
    ok: false,
    message: body.error ?? `The workbench refused that (HTTP ${response.status}).`,
    ...(body.hint === undefined ? {} : { hint: body.hint }),
    ...(body.issues === undefined ? {} : { issues: body.issues }),
  };
}

/** An id is a path segment here, so it is encoded — the API refuses it anyway. */
function definitionUrl(base: string, kind: DefinitionKind, id?: string, action?: string): string {
  const path = `${base}/definitions/${kind}`;
  if (id === undefined) return path;
  const withId = `${path}/${encodeURIComponent(id)}`;
  return action === undefined ? withId : `${withId}/${action}`;
}

/**
 * The stale-write guard, client side — the sibling of
 * `persistence.browser.ts`'s. A definition's version is per `kind/id`, so the
 * map is keyed on the same string `definitionUrl` builds.
 */
export function workbenchDefinitions(base = '/api'): DefinitionsAdapter {
  const versions = new Map<string, string>();
  const versionKey = (kind: DefinitionKind, id: string): string => `${kind}/${id}`;
  const remember = (kind: DefinitionKind, id: string) => (response: Response): void => {
    const etag = response.headers.get('etag');
    const key = versionKey(kind, id);
    if (etag !== null) versions.set(key, etag);
    else if (response.status === 404) versions.delete(key);
  };
  const ifMatchOf = (kind: DefinitionKind, id: string): Record<string, string> | undefined => {
    const etag = versions.get(versionKey(kind, id));
    return etag === undefined ? undefined : { 'if-match': etag };
  };

  return {
    list: async (kind) => {
      const outcome = await request<DefinitionList & { etags?: Record<string, string> }>(definitionUrl(base, kind));
      if (!outcome.ok) return outcome;
      // the versions the editor is about to show: what a save quotes back
      const { etags, ...list } = outcome.value;
      for (const [id, etag] of Object.entries(etags ?? {})) versions.set(versionKey(kind, id), etag);
      return { ok: true, value: list };
    },

    save: (kind, record) =>
      request<DefinitionRecord>(
        definitionUrl(base, kind, record.id),
        {
          method: 'PUT',
          body: record,
          ...(ifMatchOf(kind, record.id) === undefined ? {} : { headers: ifMatchOf(kind, record.id) }),
        },
        remember(kind, record.id),
      ),

    create: (kind, record) =>
      request<DefinitionRecord>(
        definitionUrl(base, kind),
        { method: 'POST', body: record },
        remember(kind, record.id),
      ),

    remove: (kind, id, confirm) =>
      request<{ deleted: string }>(definitionUrl(base, kind, id), {
        method: 'DELETE',
        body: { confirm },
      }).then((result) => {
        if (result.ok) versions.delete(versionKey(kind, id));
        return result.ok ? { ok: true, value: { id: result.value.deleted } } : result;
      }),

    usage: (kind, id) => request<DefinitionUsage>(definitionUrl(base, kind, id, 'usage')),
  };
}

/**
 * The library as the workbench has it *now*.
 *
 * The page was built with a copy of the catalog compiled into it; the moment a
 * definition is saved that copy is one edit behind, and everything downstream —
 * the palette, the canvas, the validator, the build sheet — would be reading
 * yesterday's parts list. So after every definition change the shell re-reads
 * this and hands the fresh library down.
 */
export async function fetchDb(base = '/api'): Promise<Db | undefined> {
  const outcome = await request<Db>(`${base}/db`);
  return outcome.ok ? outcome.value : undefined;
}
