/**
 * The studio's `WireLibraryAdapter`: the workbench's `/api/wire-library`
 * endpoints over `fetch`. Nothing here throws — a
 * refusal or an unreachable server comes back as a sentence and a next step.
 */

import type { Issue, StripPractice, WireLibrary, WirePart, WireRecipe } from '@wirehub/model';
import type { Outcome, WireLibraryAdapter } from '@wirehub/editor-react';

async function call<T>(
  input: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
  onResponse?: (response: Response) => void,
): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetch(input, {
      method,
      ...(body === undefined
        ? { headers }
        : { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    });
    onResponse?.(response);
  } catch (error) {
    return {
      ok: false,
      message: 'The studio could not reach the workbench.',
      hint: `Nothing was changed. (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, message: `The workbench answered with something the studio could not read (HTTP ${response.status}).` };
  }
  if (response.ok) return { ok: true, value: payload as T };
  const refusal = (payload ?? {}) as { error?: string; hint?: string; issues?: Issue[] };
  return {
    ok: false,
    message: refusal.error ?? `The workbench refused that (HTTP ${response.status}).`,
    ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
    ...(refusal.issues === undefined ? {} : { issues: refusal.issues }),
  };
}

/**
 * The library's version (`ETag` over parts + recipes) as last seen, sent back
 * as `If-Match` when a stock is edited — the server refuses an edit without it.
 */
export function workbenchWireLibrary(): WireLibraryAdapter {
  let version: string | undefined;
  const remember = (response: Response): void => {
    const etag = response.headers.get('etag');
    if (etag !== null) version = etag;
  };
  const guard = (): Record<string, string> => (version === undefined ? {} : { 'if-match': version });
  return {
    load: () => call<WireLibrary>('/api/wire-library', 'GET', undefined, {}, remember),
    addPart: (part: WirePart) => call<WirePart>('/api/wire-library/parts', 'POST', { part }, {}, remember),
    saveStock: (recipe: WireRecipe, create: boolean) =>
      call<{ recipe: WireRecipe }>(
        `/api/wire-library/stocks/${encodeURIComponent(recipe.id)}`,
        'PUT',
        { recipe, create },
        create ? {} : guard(),
        remember,
      ),
    practice: () => call<StripPractice[]>('/api/wire-library/strip-practice', 'GET'),
  };
}
