/** The base URL of the docs this hub points at: the public site, or the operator's own copy (`WIREHUB_DOCS_URL`). */

import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';

import { normalizeDocsBase } from '../help.ts';
import { fetchHub, hubKey } from '../hub-settings.browser.ts';

/** Stands in outside a QueryClientProvider (an isolated render): never asked anything, so the public base answers. */
const NO_CLIENT = new QueryClient();

export function useDocsBase(): string {
  const client = useContext(QueryClientContext);
  // the same query the New hub strip reads: one request, shared
  const hub = useQuery({ queryKey: hubKey, queryFn: () => fetchHub(), retry: false, staleTime: Infinity, enabled: client !== undefined }, client ?? NO_CLIENT);
  return normalizeDocsBase(hub.data?.docsUrl);
}
