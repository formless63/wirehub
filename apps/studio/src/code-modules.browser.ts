/**
 * Runtime code modules in the browser (`specs/runtime-modules.md` §3): the
 * page loads the browser entries of the modules the server runs — each fetched
 * from its content-addressed URL, its sha256 checked against the integrity the
 * server lists, imported from a blob URL — composes them over the built-in
 * modules and swaps the live registry, so panels, routes and exporters appear
 * without a reload. Old code cannot be unloaded from a page: when a module that
 * ran here goes away or is replaced, `needsRefresh` says so.
 *
 * Also the API client for Settings → Code modules and Restart WireHub.
 */

import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';

import { composeRegistry, forRuntime, pickModuleExport, type LiveModuleRegistry, type WireHubModule } from '@wirehub/modules';

export interface BrowserModuleEntry {
  id: string;
  version: string;
  js: { url: string; integrity: string };
  css?: { url: string; integrity: string };
  commitHook: boolean;
}

export interface RuntimeLoadResult {
  /** modules registered now, by id */
  loaded: string[];
  /** modules that could not be loaded here, with why */
  failed: { id: string; error: string }[];
  /** a module that ran in this page went away or was replaced: a refresh finishes unloading it */
  needsRefresh: string[];
  /** the registry was swapped */
  changed: boolean;
}

