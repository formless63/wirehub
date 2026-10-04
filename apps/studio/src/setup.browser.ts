/**
 * First-run setup, as the browser sees it (`GET`/`POST /api/setup`,
 * `server/setup.ts`): which domain modules the build offers, which are
 * enabled, and whether setup still has to run.
 */

import { request } from './definitions.browser.ts';
import type { Outcome } from '@wirehub/editor-react';

export interface SetupPack {
  id: string;
  label: string;
  version: string;
  license?: string;
  installed: boolean;
}

export interface SetupDomain {
  id: string;
  label: string;
  version: string;
  license?: string;
  description: string;
  suggested: boolean;
  enabled: boolean;
  packs: SetupPack[];
}

export interface SetupView {
  needed: boolean;
  completed: boolean;
  /** the server asks for the one-time setup code it printed to its log */
  codeRequired?: boolean;
  domains: SetupDomain[];
  suggestions: { label: string; description: string }[];
}

export async function loadSetup(base = '/api'): Promise<Outcome<SetupView>> {
  return request<SetupView>(`${base}/setup`);
}

export async function saveSetup(modules: readonly string[], base = '/api', code?: string): Promise<Outcome<SetupView>> {
  return request<SetupView>(`${base}/setup`, { method: 'POST', body: { modules, ...(code === undefined ? {} : { code }) } });
}

/** Whether the hub should open on /setup: only when the server says so; any failure means no. */
export async function setupNeeded(base = '/api'): Promise<boolean> {
  try {
    const out = await loadSetup(base);
    return out.ok && out.value.needed;
  } catch {
    return false;
  }
}
