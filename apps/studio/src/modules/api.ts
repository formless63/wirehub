/** A module's own server routes (`/api/modules/<module>/<path>`) as the `ModuleApi` panels and routes receive. */

import type { ModuleApi } from '@wirehub/modules';

export function moduleApi(module: string): ModuleApi {
  return async (method, path, body) => {
    const response = await fetch(`/api/modules/${encodeURIComponent(module)}/${path.replace(/^\/+/, '')}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON: the text as it came
    }
    return { status: response.status, body: parsed };
  };
}
