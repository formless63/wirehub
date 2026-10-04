/**
 * The studio's `VocabAdapter`: the controlled lists and the tag side table,
 * over `fetch` (data model v2 §5).
 *
 *   POST /api/vocab/:list      append one entry (append-only, `src` required)
 *   PUT  /api/tags/:kind/:id   one record's tags → review corrections → the table rebuilt
 *
 * Nothing here throws; a refusal comes back as a sentence, a next step and the
 * validator's issues, exactly like the definitions adapter next door.
 */

import type { NewVocabEntry, RecordTags, SavedTags, VocabAdapter } from '@cable-studio/editor-react';
import type { VocabEntry, VocabList } from '@cable-studio/model';

import { request } from './definitions.browser.ts';

export function workbenchVocab(base = '/api'): VocabAdapter {
  return {
    append: (list: string, entry: NewVocabEntry) =>
      request<{ entry: VocabEntry; list: VocabList }>(`${base}/vocab/${encodeURIComponent(list)}`, {
        method: 'POST',
        body: entry,
      }),
    saveTags: (tags: RecordTags) =>
      request<SavedTags>(`${base}/tags/${tags.kind}/${encodeURIComponent(tags.id)}`, {
        method: 'PUT',
        body: { tags: tags.tags },
      }),
  };
}
