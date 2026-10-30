/**
 * What the history routes and agent checkpoints share (`api.ts`,
 * `checkpoints.ts`): answers, a subject's restorable parts as stored now and
 * their versions, a recorded state's value, and putting a drawing photo back.
 */

import { createHash } from 'node:crypto';

import { knowledgeDocPath, restorableParts, type Known, type Subject } from '../../src/history/types.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { decodeImageDataUri } from '../assets.ts';
import type { DefinitionKind } from '../definition-store.ts';
import { contentETag } from '../etag.ts';
import type { PhotoState } from './source.ts';

export type Route = (request: ApiRequest, deps: WorkbenchDeps) => Promise<ApiResponse>;

export function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

export const ok = (body: unknown, headers?: Record<string, string>): ApiResponse => ({ status: 200, body, ...(headers === undefined ? {} : { headers }) });

export function methodNotAllowed(method: string, allowed: string[]): ApiResponse {
  return fail(405, `${method} is not something this address accepts.`, `It answers ${allowed.join(' and ')}.`);
}

/** The current value of each restorable part, from the (staged) stores. */
export async function currentParts(subject: Subject, deps: WorkbenchDeps): Promise<Record<string, unknown>> {
  if (subject.type === 'design') {
    const design = await deps.designs.read(subject.id);
    const sheet = deps.drawings === undefined || design === undefined ? undefined : await deps.drawings.read(subject.id);
    // the photo's version is the hash of its bytes (what the history names it by); no photo: absent
    const decoded = sheet?.photo === undefined ? undefined : decodeImageDataUri(sheet.photo);
    const photo = decoded === undefined ? undefined : `sha256:${createHash('sha256').update(decoded.bytes).digest('hex')}`;
    return { design, drawing: sheet?.meta, photo };
  }
  if (subject.type === 'definition') {
    const record = (await deps.definitions?.list(subject.kind as DefinitionKind))?.find((r) => r.id === subject.id);
    return { record };
  }
  if (subject.type === 'note' || subject.type === 'project') return { record: (await deps.docs?.read(knowledgeDocPath(subject))) ?? undefined };
  if (subject.type === 'vocab') return { record: await deps.vocab?.read(subject.list) };
  return { record: await deps.builds?.read(subject.name) };
}

/** The parts a restore quotes the version of: the restorable ones, and for a design its photo (restored with it, by hash). */
export const quotedParts = (subject: Subject): string[] => (subject.type === 'design' ? [...restorableParts(subject), 'photo'] : restorableParts(subject));

export const etagOf = (value: unknown): string | null => (value === undefined ? null : contentETag(value));

/** The value a known state holds, or the refusal that it was not recorded. */
export function recorded(state: Known | 'current' | undefined, current: unknown): { ok: true; value: unknown } | { ok: false } {
  if (state === undefined || state === 'current') return { ok: true, value: current };
  return state.known ? { ok: true, value: state.value } : { ok: false };
}

/** PNG or JPEG, told by its first bytes (a stored photo carries no trusted type of its own). */
function imageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return undefined;
}

/** The drawing photo back to `wanted` (`restorePhoto`), or why not. */
export async function restorePhotoTo(id: string, wanted: PhotoState, deps: WorkbenchDeps): Promise<{ restored: boolean; skipped?: string }> {
  if (deps.drawings === undefined) return { restored: false };
  if (wanted === undefined) return { restored: false, skipped: 'The drawing photo was left as it is: the history did not record which photo that change left.' };
  if (wanted !== 'none' && 'unrestorable' in wanted) return { restored: false, skipped: wanted.unrestorable };
  const stored = await deps.drawings.read(id);
  const decoded = stored.photo === undefined ? undefined : decodeImageDataUri(stored.photo);
  const have = decoded === undefined ? 'none' : createHash('sha256').update(decoded.bytes).digest('hex');
  if (wanted === 'none') {
    if (have === 'none') return { restored: false };
    await deps.drawings.writePhoto(id, undefined);
    return { restored: true };
  }
  if (wanted.sha256 === have) return { restored: false };
  // a legacy per-design file comes with its bytes (read from git); the others are read by hash
  const bytes = wanted.bytes ?? (await deps.blobByHash?.(wanted.sha256));
  const mime = bytes === undefined ? undefined : (wanted.mime ?? imageMime(bytes));
  if (bytes === undefined || mime === undefined) return { restored: false, skipped: 'The drawing photo was not brought back: its file is no longer stored (the upload was removed from the hub), so only the rest of the design was restored.' };
  await deps.drawings.writePhoto(id, { mime, bytes: Buffer.from(bytes) });
  return { restored: true };
}
