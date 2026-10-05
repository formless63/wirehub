/**
 * Who a studio commit is by, and what it says.
 *
 *   studio: <action> <record kind> <id>
 *
 *   <the user's version note / unlock reason, when there is one>
 *
 *   <what a design save changed, one line each, when the handler said —
 *    e.g. "~ moved w1:core-purple.center@b from j1:15 to j1:4 (note was: "…")">
 *
 *   Studio-Request: <METHOD> <path>
 *
 * The subject is derived from the route alone (plus the body's `id`/`newId`
 * where the path has none), so it needs no knowledge of any store.
 */

import type { StudioUser } from '../me.ts';

export interface GitIdentity {
  name: string;
  email: string;
}

/** The author of every commit made with the login off. */
export const LOCAL_AUTHOR: GitIdentity = { name: 'WireHub (local)', email: 'studio@localhost' };
/** The committer of every studio commit, whoever the author is. */
export const STUDIO_COMMITTER: GitIdentity = { name: 'WireHub', email: 'studio@localhost' };

/** The signed-in person (Better Auth session) — else the fixed local identity. */
export function commitAuthor(user: StudioUser | undefined): GitIdentity {
  if (user === undefined || user.source !== 'session' || user.email === undefined || user.email.trim() === '') return LOCAL_AUTHOR;
  const name = user.name.trim() === '' ? user.email : user.name.trim();
  return { name: oneLine(name), email: oneLine(user.email.trim()) };
}

const VERBS: Readonly<Record<string, string>> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/** A last path segment that names what happened rather than a record. */
const ACTIONS = new Set(['duplicate', 'rename', 'unlock', 'lock', 'branch', 'restore', 'publish', 'apply', 'reconsider', 'photo', 'anchors', 'entry-guides', 'upload']);

const KINDS: Readonly<Record<string, string>> = {
  designs: 'design',
  drawings: 'drawing',
  depictions: 'artwork',
  models: '3D model',
  vocab: 'vocab',
  tags: 'tags',
  'wire-library': 'wire library',
  'board-import': 'board import',
  builds: 'build',
  proposals: 'proposal',
  lineup: 'lineup',
  products: 'products',
};

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function field(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const got = (value as Record<string, unknown>)[key];
  return typeof got === 'string' && got.trim() !== '' ? oneLine(got) : undefined;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function singular(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

export interface SaveRequest {
  method: string;
  /** the request path, `/api/…`, query ignored */
  path: string;
  body?: unknown;
  /** the handler's response body, for ids only the server chose */
  responseBody?: unknown;
  /** what the save changed, as change-log lines (a design save:) */
  changes?: readonly string[];
}

/** At most this many change lines in one commit body; the rest are counted. */
const CHANGE_LINES = 40;

/** `update design xlr-mic-cable`, `rename design a → b`, `unlock version foo rev 2`… */
export function describeSave(request: SaveRequest): string {
  const method = request.method.toUpperCase();
  const parts = (request.path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map(decode);
  if (parts[0] === 'api') parts.shift();
  const head = parts.shift() ?? 'studio';
  // a module importer's accepted proposal: /api/modules/<module>/_import/<importer>
  if (head === 'modules' && parts[1] === '_import' && parts[0] !== undefined && parts[2] !== undefined) {
    return oneLine(`import ${field(request.body, 'fileName') ?? 'a file'} with ${parts[0]}/${parts[2]}`);
  }
  let kind = KINDS[head] ?? singular(head);
  let action = VERBS[method] ?? method.toLowerCase();
  const last = parts[parts.length - 1];
  if (last !== undefined && ACTIONS.has(last) && parts.length > 0) {
    parts.pop();
    action = last === 'photo' || last === 'anchors' || last === 'entry-guides' ? `update ${last}` : last;
  }

  if (head === 'definitions') {
    const k = parts.shift();
    kind = k === undefined ? (field(request.body, 'kind') ?? 'definition') : singular(k);
  }
  // /api/designs/:id/versions[/:rev|/drafts/:n]
  if (head === 'designs' && parts[1] === 'versions') {
    const [designId, , third, fourth] = parts;
    kind = 'version';
    if (third === undefined) action = method === 'POST' ? 'save' : action;
    const which = third === undefined ? '' : third === 'drafts' ? ` draft ${fourth ?? ''}` : ` rev ${third}`;
    parts.splice(0, parts.length, `${designId ?? ''}${which}`.trim());
  }

  let id = parts.join('/');
  if (id === '') {
    const response = request.responseBody as { design?: unknown } | undefined;
    id = field(request.body, 'id') ?? field(response, 'id') ?? field(response?.design, 'id') ?? '';
  }
  const target = field(request.body, 'newId');
  if (target !== undefined && (action === 'rename' || action === 'duplicate' || action === 'branch')) id = `${id} → ${target}`;
  return oneLine(`${action} ${kind} ${id}`);
}

/** The note a person typed for this save, when the route takes one. */
export function saveNote(request: SaveRequest): string | undefined {
  if (!/\/versions(\/|$)/.test(request.path)) return undefined;
  return field(request.body, 'note') ?? field(request.body, 'reason');
}

/** The whole commit message. */
export function commitMessage(request: SaveRequest): string {
  const note = saveNote(request);
  const path = request.path.split('?')[0] ?? request.path;
  const lines = (request.changes ?? []).map(oneLine).filter((line) => line !== '');
  const shown = lines.slice(0, CHANGE_LINES);
  const changes =
    shown.length === 0 ? [] : [[...shown, ...(lines.length > shown.length ? [`… and ${lines.length - shown.length} more`] : [])].join('\n')];
  return [
    `studio: ${describeSave(request)}`,
    ...(note === undefined ? [] : [note]),
    ...changes,
    `Studio-Request: ${request.method.toUpperCase()} ${path}`,
  ].join('\n\n');
}
