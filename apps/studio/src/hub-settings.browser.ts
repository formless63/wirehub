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
  return { welcomeDismissed: (out.ok && out.value.welcomeDismissed) || readLocal() };
}

/** Dismiss the strip for the whole hub; where the hub refuses, for this browser only. */
export async function dismissWelcome(base = '/api'): Promise<HubSettings> {
  const out = await request<HubSettings>(`${base}/settings/hub`, { method: 'PUT', body: { welcomeDismissed: true } });
  if (!out.ok) writeLocal();
  return { welcomeDismissed: true };
}
