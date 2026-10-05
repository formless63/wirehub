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
  /**
   * A hub with no organisation yet (the database backend): setup also
   * creates the organisation, its catalog and the admin. `admin` says how
   * the admin signs in: an email + password made here, the identity
   * provider, or no sign-in at all.
   */
  create?: { catalogs: ('starter' | 'empty')[]; admin: 'password' | 'oidc' | 'none'; minPassword: number };
}

/** What first-run setup creates on a hub with no organisation. */
export interface SetupCreate {
  org: { name: string; slug: string };
  catalog: 'starter' | 'empty';
  admin?: { name: string; email: string; password?: string };
}

export async function loadSetup(base = '/api'): Promise<Outcome<SetupView>> {
  return request<SetupView>(`${base}/setup`);
}

export async function saveSetup(modules: readonly string[], base = '/api', code?: string, create?: SetupCreate): Promise<Outcome<SetupView>> {
  return request<SetupView>(`${base}/setup`, { method: 'POST', body: { modules, ...(code === undefined ? {} : { code }), ...(create ?? {}) } });
}

/** Sign the admin in after setup made the account (the sign-in's own endpoint; sets the session cookie). */
export async function signInAdmin(email: string, password: string): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return response.ok;
  } catch {
    return false;
  }
}

/** A short name from an organisation's name: `Example Shop` → `example-shop`. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
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
