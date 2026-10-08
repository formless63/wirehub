/** The base URL of the docs this hub points at: the public site, or the operator's own copy (`WIREHUB_DOCS_URL`). */

import { useQuery } from '@tanstack/react-query';

import { normalizeDocsBase } from '../help.ts';
import { fetchHub, hubKey } from '../hub-settings.browser.ts';

export function useDocsBase(): string {
  // the same query the New hub strip reads: one request, shared
  const hub = useQuery({ queryKey: hubKey, queryFn: () => fetchHub(), retry: false, staleTime: Infinity });
  return normalizeDocsBase(hub.data?.docsUrl);
}
