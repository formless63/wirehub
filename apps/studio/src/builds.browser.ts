/**
 * The build editor's `/api/builds` over `fetch`. The
 * copy's version travels as `If-Match`, so a save never overwrites a build
 * file someone else changed since it was read. Nothing here throws.
 */

import type { BuildsAdapter, BuildsFileView } from '@wirehub/editor-react';
import type { BoardBuilds } from '@wirehub/model';

import { request } from './definitions.browser.ts';

export function workbenchBuilds(base = '/api'): BuildsAdapter {
  return {
    list: () => request<{ files: BuildsFileView[] }>(`${base}/builds`),
    save: (name: string, file: BoardBuilds, etag?: string) =>
      request<BuildsFileView & { created: boolean }>(`${base}/builds/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: { file },
        ...(etag === undefined ? {} : { headers: { 'if-match': etag } }),
      }),
  };
}
