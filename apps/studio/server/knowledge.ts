/**
 * Linked knowledge (`specs/knowledge.md`): notes, decisions, attachments and project
 * collections, kept as catalog documents through the ordinary document change set — the same
 * seam on files (`packages/catalog/data/knowledge/…`) and on PostgreSQL (`studio.catalog_doc`).
 * Attachments are shared assets (content-addressed blobs). Notes reference records; they never
 * copy them. Every write needs the version it read (If-Match), like every other record.
 */
import { createHash } from 'node:crypto';

import {
  ATTACHMENT_MIMES,
  KNOWLEDGE_ID,
  MAX_ATTACHMENT_BYTES,
  PHOTO_MIMES,
  isItemRef,
  parseNoteInput,
  parseProjectInput,
  projectRecord,
  slugOf,
  summaryOfNote,
  summaryOfProject,
  type AttachmentMime,
  type KnowledgeIndex,
  type Note,
  type Project,
} from '../src/knowledge.ts';
// types only: api.ts imports this module, so a value import back would be a cycle at load time
import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import type { AssetMime } from './assets.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { stripPhotoMetadata } from './image-metadata.ts';
import { clip } from './webhooks/derive.ts';
import type { DomainEvent } from './webhooks/events.ts';
import { THUMBNAIL_SIZE, THUMBNAIL_VERSION, thumbnailOf } from './thumbnails.ts';

export const KNOWLEDGE_ROUTES = [
  'GET    /api/knowledge',
  'GET    /api/knowledge/notes?record=<item>',
  'POST   /api/knowledge/notes',
  'GET    /api/knowledge/notes/:id',
  'PUT    /api/knowledge/notes/:id',
  'DELETE /api/knowledge/notes/:id',
  'GET    /api/knowledge/projects',
  'POST   /api/knowledge/projects',
  'GET    /api/knowledge/projects/:id',
  'PUT    /api/knowledge/projects/:id',
  'DELETE /api/knowledge/projects/:id',
  'POST   /api/knowledge/attachments',
  'GET    /api/knowledge/files/:sha',
  'GET    /api/knowledge/files/:sha/thumb',
  'POST   /api/knowledge/strip-photo-metadata[?dryRun=1]   (owner: photos stored before uploads were stripped)',
] as const;

export const KNOWLEDGE_INDEX_PATH = 'data/knowledge/index.json';
export const notePath = (id: string): string => `data/knowledge/notes/${id}.json`;
export const projectPath = (id: string): string => `data/knowledge/projects/${id}.json`;

/** An attachment upload is a base64 file inside JSON: bigger than an ordinary document. */
export function isKnowledgeUploadPath(path: string): boolean {
  return (path.split('?')[0] ?? '').replace(/\/+$/, '') === '/api/knowledge/attachments';
}

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
const ok = (body: unknown, status = 200, headers?: Record<string, string>): ApiResponse => ({ status, body, ...(headers === undefined ? {} : { headers }) });
type Action = 'created' | 'saved' | 'deleted';
/** `note.changed` / `project.changed` for the outbound webhooks: ids and links, never the text. */
const noteEvent = (action: Action, note: Pick<Note, 'id' | 'title' | 'kind' | 'links'>): DomainEvent => ({ type: 'note.changed', subject: { kind: 'note', id: note.id, label: note.title }, summary: { action, kind: note.kind, links: clip(note.links.map((l) => l.record)) } });
const projectEvent = (action: Action, project: Pick<Project, 'id' | 'title' | 'items'>): DomainEvent => ({ type: 'project.changed', subject: { kind: 'project', id: project.id, label: project.title }, summary: { action, items: project.items.length } });
const withEvent = (response: ApiResponse, event: DomainEvent): ApiResponse => ({ ...response, events: [event] });
const notAllowed = (method: string, allowed: string[]): ApiResponse => ({ status: 405, body: { error: `${method} is not supported here.`, hint: `Use ${allowed.join(' or ')}.` }, headers: { Allow: allowed.join(', ') } });

async function readIndex(deps: WorkbenchDeps): Promise<KnowledgeIndex> {
  const value = (await deps.docs?.read(KNOWLEDGE_INDEX_PATH)) as Partial<KnowledgeIndex> | undefined;
  return { notes: value?.notes ?? [], projects: value?.projects ?? [] };
}

/** What the bytes are, from their first bytes: the client's word for it is not trusted. */
export function sniffAttachment(bytes: Uint8Array): AttachmentMime {
  const starts = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)) return 'application/zip';
  return 'application/octet-stream';
}

