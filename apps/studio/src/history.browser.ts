/**
 * Change history as the browser reads it (`/api/history`, `server/history/`):
 * the hub's entries, a record's entries, one entry's before and after, and a
 * restore. Nothing here throws — every call answers `ok` or the server's
 * sentence. Writes go through `fetch`, which the edit-lock client wraps, so a
 * restore carries the lock this tab holds on its record.
 */

import type { HistoryEntryDetail, HistoryKind, HistoryPage, RestoreAnswer } from './history/types.ts';

export type HistoryAnswer<T> = { ok: true; value: T } | { ok: false; status: number; error: string; hint?: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<HistoryAnswer<T>> {
  try {
    const response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status >= 400) {
      const issues = Array.isArray(parsed['issues']) ? (parsed['issues'] as { message?: string }[]) : [];
      const hint = typeof parsed['hint'] === 'string' && parsed['hint'] !== '' ? parsed['hint'] : issues[0]?.message;
      return { ok: false, status: response.status, error: typeof parsed['error'] === 'string' ? parsed['error'] : `That failed (HTTP ${response.status}).`, ...(hint === undefined ? {} : { hint }) };
    }
    return { ok: true, value: parsed as T };
  } catch {
    return { ok: false, status: 0, error: 'WireHub could not be reached.' };
  }
}

export interface HubHistoryQuery {
  person?: string;
  from?: string;
  to?: string;
  kind?: HistoryKind;
  before?: string;
  limit?: number;
}

export function fetchHubHistory(query: HubHistoryQuery = {}): Promise<HistoryAnswer<HistoryPage>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return call('GET', `/api/history${text === '' ? '' : `?${text}`}`);
}

export function fetchRecordHistory(subject: string, before?: string): Promise<HistoryAnswer<HistoryPage>> {
  return call('GET', `/api/history/records/${encodeURIComponent(subject)}${before === undefined ? '' : `?before=${encodeURIComponent(before)}`}`);
}

export function fetchHistoryEntry(id: string, subject?: string): Promise<HistoryAnswer<HistoryEntryDetail>> {
  return call('GET', `/api/history/entries/${encodeURIComponent(id)}${subject === undefined ? '' : `?subject=${encodeURIComponent(subject)}`}`);
}

/** Restore `subject` to its state after `entry`, quoting the versions the person saw (`detail.current`). */
export function restoreRecord(subject: string, entry: string, current: Record<string, string | null>): Promise<HistoryAnswer<RestoreAnswer>> {
  return call('POST', `/api/history/records/${encodeURIComponent(subject)}/restore`, { entry, current });
}

export const historyKey = (...parts: string[]): readonly string[] => ['studio', 'history', ...parts];

/** `2026-10-05 14:03` in the viewer's time zone. */
export function historyTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
