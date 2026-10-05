/** Revisions of library records over the workbench API (`server/revisions.ts`): the editor's `RevisionsAdapter`. */

import type { Outcome, RevisionsAdapter, RevisionsView } from '@wirehub/editor-react';
import type { RecordRevision } from '@wirehub/model';

import { request } from './definitions.browser.ts';

const path = (base: string, kind: string, id: string): string => `${base}/revisions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;

export function workbenchRevisions(base = '/api'): RevisionsAdapter {
  return {
    list: (kind, id) => request<RevisionsView>(path(base, kind, id)),
    read: (kind, id, rev) => request<RecordRevision>(`${path(base, kind, id)}/${rev}`),
    save: (kind, id, input) => request<RevisionsView>(path(base, kind, id), { method: 'POST', body: input }) as Promise<Outcome<RevisionsView>>,
    nextNumber: (kind, id) => request<{ suggestion: { pn: string; explanation?: string } }>(`${path(base, kind, id)}/next-number`),
  };
}
