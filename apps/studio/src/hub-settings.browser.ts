/**
 * Small state that belongs to the hub, not to a browser (`GET`/`PUT /api/settings/hub`):
 * today whether the "New hub" strip was dismissed. A person who cannot write (a viewer)
 * or a hub that cannot be reached falls back to this browser's own memory of it.
 */

import type { Outcome } from '@wirehub/editor-react';
import { request } from './definitions.browser.ts';

export const hubKey = ['settings', 'hub'] as const;

export interface HubSettings {
  welcomeDismissed: boolean;
  /** where this hub's help links point, when its operator hosts the docs (`WIREHUB_DOCS_URL`); absent: the public site */
  docsUrl?: string;
  /** the modules the owner lets add an item to the rail (module `placement: 'rail'`) */
  railModules: string[];
}

const LOCAL = 'wirehub:welcome-dismissed';

function readLocal(): boolean {
  try {
    return window.localStorage.getItem(LOCAL) === '1';
  } catch {
    return false;
  }
}

function writeLocal(): void {
  try {
    window.localStorage.setItem(LOCAL, '1');
  } catch {
    // no storage: the strip simply comes back next time
  }
}

export async function fetchHub(base = '/api'): Promise<HubSettings> {
  const out: Outcome<HubSettings> = await request<HubSettings>(`${base}/settings/hub`, { method: 'GET' });
  const docsUrl = out.ok ? out.value.docsUrl : undefined;
  return { welcomeDismissed: (out.ok && out.value.welcomeDismissed) || readLocal(), railModules: out.ok ? (out.value.railModules ?? []) : [], ...(docsUrl === undefined ? {} : { docsUrl }) };
}

/** Dismiss the strip for the whole hub; where the hub refuses, for this browser only. */
export async function dismissWelcome(base = '/api'): Promise<HubSettings> {
  const out = await request<HubSettings>(`${base}/settings/hub`, { method: 'PUT', body: { welcomeDismissed: true } });
  if (!out.ok) writeLocal();
  return { welcomeDismissed: true, railModules: [] };
}

/** The owner's list of modules that may have a rail item; the server refuses anyone else. */
export async function saveRailModules(railModules: string[], base = '/api'): Promise<Outcome<HubSettings>> {
  return await request<HubSettings>(`${base}/settings/hub`, { method: 'PUT', body: { railModules } });
}
