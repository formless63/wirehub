/** Webhook events read off a request and its answer where the handler itself does not say (the pack lifecycle). */

import type { DomainEvent } from './events.ts';

/** `pack.installed` for a pack install, update or disable that went through. */
export function packEventOf(method: string, path: string, body: unknown): DomainEvent | undefined {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const parts = (path.split('?')[0] ?? '').split('/').filter((p) => p !== '');
  const pack = parts[2];
  if (b['installed'] === true && typeof b['id'] === 'string') {
    return { type: 'pack.installed', subject: { kind: 'pack', id: b['id'] }, summary: { action: b['kind'] === 'update' ? 'updated' : 'installed', ...(typeof b['version'] === 'string' ? { version: b['version'] } : {}) } };
  }
  if (b['updated'] === true && pack !== undefined && pack !== 'install') {
    return { type: 'pack.installed', subject: { kind: 'pack', id: pack }, summary: { action: 'updated', ...(typeof b['from'] === 'string' ? { from: b['from'] } : {}), ...(typeof b['to'] === 'string' ? { version: b['to'] } : {}) } };
  }
  if (method === 'DELETE' && typeof b['disabled'] === 'string') {
    return { type: 'pack.installed', subject: { kind: 'pack', id: b['disabled'] }, summary: { action: 'disabled', ...(typeof b['removed'] === 'number' ? { removed: b['removed'] } : {}) } };
  }
  return undefined;
}

const clean = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** `part-number.assigned` when `after` is a number `before` was not: set for the first time, or changed. */
export function pnAssignedEvent(subject: { kind: string; id: string; label?: string }, field: string, before: string | undefined, after: string | undefined): DomainEvent | undefined {
  const next = clean(after);
  const was = clean(before);
  if (next === undefined || next === was) return undefined;
  return { type: 'part-number.assigned', subject, summary: { field, partNumber: next, ...(was === undefined ? {} : { previous: was }) } };
}

/** The most lines a diff summary carries. */
export const MAX_SUMMARY_LINES = 30;

export const clip = (lines: readonly string[]): { lines: string[]; more?: number } => ({ lines: lines.slice(0, MAX_SUMMARY_LINES).map((l) => l.slice(0, 300)), ...(lines.length > MAX_SUMMARY_LINES ? { more: lines.length - MAX_SUMMARY_LINES } : {}) });