function freshId(title: string, taken: (id: string) => boolean): string {
  const base = slugOf(title);
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The photos of notes linked to a record: extra cover candidates for the shared cover resolver
 * (`representations.ts`). Photos never become geometry; they are only presentation choices.
 */
export async function knowledgePhotosFor(deps: WorkbenchDeps, record: string): Promise<{ asset: string; note: string; title: string; name: string }[]> {
  if (deps.docs === undefined) return [];
  const index = await readIndex(deps);
  const out: { asset: string; note: string; title: string; name: string }[] = [];
  for (const summary of index.notes) {
    if (!summary.links.includes(record) || summary.photos.length === 0) continue;
    const note = (await deps.docs.read(notePath(summary.id))) as Note | undefined;
    for (const a of note?.attachments ?? []) {
      if (PHOTO_MIMES.includes(a.mime) && !out.some((o) => o.asset === a.asset)) out.push({ asset: a.asset, note: summary.id, title: summary.title, name: a.name });
    }
  }
  return out;
}

/**
 * A note or project put back as a history restore recorded it (`history/api.ts`), or removed when
 * `value` is undefined; the index follows. The stored value was valid when it was saved. A restore
 * is a change: it is stamped now and by `who` (the restorer), keeping who created it and when.
 */
export async function restoreKnowledgeDoc(deps: WorkbenchDeps, type: 'note' | 'project', id: string, value: unknown, who?: string): Promise<{ value: unknown; events: DomainEvent[] }> {
  const docs = deps.docs;
  if (docs === undefined) return { value: undefined, events: [] };
  const index = await readIndex(deps);
  const path = type === 'note' ? notePath(id) : projectPath(id);
  const before = await docs.read(path);
  if (value === undefined) {
    await docs.remove(path);
    if (type === 'note') await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, notes: index.notes.filter((n) => n.id !== id) });
    else await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, projects: index.projects.filter((p) => p.id !== id) });
    const gone = before as Note & Project;
    return { value: undefined, events: before === undefined ? [] : [type === 'note' ? noteEvent('deleted', gone) : projectEvent('deleted', gone)] };
  }
  const stamped: Record<string, unknown> = { ...(value as Record<string, unknown>), id, updatedAt: new Date().toISOString() };
  if (who === undefined) delete stamped['updatedBy'];
  else stamped['updatedBy'] = who;
  if (type === 'note') {
    const note = stamped as unknown as Note;
    await docs.write(path, note);
    await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, notes: [...index.notes.filter((n) => n.id !== id), summaryOfNote(note)] });
    return { value: note, events: [noteEvent(before === undefined ? 'created' : 'saved', note)] };
  }
  const project = stamped as unknown as Project;
  await docs.write(path, project);
  await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, projects: [...index.projects.filter((p) => p.id !== id), summaryOfProject(project)] });
  return { value: project, events: [projectEvent(before === undefined ? 'created' : 'saved', project)] };
}

