/** The browser side of linked knowledge (`specs/knowledge.md`): the `/api/knowledge` endpoints. */
import type { Outcome } from '@wirehub/editor-react';

import { request } from './definitions.browser.ts';
import type { Attachment, KnowledgeIndex, Note, NoteSummary, Project } from './knowledge.ts';

export const knowledgeKey = ['knowledge'] as const;
export const knowledgeIndexKey = ['knowledge', 'index'] as const;
export const recordNotesKey = (record: string): readonly string[] => ['knowledge', 'record', record];
export const projectKey = (id: string): readonly string[] => ['knowledge', 'project', id];

export type NoteWithTag = Note & { etag: string };
export interface ProjectPage { project: Project; notes: NoteSummary[]; itemNotes: Record<string, number>; etag: string }
export type NoteDraft = Pick<Note, 'kind' | 'title' | 'body' | 'links' | 'attachments'> & { status?: Note['status']; tags?: string[] };
export type ProjectDraft = Pick<Project, 'title' | 'summary' | 'status' | 'items' | 'attachments'>;

async function must<T>(out: Promise<Outcome<T>>): Promise<T> {
  const value = await out;
  if (!value.ok) throw new Error(value.message);
  return value.value;
}

export const fetchKnowledgeIndex = (): Promise<KnowledgeIndex> => must(request<KnowledgeIndex>('/api/knowledge'));
export const fetchRecordNotes = async (record: string): Promise<NoteWithTag[]> =>
  (await must(request<{ notes: NoteWithTag[] }>(`/api/knowledge/notes?record=${encodeURIComponent(record)}`))).notes;

export async function fetchProject(id: string): Promise<ProjectPage> {
  let etag = '';
  const value = await must(request<Omit<ProjectPage, 'etag'>>(`/api/knowledge/projects/${encodeURIComponent(id)}`, { method: 'GET' }, (r) => { etag = r.headers.get('etag') ?? ''; }));
  return { ...value, etag };
}

export function createNote(draft: NoteDraft): Promise<Outcome<Note>> {
  return request<Note>('/api/knowledge/notes', { method: 'POST', body: draft });
}
export function saveNote(id: string, draft: NoteDraft, etag: string): Promise<Outcome<Note>> {
  return request<Note>(`/api/knowledge/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: draft, headers: { 'if-match': etag } });
}
export function deleteNote(id: string, etag: string): Promise<Outcome<unknown>> {
  return request(`/api/knowledge/notes/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'if-match': etag } });
}
export function createProject(draft: ProjectDraft): Promise<Outcome<Project>> {
  return request<Project>('/api/knowledge/projects', { method: 'POST', body: draft });
}
export function saveProject(id: string, draft: ProjectDraft, etag: string): Promise<Outcome<Project>> {
  return request<Project>(`/api/knowledge/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: draft, headers: { 'if-match': etag } });
}
export function deleteProject(id: string, etag: string): Promise<Outcome<unknown>> {
  return request(`/api/knowledge/projects/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'if-match': etag } });
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** Upload one file to the shared asset store; the note names it once saved. */
export async function uploadAttachment(file: File): Promise<Outcome<Attachment>> {
  const data = await base64Of(file);
  const out = await request<{ attachment: Attachment }>('/api/knowledge/attachments', { method: 'POST', body: { name: file.name, data } });
  return out.ok ? { ok: true, value: out.value.attachment } : out;
}

export const attachmentUrl = (a: Pick<Attachment, 'asset' | 'name'>): string => `/api/knowledge/files/${a.asset}?name=${encodeURIComponent(a.name)}`;
export const photoUrl = (asset: string): string => `/api/blobs/${asset}`;
/** The server's small PNG of a stored photo (no metadata): what a gallery shows; the link opens the photo. */
export const thumbUrl = (asset: string): string => `/api/knowledge/files/${asset}/thumb`;
