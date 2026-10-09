/** The module ids allowed a rail item: the build's list (`modules.config.ts`) plus the owner's choice (Extensions › Installed). */

import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';

import { fetchHub, hubKey } from '../hub-settings.browser.ts';
import { allowedRailModules } from '../modules.browser.ts';

const NO_CLIENT = new QueryClient();

export function useRailModules(): readonly string[] {
  const client = useContext(QueryClientContext);
  const hub = useQuery({ queryKey: hubKey, queryFn: () => fetchHub(), retry: false, staleTime: Infinity, enabled: client !== undefined }, client ?? NO_CLIENT);
  const chosen = hub.data?.railModules ?? [];
  return chosen.length === 0 ? allowedRailModules : [...new Set([...allowedRailModules, ...chosen])];
}
