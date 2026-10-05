/**
 * Edit locks — the vocabulary both halves share.
 *
 * A *record* is the unit one person edits at a time, named by a string key:
 *
 * - `design:<id>` — a cable: its working copy, its drawing details and
 *   document fields, and its released versions (all one editor screen).
 * - `definition:<kind>:<id>` — one library definition (connector, body,
 *   component, wire stock, board, shell/hardware, kit …). A wire stock's
 *   builder save and a record's tag corrections are the same record.
 * - `build:<name>` — one board build file.
 * - `vocab:<list>` — one controlled list.
 *
 * `recordsOfWrite` maps a mutating API request to the records it changes. The
 * server gate uses it to refuse a write to a record someone else holds (423);
 * the browser uses the very same function to attach the lock token it holds,
 * so the two can never disagree on what a URL touches. Pure, no IO — this
 * file is imported by both `server/` and the browser bundle.
 */

/** the request header a write carries its lock token(s) in (comma-separated) */
export const LOCK_HEADER = 'x-edit-lock';

/** how often a holder renews its lease */
export const HEARTBEAT_MS = 15_000;
/** a lease lapses this long after its last heartbeat */
export const LEASE_MS = 60_000;

/**
 * The library kinds a definition record can be. Mirrors
 * `server/definition-store.ts`'s `DEFINITION_KINDS` (a test holds them equal)
 * — copied, not imported, so the browser bundle never reaches into `server/`.
 */
export const LOCKABLE_DEFINITION_KINDS = [
  'connectors',
  'components',
  'wires',
  'pcbas',
  'bodies',
  'interfaces',
  'mechanicals',
  'kits',
] as const;

export const designRecord = (id: string): string => `design:${id}`;
export const definitionRecord = (kind: string, id: string): string => `definition:${kind}:${id}`;
export const buildRecord = (name: string): string => `build:${name}`;
export const vocabRecord = (list: string): string => `vocab:${list}`;

/** A record key a client may name: a known prefix and kebab-ish segments, nothing path-like. */
const RECORD = /^(design|definition|build|vocab):[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)?$/;

export function isRecordKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && RECORD.test(value);
}

/** Who holds (or asks for) a record, as everyone else sees them. */
export interface LockHolderView {
  /** the name shown to others — the signed-in user, or this browser's chosen name */
  name: string;
  /** this browser (localStorage) — two tabs of one browser share it */
  clientId: string;
  /** this page load — two tabs are two holders */
  tabId: string;
}

/** A lock as the list, the banner and a 423 show it. Never carries the token. */
export interface LockView {
  record: string;
  holder: LockHolderView;
  /** ISO time the current holder took it */
  since: string;
  /** ISO time of the last heartbeat */
  seenAt: string;
  /** ISO time the lease lapses without another heartbeat */
  expiresAt: string;
  /** someone asked for it ("Request edit"), not yet answered */
  request?: { name: string; clientId: string; tabId: string; at: string };
  /** the holder answered a request with Keep */
  declined?: { name: string; tabId: string; at: string };
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The records a request changes — `[]` for a read, for a create (a new record
 * has nobody to collide with), and for anything that is not a record edit.
 * `body` is only consulted for the lineup's and the products' batch apply.
 */
export function recordsOfWrite(method: string, path: string, body?: unknown): string[] {
  const verb = method.toUpperCase();
  if (!WRITE.has(verb)) return [];
  const parts = (path.split('?')[0] ?? '').split('/').filter((p) => p !== '').map(decode);
  if (parts[0] !== 'api') return [];
  const [, head, a, b, c] = parts;
  switch (head) {
    case 'designs':
      if (a === undefined) return [];
      // duplicate reads its source and writes a new id: not an edit of `a`
      if (b === 'duplicate') return [];
      return [designRecord(a)];
    case 'drawings':
      return a === undefined ? [] : [designRecord(a)];
    case 'definitions':
      return a === undefined || b === undefined || c !== undefined ? [] : [definitionRecord(a, b)];
    case 'tags':
      return a === undefined || b === undefined ? [] : [definitionRecord(a, b)];
    case 'models':
      // a record's 3D model (attach, upload, detach) is an edit of that record
      return a === undefined || b === undefined ? [] : [definitionRecord(a, b)];
    case 'wire-library':
      return a === 'stocks' && b !== undefined ? [definitionRecord('wires', b)] : [];
    case 'builds':
      return a === undefined ? [] : [buildRecord(a)];
    case 'vocab':
      return a === undefined ? [] : [vocabRecord(a)];
    case 'depictions':
      // artwork is keyed by definition id alone: it belongs to whichever
      // library record of that id is being edited
      return a === undefined ? [] : LOCKABLE_DEFINITION_KINDS.map((kind) => definitionRecord(kind, a));
    case 'products': {
      // a product change set: every existing design it changes — a create (no etag) collides with nobody
      if (a !== 'apply') return [];
      const changes = typeof body === 'object' && body !== null ? (body as { changes?: unknown }).changes : undefined;
      if (!Array.isArray(changes)) return [];
      return changes.flatMap((entry) => {
        const c = (typeof entry === 'object' && entry !== null ? entry : {}) as { id?: unknown; etag?: unknown };
        return typeof c.id === 'string' && c.etag !== undefined ? [designRecord(c.id)] : [];
      });
    }
    case 'lineup': {
      if (a !== 'apply') return [];
      const update = (typeof body === 'object' && body !== null ? (body as { update?: unknown }).update : undefined);
      if (!Array.isArray(update)) return [];
      return update.flatMap((entry) => {
        const id = (entry as { design?: { id?: unknown } } | null)?.design?.id;
        return typeof id === 'string' ? [designRecord(id)] : [];
      });
    }
    default:
      return [];
  }
}

/** The tokens a `x-edit-lock` header carries. */
export function tokensOf(header: string | null | undefined): string[] {
  if (header === null || header === undefined) return [];
  return header
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}