export async function handleKnowledgeRequest(request: ApiRequest, parts: string[], deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const [, , section, id, extra] = parts;
  const query = new URLSearchParams(request.path.split('?')[1] ?? '');
  if (deps.docs === undefined) return fail(501, 'This hub cannot keep notes.', 'Its storage has no document store.');
  const docs = deps.docs;
  const user = request.user ?? deps.localUser;
  if (method !== 'GET' && user?.role === 'viewer') return fail(403, 'Viewers can read notes but not change them.', 'Nothing was changed. Ask an owner for the editor role.');
  const who = user?.name;
  if (extra !== undefined && !(section === 'files' && extra === 'thumb')) return fail(404, 'There is nothing at that address.', KNOWLEDGE_ROUTES.join('; '));

  if (section === undefined) {
    if (method !== 'GET') return notAllowed(method, ['GET']);
    const index = await readIndex(deps);
    return ok(index, 200, { ETag: contentETag(index) });
  }

  if (section === 'strip-photo-metadata' && id === undefined) {
    const { handlePhotoRewrite } = await import('./photo-metadata-rewrite.ts');
    return handlePhotoRewrite(request, deps);
  }

  if (section === 'files' && id !== undefined) {
    if (method !== 'GET') return notAllowed(method, ['GET']);
    if (!/^[0-9a-f]{64}$/.test(id)) return fail(400, 'A file is named by the sha256 of its bytes.');
    if (extra === 'thumb') return thumbnail(deps, id);
    const found = await deps.assets?.get(id);
    if (found === undefined) return fail(404, `There is no stored file ${id}.`);
    const name = query.get('name') ?? found.record.originalName;
    // always a download with no sniffing and an empty, sandboxed policy: an attachment never runs in the app's origin
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || `${id.slice(0, 12)}.bin`;
    return { status: 200, body: null, bytes: new Uint8Array(found.bytes), contentType: found.record.mime, headers: {
      'content-disposition': `attachment; filename="${safe}"`, 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, max-age=31536000, immutable' } };
  }

  if (section === 'attachments' && id === undefined) {
    if (method !== 'POST') return notAllowed(method, ['POST']);
    if (deps.assets === undefined) return fail(501, 'This hub does not keep uploaded files.');
    const body = request.body as { name?: unknown; data?: unknown } | null;
    if (body === null || typeof body !== 'object' || typeof body.name !== 'string' || typeof body.data !== 'string') return fail(400, 'Send { name, data } with the file as base64.');
    const name = body.name.trim().replace(/[\\/]/g, '_').slice(0, 200);
    if (name === '') return fail(400, 'The file needs a name.');
    const sent = Buffer.from(body.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (sent.length === 0) return fail(400, 'The file is empty.');
    if (sent.length > MAX_ATTACHMENT_BYTES) return fail(413, `The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const mime = sniffAttachment(sent);
    if (!(ATTACHMENT_MIMES as readonly string[]).includes(mime)) return fail(415, 'That kind of file cannot be attached.');
    // a photo is stored without its metadata (EXIF/GPS, XMP, comments …), losslessly; one that cannot be cleaned is refused
    const stripped = stripPhotoMetadata(sent, mime, MAX_ATTACHMENT_BYTES);
    if (stripped !== undefined && !stripped.ok) return fail(422, stripped.reason, 'Photos are stored without their location and camera data; this one could not be read to remove it. Export it again (or as PNG) and retry.');
    const bytes = stripped === undefined ? sent : stripped.bytes;
    const stored = await deps.assets.put(bytes, mime as AssetMime, name, `Attached to a note${who === undefined ? '' : ` by ${who}`}${stripped?.ok === true && stripped.removed.length > 0 ? `; metadata removed on upload (${stripped.removed.join(', ')})` : ''}.`);
    return ok({ attachment: { asset: stored.id, name, mime, bytes: bytes.length }, ...(stripped?.ok === true ? { metadataRemoved: stripped.removed } : {}) }, 201);
  }

  if (section === 'notes') {
    if (id === undefined) {
      if (method === 'GET') {
        const record = query.get('record');
        const index = await readIndex(deps);
        if (record === null) return ok({ notes: index.notes });
        if (!isItemRef(record)) return fail(400, `${JSON.stringify(record)} is not an item reference.`, 'Name it as design:<id>, definition:<kind>:<id>, build:<name>, project:<id> or firmware:<id>.');
        const notes = [];
        for (const summary of index.notes.filter((n) => n.links.includes(record))) {
          const note = (await docs.read(notePath(summary.id))) as Note | undefined;
          if (note !== undefined) notes.push({ ...note, etag: contentETag(note) });
        }
        notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return ok({ record, notes });
      }
      if (method !== 'POST') return notAllowed(method, ['GET', 'POST']);
      const input = parseNoteInput(request.body);
      if (!input.ok) return fail(400, input.error, 'Nothing was written.');
      const index = await readIndex(deps);
      const noteId = freshId(input.value.title, (candidate) => index.notes.some((n) => n.id === candidate));
      const now = new Date().toISOString();
      const note: Note = { id: noteId, ...input.value, createdAt: now, ...(who === undefined ? {} : { createdBy: who }), updatedAt: now, ...(who === undefined ? {} : { updatedBy: who }) };
      await docs.write(notePath(noteId), note);
      await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, notes: [...index.notes, summaryOfNote(note)] });
      return withEvent(ok(note, 201, { ETag: contentETag(note) }), noteEvent('created', note));
    }
    if (!KNOWLEDGE_ID.test(id)) return fail(400, `${JSON.stringify(id)} is not a note id.`);
    const current = (await docs.read(notePath(id))) as Note | undefined;
    if (current === undefined) return fail(404, `There is no note ${id}.`);
    if (method === 'GET') return ok(current, 200, { ETag: contentETag(current) });
    if (method !== 'PUT' && method !== 'DELETE') return notAllowed(method, ['GET', 'PUT', 'DELETE']);
    const guard = checkIfMatch(request.headers?.['if-match'], contentETag(current), 'note', id);
    if (guard !== undefined) return guard;
    const index = await readIndex(deps);
    if (method === 'DELETE') {
      await docs.remove(notePath(id));
      await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, notes: index.notes.filter((n) => n.id !== id) });
      return withEvent(ok({ removed: id }), noteEvent('deleted', current));
    }
    const input = parseNoteInput(request.body);
    if (!input.ok) return fail(400, input.error, 'Nothing was written.');
    const { status: _s, tags: _t, ...kept } = current;
    const note: Note = { ...kept, ...input.value, id, updatedAt: new Date().toISOString(), ...(who === undefined ? {} : { updatedBy: who }) };
    await docs.write(notePath(id), note);
    await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, notes: [...index.notes.filter((n) => n.id !== id), summaryOfNote(note)] });
    return withEvent(ok(note, 200, { ETag: contentETag(note) }), noteEvent('saved', note));
  }

  if (section === 'projects') {
    if (id === undefined) {
      if (method === 'GET') return ok({ projects: (await readIndex(deps)).projects });
      if (method !== 'POST') return notAllowed(method, ['GET', 'POST']);
      const input = parseProjectInput(request.body);
      if (!input.ok) return fail(400, input.error, 'Nothing was written.');
      const index = await readIndex(deps);
      const projectId = freshId(input.value.title, (candidate) => index.projects.some((p) => p.id === candidate));
      const now = new Date().toISOString();
      const project: Project = { id: projectId, ...input.value, createdAt: now, ...(who === undefined ? {} : { createdBy: who }), updatedAt: now, ...(who === undefined ? {} : { updatedBy: who }) };
      await docs.write(projectPath(projectId), project);
      await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, projects: [...index.projects, summaryOfProject(project)] });
      return withEvent(ok(project, 201, { ETag: contentETag(project) }), projectEvent('created', project));
    }
    if (!KNOWLEDGE_ID.test(id)) return fail(400, `${JSON.stringify(id)} is not a project id.`);
    const current = (await docs.read(projectPath(id))) as Project | undefined;
    if (current === undefined) return fail(404, `There is no project ${id}.`);
    if (method === 'GET') {
      const index = await readIndex(deps);
      // the project's own notes: notes that link the project itself
      const notes = index.notes.filter((n) => n.links.includes(projectRecord(id))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      // notes about its items, for the item rows' counts
      const itemNotes = Object.fromEntries(current.items.map((item) => [item.record, index.notes.filter((n) => n.links.includes(item.record)).length]));
      return ok({ project: current, notes, itemNotes }, 200, { ETag: contentETag(current) });
    }
    if (method !== 'PUT' && method !== 'DELETE') return notAllowed(method, ['GET', 'PUT', 'DELETE']);
    const guard = checkIfMatch(request.headers?.['if-match'], contentETag(current), 'project', id);
    if (guard !== undefined) return guard;
    const index = await readIndex(deps);
    if (method === 'DELETE') {
      // its notes stay: they may link other records too; the dangling project link shows as removed
      await docs.remove(projectPath(id));
      await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, projects: index.projects.filter((p) => p.id !== id) });
      return withEvent(ok({ removed: id }), projectEvent('deleted', current));
    }
    const input = parseProjectInput(request.body);
    if (!input.ok) return fail(400, input.error, 'Nothing was written.');
    const project: Project = { ...current, ...input.value, id, updatedAt: new Date().toISOString(), ...(who === undefined ? {} : { updatedBy: who }) };
    await docs.write(projectPath(id), project);
    await docs.write(KNOWLEDGE_INDEX_PATH, { ...index, projects: [...index.projects.filter((p) => p.id !== id), summaryOfProject(project)] });
    return withEvent(ok(project, 200, { ETag: contentETag(project) }), projectEvent('saved', project));
  }

  return fail(404, 'There is nothing at that address.', KNOWLEDGE_ROUTES.join('; '));
}

/** A stored photo's gallery thumbnail: a small PNG with no metadata, drawn once and kept as derived data. */
async function thumbnail(deps: WorkbenchDeps, id: string): Promise<ApiResponse> {
  let png: Uint8Array | undefined;
  try {
    png = await thumbnailOf(id, async () => {
      const found = await deps.assets?.get(id);
      return found === undefined || !PHOTO_MIMES.includes(found.record.mime as AttachmentMime) ? undefined : { bytes: found.bytes, mime: found.record.mime };
    }, deps.thumbnails);
  } catch (error) {
    return fail(422, `No thumbnail could be drawn: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (png === undefined) return fail(404, `There is no stored photo ${id}.`);
  return { status: 200, body: null, bytes: png, contentType: 'image/png', headers: {
    ETag: `"${id}-${THUMBNAIL_SIZE}-${THUMBNAIL_VERSION}"`, 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=31536000, immutable' } };
}

/** A photo's cover lineage: the record identity and the photo's bytes. */
export function photoLineage(identity: unknown, asset: string): string {
  return createHash('sha256').update(JSON.stringify({ identity, view: 'note-photo', asset })).digest('hex');
}