/** The host's React, for the modules' code (`wirehub-module build` reaches it through this global). */
export function shareHostModules(): void {
  const g = globalThis as { __wirehub?: { shared?: Record<string, unknown> } };
  g.__wirehub ??= {};
  g.__wirehub.shared = { ...(g.__wirehub.shared ?? {}), react: React, 'react/jsx-runtime': JsxRuntime, 'react/jsx-dev-runtime': JsxRuntime, 'react-dom': ReactDom, 'react-dom/client': ReactDomClient };
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function verified(url: string, integrity: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await fetchImpl(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (`sha256-${toBase64(digest)}` !== integrity) throw new Error(`${url} does not match its integrity`);
  return bytes;
}

export interface RuntimeLoaderOptions {
  live: LiveModuleRegistry;
  builtins: readonly WireHubModule[];
  fetch?: typeof fetch;
  /** how a verified entry becomes a module namespace (tests import it another way); default: a blob URL */
  importCode?: (code: Uint8Array, entry: BrowserModuleEntry) => Promise<Record<string, unknown>>;
  base?: string;
}

const blobImport = async (code: Uint8Array): Promise<Record<string, unknown>> => {
  const url = URL.createObjectURL(new Blob([code as BlobPart], { type: 'text/javascript' }));
  try {
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }
};

let defaultImporter: (code: Uint8Array, entry: BrowserModuleEntry) => Promise<Record<string, unknown>> = blobImport;

/** Replace how the page turns a verified entry into a module (a test environment with no blob-URL imports). */
export function setModuleImporter(importer: (code: Uint8Array, entry: BrowserModuleEntry) => Promise<Record<string, unknown>>): void {
  defaultImporter = importer;
}

/** The page's runtime-module loader: `sync()` brings the registry in step with the server's list. */
export function createRuntimeLoader(options: RuntimeLoaderOptions): { sync(): Promise<RuntimeLoadResult> } {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const importCode = options.importCode ?? ((code: Uint8Array, entry: BrowserModuleEntry) => defaultImporter(code, entry));
  const base = options.base ?? '/api';
  /** what runs here, by id: the integrity of its entry and the module */
  const running = new Map<string, { integrity: string; module: WireHubModule; commitHook: boolean; style?: HTMLLinkElement }>();
  let chain: Promise<RuntimeLoadResult> = Promise.resolve({ loaded: [], failed: [], needsRefresh: [], changed: false });
  const once = async (): Promise<RuntimeLoadResult> => {
    let entries: BrowserModuleEntry[];
    try {
      const response = await fetchImpl(`${base}/code-modules/browser`, { credentials: 'same-origin' });
      if (!response.ok) return { loaded: [...running.keys()], failed: [], needsRefresh: [], changed: false };
      entries = ((await response.json()) as { modules?: BrowserModuleEntry[] }).modules ?? [];
    } catch {
      return { loaded: [...running.keys()], failed: [], needsRefresh: [], changed: false };
    }
    const failed: { id: string; error: string }[] = [];
    const needsRefresh: string[] = [];
    let changed = false;
    // gone or replaced: out of the registry now; its code stays in the page until a refresh
    for (const [id, was] of [...running]) {
      const now = entries.find((e) => e.id === id);
      if (now !== undefined && now.js.integrity === was.integrity) continue;
      running.delete(id);
      was.style?.remove();
      changed = true;
      needsRefresh.push(id);
    }
    for (const entry of entries) {
      if (running.has(entry.id)) continue;
      try {
        const code = await verified(entry.js.url, entry.js.integrity, fetchImpl);
        const namespace = await importCode(code, entry);
        const module = pickModuleExport(namespace, entry.id);
        if (module === undefined) throw new Error(`its browser entry exports no module '${entry.id}'`);
        let style: HTMLLinkElement | undefined;
        if (entry.css !== undefined && typeof document !== 'undefined') {
          style = document.createElement('link');
          style.rel = 'stylesheet';
          style.href = entry.css.url;
          style.integrity = entry.css.integrity;
          style.dataset['module'] = entry.id;
          document.head.appendChild(style);
        }
        running.set(entry.id, { integrity: entry.js.integrity, module: forRuntime(module), commitHook: entry.commitHook, ...(style === undefined ? {} : { style }) });
        changed = true;
      } catch (error) {
        failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (changed) {
      const composed = composeRegistry(options.builtins, [...running.values()].map((r) => r.module));
      for (const refused of composed.refused) failed.push({ id: refused.id, error: refused.problems.join('; ') });
      options.live.replace(composed.registry);
    }
    return { loaded: [...running.keys()], failed, needsRefresh, changed };
  };
  return {
    sync() {
      chain = chain.then(once, once);
      return chain;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Settings → Code modules, and Restart WireHub
 * ------------------------------------------------------------------ */

export interface CodeModuleStatusView {
  id: string;
  version: string;
  label: string;
  pack: { id: string; version: string };
  apiVersion: string;
  extensionPoints: string[];
  permissions: string[];
  trust?: { via: 'store' | 'pinned'; keys: string[] };
  enabled: boolean;
  enabledBy?: string;
  enabledOn?: string;
  state: 'loaded' | 'disabled' | 'off' | 'failed' | 'refused' | 'pending';
  error?: string;
  apply: 'live' | 'restart';
  restartPoints: string[];
  restartPending: boolean;
}

export interface CodeModulesView {
  apiVersion: string;
  allowed: { env: boolean; settings: boolean; effective: boolean };
  builtins: string[];
  supervised: boolean;
  modules: CodeModuleStatusView[];
  keys: { key: string; keyId: string; fingerprint: string; label?: string; by?: string; on?: string }[];
}

/** What a pack's install preview says about the code it carries (`server/code-modules/trust.ts`). */
export interface CodePreviewView {
  module: { id: string; version: string; label: string; apiVersion: string; description?: string };
  extensionPoints: string[];
  permissions: string[];
  apply: 'live' | 'restart';
  trust: { via: 'store' | 'pinned'; keys: { key: string; keyId: string; fingerprint: string }[] };
  warning: string;
  consent: string;
}

export type Answer<T> = { ok: true; value: T } | { ok: false; status: number; message: string; hint?: string };

async function request<T>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  try {
    const response = await fetch(path, { method, credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, status: response.status, message: typeof parsed['error'] === 'string' ? parsed['error'] : `That failed (HTTP ${response.status}).`, ...(typeof parsed['hint'] === 'string' ? { hint: parsed['hint'] } : {}) };
    return { ok: true, value: parsed as T };
  } catch (error) {
    return { ok: false, status: 0, message: 'WireHub could not reach the server.', hint: error instanceof Error ? error.message : String(error) };
  }
}

export const codeModulesKey = ['settings', 'code-modules'] as const;
export const fetchCodeModules = (base = '/api'): Promise<Answer<CodeModulesView>> => request('GET', `${base}/code-modules`);
export const setModuleEnabled = (id: string, enabled: boolean, base = '/api'): Promise<Answer<{ module?: CodeModuleStatusView; apply: 'live' | 'restart' }>> =>
  request('POST', `${base}/code-modules/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`);
export const setCodeAllowed = (allow: boolean, base = '/api'): Promise<Answer<{ allow: boolean }>> => request('PUT', `${base}/code-modules/settings`, { allow });
export const pinKey = (key: string, label: string, base = '/api'): Promise<Answer<unknown>> => request('POST', `${base}/code-modules/keys`, { key, ...(label.trim() === '' ? {} : { label: label.trim() }) });
export const unpinKey = (keyId: string, base = '/api'): Promise<Answer<unknown>> => request('DELETE', `${base}/code-modules/keys/${encodeURIComponent(keyId)}`);
export const fetchBoot = (base = '/api'): Promise<Answer<{ bootId: string; restarting: boolean; supervised: boolean }>> => request('GET', `${base}/system/boot`);
export const requestRestart = (base = '/api'): Promise<Answer<{ restarting: boolean; bootId: string; supervised: boolean; poll?: string; hint?: string }>> => request('POST', `${base}/system/restart`, {});

/**
 * Wait for the server to come back with another boot id (Restart WireHub): `true`
 * once it has, `false` after `timeoutMs`. Polls every `everyMs`.
 */
export async function waitForRestart(previous: string, options: { timeoutMs?: number; everyMs?: number; base?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const until = Date.now() + (options.timeoutMs ?? 180_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  while (Date.now() < until) {
    await sleep(options.everyMs ?? 1500);
    const boot = await fetchBoot(options.base);
    if (boot.ok && boot.value.bootId !== previous && !boot.value.restarting) return true;
  }
  return false;
}
