/**
 * Linked knowledge (`specs/knowledge.md`): notes, decisions and project collections that point
 * at existing records by reference. Pure and shared by the server and the browser bundle.
 *
 * An item reference is the record key the edit locks and history already use
 * (`design:<id>`, `definition:<kind>:<id>`, `build:<name>`, `vocab:<list>`), plus
 * `project:<id>` for a project collection. A note never copies what it points at.
 */
import { isRecordKey } from './locks/records.ts';

export const NOTE_KINDS = ['note', 'decision'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export const PROJECT_STATUSES = ['active', 'paused', 'done'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Attachment media the asset store keeps. Images are photos (cover candidates); the rest are files. */
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'application/pdf', 'application/zip', 'application/octet-stream'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];
export const PHOTO_MIMES: readonly AttachmentMime[] = ['image/png', 'image/jpeg'];
export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

export interface ItemRef {
  record: string;
}

export interface Attachment {
  /** sha256 of the bytes: the shared asset's id */
  asset: string;
  name: string;
  mime: AttachmentMime;
  bytes: number;
  caption?: string;
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  /** markdown; rendered without raw HTML */
  body: string;
  /** decisions only */
  status?: DecisionStatus;
  links: ItemRef[];
  attachments: Attachment[];
  tags?: string[];
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface Project {
  id: string;
  title: string;
  summary: string;
  status: ProjectStatus;
  /** references to existing reusable records; never copies */
  items: (ItemRef & { note?: string })[];
  attachments: Attachment[];
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface NoteSummary {
  id: string;
  kind: NoteKind;
  title: string;
  status?: DecisionStatus;
  links: string[];
  tags?: string[];
  /** image assets, in order: cover candidates for linked records */
  photos: string[];
  files: number;
  /** plain text of the body, truncated: what search reads */
  text: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  items: string[];
  text: string;
  updatedAt: string;
}

export interface KnowledgeIndex {
  notes: NoteSummary[];
  projects: ProjectSummary[];
}

export const EMPTY_INDEX: KnowledgeIndex = { notes: [], projects: [] };
export const KNOWLEDGE_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const PROJECT_REF = /^project:[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const SHA = /^[0-9a-f]{64}$/;

export const projectRecord = (id: string): string => `project:${id}`;
const FIRMWARE_REF = /^firmware:[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const firmwareRecord = (id: string): string => `firmware:${id}`;
export function isItemRef(value: unknown): value is string {
  return isRecordKey(value) || (typeof value === 'string' && (PROJECT_REF.test(value) || (FIRMWARE_REF.test(value) && value.length <= 89)));
}

/** A readable id from a title: kebab-case, at most 48 characters, never empty. */
export function slugOf(title: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return slug === '' ? 'item' : slug;
}

/** Markdown reduced to searchable text (no markup characters), at most `max` characters. */
export function plainText(markdown: string, max = 2000): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function summaryOfNote(note: Note): NoteSummary {
  return {
    id: note.id, kind: note.kind, title: note.title,
    ...(note.status === undefined ? {} : { status: note.status }),
    links: note.links.map((l) => l.record),
    ...(note.tags === undefined || note.tags.length === 0 ? {} : { tags: note.tags }),
    photos: note.attachments.filter((a) => PHOTO_MIMES.includes(a.mime)).map((a) => a.asset),
    files: note.attachments.filter((a) => !PHOTO_MIMES.includes(a.mime)).length,
    text: plainText(note.body),
    updatedAt: note.updatedAt,
  };
}

export function summaryOfProject(project: Project): ProjectSummary {
  return { id: project.id, title: project.title, status: project.status, items: project.items.map((i) => i.record), text: plainText(project.summary, 600), updatedAt: project.updatedAt };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

function parseAttachments(value: unknown): Parsed<Attachment[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > 50) return { ok: false, error: 'attachments is a list of at most 50 files.' };
  const out: Attachment[] = [];
  for (const a of value) {
    if (!obj(a) || typeof a.asset !== 'string' || !SHA.test(a.asset)) return { ok: false, error: 'Each attachment names an uploaded asset by its sha256.' };
    if (!(ATTACHMENT_MIMES as readonly unknown[]).includes(a.mime)) return { ok: false, error: `${String(a.mime)} is not a kind of attachment this hub keeps.` };
    const name = text(a.name, 200)?.trim();
    if (name === undefined || name === '') return { ok: false, error: 'Each attachment has a file name.' };
    const caption = a.caption === undefined ? undefined : text(a.caption, 500);
    if (a.caption !== undefined && caption === undefined) return { ok: false, error: 'A caption is at most 500 characters.' };
    out.push({ asset: a.asset, name, mime: a.mime as AttachmentMime, bytes: typeof a.bytes === 'number' && a.bytes >= 0 ? Math.floor(a.bytes) : 0, ...(caption === undefined || caption === '' ? {} : { caption }) });
  }
  return { ok: true, value: out };
}

function parseRefs(value: unknown, field: string, max: number): Parsed<{ record: string; note?: string }[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > max) return { ok: false, error: `${field} is a list of at most ${max} references.` };
  const seen = new Set<string>();
  const out: { record: string; note?: string }[] = [];
  for (const ref of value) {
    const record = typeof ref === 'string' ? ref : obj(ref) ? ref.record : undefined;
    if (!isItemRef(record)) return { ok: false, error: `${JSON.stringify(record)} is not an item reference.`.slice(0, 200) };
    if (seen.has(record)) continue;
    seen.add(record);
    const note = obj(ref) ? text(ref.note, 300) : undefined;
    out.push({ record, ...(note === undefined || note === '' ? {} : { note }) });
  }
  return { ok: true, value: out };
}

/** The editable fields of a note, from a request body. Server-owned fields are ignored. */
export function parseNoteInput(body: unknown): Parsed<Pick<Note, 'kind' | 'title' | 'body' | 'links' | 'attachments'> & { status?: DecisionStatus; tags?: string[] }> {
  if (!obj(body)) return { ok: false, error: 'Send the note as a JSON object.' };
  const kind = body.kind ?? 'note';
  if (!(NOTE_KINDS as readonly unknown[]).includes(kind)) return { ok: false, error: 'kind is note or decision.' };
  const title = text(body.title, 200)?.trim();
  if (title === undefined || title === '') return { ok: false, error: 'A note has a title of at most 200 characters.' };
  const markdown = body.body === undefined ? '' : text(body.body, 100_000);
  if (markdown === undefined) return { ok: false, error: 'body is markdown text of at most 100 000 characters.' };
  let status: DecisionStatus | undefined;
  if (kind === 'decision') {
    const s = body.status ?? 'proposed';
    if (!(DECISION_STATUSES as readonly unknown[]).includes(s)) return { ok: false, error: `A decision's status is one of ${DECISION_STATUSES.join(', ')}.` };
    status = s as DecisionStatus;
  }
  const links = parseRefs(body.links, 'links', 100);
  if (!links.ok) return links;
  const attachments = parseAttachments(body.attachments);
  if (!attachments.ok) return attachments;
  let tags: string[] | undefined;
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20 || !body.tags.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= 40)) return { ok: false, error: 'tags is a list of at most 20 short words.' };
    tags = [...new Set((body.tags as string[]).map((t) => t.trim()))];
  }
  return { ok: true, value: { kind: kind as NoteKind, title, body: markdown, links: links.value.map((l) => ({ record: l.record })), attachments: attachments.value, ...(status === undefined ? {} : { status }), ...(tags === undefined ? {} : { tags }) } };
}

export function parseProjectInput(body: unknown): Parsed<Pick<Project, 'title' | 'summary' | 'status' | 'items' | 'attachments'>> {
  if (!obj(body)) return { ok: false, error: 'Send the project as a JSON object.' };
  const title = text(body.title, 200)?.trim();
  if (title === undefined || title === '') return { ok: false, error: 'A project has a title of at most 200 characters.' };
  const summary = body.summary === undefined ? '' : text(body.summary, 50_000);
  if (summary === undefined) return { ok: false, error: 'summary is markdown text of at most 50 000 characters.' };
  const status = body.status ?? 'active';
  if (!(PROJECT_STATUSES as readonly unknown[]).includes(status)) return { ok: false, error: `status is one of ${PROJECT_STATUSES.join(', ')}.` };
  const items = parseRefs(body.items, 'items', 500);
  if (!items.ok) return items;
  if (items.value.some((i) => i.record.startsWith('project:'))) return { ok: false, error: 'A project groups records, not other projects.' };
  const attachments = parseAttachments(body.attachments);
  if (!attachments.ok) return attachments;
  return { ok: true, value: { title, summary, status: status as ProjectStatus, items: items.value, attachments: attachments.value } };
}

/** What a reference names, for display and links: the same split everywhere. */
export function describeRef(record: string): { type: 'design' | 'definition' | 'build' | 'vocab' | 'project' | 'firmware'; kind?: string; id: string } {
  const [type, a = '', b] = record.split(':');
  if (type === 'definition') return { type, kind: a, id: b ?? '' };
  return { type: type as 'design' | 'build' | 'vocab' | 'project' | 'firmware', id: a };
}

/** Case-insensitive substring search over a note or project summary, like the rest of quick open. */
export function matchesKnowledge(entry: { title: string; text: string; tags?: string[] }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [entry.title, entry.text, ...(entry.tags ?? [])].some((field) => field.toLowerCase().includes(q));
}
