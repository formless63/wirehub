/**
 * Notes, decisions, photos and files about one record (`specs/knowledge.md`). The same panel
 * sits on Library records, designs and project pages. A note can link several items; it is
 * shown wherever any of them is open. Photos linked to a board become cover candidates there.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Combobox, ConfirmDialog, FileDrop, Field, Input, Section, SegmentedControl, Select, Textarea } from '@wirehub/editor-react';

import { DECISION_STATUSES, PHOTO_MIMES, type Attachment, type DecisionStatus, type NoteKind } from '../knowledge.ts';
import { attachmentUrl, createNote, deleteNote, fetchRecordNotes, knowledgeKey, photoUrl, recordNotesKey, thumbUrl, saveNote, uploadAttachment, type NoteDraft, type NoteWithTag } from '../knowledge.browser.ts';
import { HistoryButton } from '../history/HistoryPanel.tsx';
import { Markdown } from './Markdown.tsx';
import { RefChip, useItemRefs } from './refs.tsx';
import { localDate } from '../when.ts';
import { useSectionAdd } from '../shell/RecordSections.tsx';

const STATUS_TONE: Readonly<Record<DecisionStatus, 'info' | 'ok' | 'neutral' | 'err'>> = { proposed: 'info', accepted: 'ok', superseded: 'neutral', rejected: 'err' };
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

export function AttachmentList({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (asset: string) => void }): JSX.Element | null {
  if (attachments.length === 0) return null;
  const photos = attachments.filter((a) => PHOTO_MIMES.includes(a.mime));
  const files = attachments.filter((a) => !PHOTO_MIMES.includes(a.mime));
  return <div className="flex flex-col gap-1.5">
    {photos.length === 0 ? null : <div className="flex flex-wrap gap-1.5">
      {photos.map((a) => <figure key={a.asset} className="relative m-0">
        <a href={photoUrl(a.asset)} target="_blank" rel="noopener noreferrer" title={a.caption ?? a.name}>
          <img src={thumbUrl(a.asset)} alt={a.caption ?? a.name} loading="lazy" className="h-16 w-20 rounded border border-line bg-raised object-cover" />
        </a>
        {onRemove === undefined ? null : <Button size="xs" className="absolute right-0.5 top-0.5" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.asset)}>×</Button>}
      </figure>)}
    </div>}
    {files.length === 0 ? null : <ul className="flex flex-col gap-0.5 text-xs">
      {files.map((a) => <li key={a.asset} className="flex items-center gap-2">
        <a href={attachmentUrl(a)} className="underline" download={a.name}>{a.name}</a>
        <span className="text-faint">{a.mime === 'application/pdf' ? 'PDF' : a.mime === 'application/zip' ? 'ZIP' : 'File'} · {kb(a.bytes)}</span>
        {onRemove === undefined ? null : <Button size="xs" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.asset)}>Remove</Button>}
      </li>)}
    </ul>}
  </div>;
}

/** Create or edit one note. `fixed` is the record the panel is about: always linked, not removable. */
export function NoteEditor({ initial, fixed, onDone, onCancel }: {
  initial?: NoteWithTag; fixed: string; onDone: () => void; onCancel: () => void;
}): JSX.Element {
  const refs = useItemRefs();
  const [kind, setKind] = useState<NoteKind>(initial?.kind ?? 'note');
  const [status, setStatus] = useState<DecisionStatus>(initial?.status ?? 'proposed');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [links, setLinks] = useState<string[]>(() => [...new Set([fixed, ...(initial?.links.map((l) => l.record) ?? [])])]);
  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);

  const addFiles = async (files: File[]): Promise<void> => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      const out = await uploadAttachment(file);
      setUploading((n) => n - 1);
      if (!out.ok) toast.error(`${file.name}: ${out.message}`, { description: out.hint });
      else setAttachments((list) => (list.some((a) => a.asset === out.value.asset) ? list : [...list, out.value]));
    }
  };
  // an empty title takes the text's first line, so a quick note needs no title
  const effectiveTitle = title.trim() !== '' ? title : (body.split('\n').map((line) => line.replace(/^[#>*\-\s]+/, '').trim()).find((line) => line !== '') ?? '').slice(0, 200);
  const noun = kind === 'decision' ? 'decision' : 'note';
  const save = async (): Promise<void> => {
    if (effectiveTitle.trim() === '') return;
    setBusy(true);
    const draft: NoteDraft = { kind, title: effectiveTitle, body, links: links.map((record) => ({ record })), attachments, ...(kind === 'decision' ? { status } : {}) };
    const out = initial === undefined ? await createNote(draft) : await saveNote(initial.id, draft, initial.etag);
    setBusy(false);
    if (!out.ok) { toast.error(out.message, { description: out.hint }); return; }
    toast.success(initial === undefined ? `${noun === 'decision' ? 'Decision' : 'Note'} added.` : `${noun === 'decision' ? 'Decision' : 'Note'} saved.`);
    onDone();
  };

  return <form className="flex flex-col gap-2 rounded border border-line bg-raised p-2" aria-label={initial === undefined ? 'New note' : `Edit ${initial.title}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl aria-label="Kind" value={kind} onValueChange={(v) => setKind(v as NoteKind)} options={[{ value: 'note', label: 'Note' }, { value: 'decision', label: 'Decision' }]} />
      {kind !== 'decision' ? null : <Select aria-label="Decision status" value={status} onValueChange={(v) => setStatus(v as DecisionStatus)} options={DECISION_STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))} />}
    </div>
    <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={effectiveTitle !== '' && title.trim() === '' ? effectiveTitle : kind === 'decision' ? 'Use crimp contacts for the field harness' : 'Bench observation'} /></Field>
    <div className="flex items-center justify-between">
      <span className="text-xs text-faint">Markdown · no HTML</span>
      <Button size="xs" variant="ghost" onClick={() => setPreview((p) => !p)}>{preview ? 'Edit' : 'Preview'}</Button>
    </div>
    {preview ? <div className="min-h-24 rounded border border-line bg-panel p-2"><Markdown source={body} /></div>
      : <Textarea aria-label="Note text" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What was found, why it was decided, what to try next…" />}
    <div className="flex flex-col gap-1">
      <span className="text-xs text-faint">Linked items</span>
      <div className="flex flex-wrap gap-1">
        {links.map((record) => <RefChip key={record} item={refs.resolve(record)} {...(record === fixed ? {} : { onRemove: () => setLinks((l) => l.filter((x) => x !== record)) })} />)}
      </div>
      <Combobox aria-label="Link another item" placeholder="Link another item…" value={null} options={refs.options.filter((o) => !links.includes(o.value))} onValueChange={(v) => setLinks((l) => (l.includes(v) ? l : [...l, v]))} />
    </div>
    <AttachmentList attachments={attachments} onRemove={(asset) => setAttachments((list) => list.filter((a) => a.asset !== asset))} />
    <FileDrop multiple onFiles={(files) => void addFiles(files)} hint="Photos (PNG, JPEG), PDFs or any file up to 24 MB">{uploading > 0 ? `Uploading ${uploading}…` : 'Drop photos or files here, or choose'}</FileDrop>
    <div className="flex gap-2">
      <Button type="submit" variant="primary" size="xs" disabled={busy || uploading > 0 || effectiveTitle.trim() === ''}>{initial === undefined ? `Add ${noun}` : `Save ${noun}`}</Button>
      <Button size="xs" onClick={onCancel} disabled={busy}>Cancel</Button>
    </div>
  </form>;
}

export function NoteCard({ note, about, readOnly, onEdit, onDelete, onRestored }: { note: NoteWithTag; about: string; readOnly: boolean; onEdit: () => void; onDelete: () => void; onRestored?: () => void }): JSX.Element {
  const refs = useItemRefs();
  const others = note.links.map((l) => l.record).filter((r) => r !== about);
  return <article className="flex flex-col gap-1.5 border-t border-line py-2" data-note={note.id}>
    <header className="flex flex-wrap items-center gap-1.5">
      {note.kind === 'decision' ? <Badge tone={STATUS_TONE[note.status ?? 'proposed']}>{`Decision · ${note.status ?? 'proposed'}`}</Badge> : null}
      <span className="font-semibold text-xs">{note.title}</span>
      <span className="grow" />
      <span className="text-2xs text-faint" title={note.updatedAt}>{note.updatedBy === undefined ? '' : `${note.updatedBy} · `}{localDate(note.updatedAt)}</span>
      <HistoryButton compact subject={`note:${note.id}`} label={note.title} {...(onRestored === undefined ? {} : { onRestored })} />
      {readOnly ? null : <><Button size="xs" variant="ghost" onClick={onEdit}>Edit</Button><Button size="xs" variant="ghost" onClick={onDelete}>Delete</Button></>}
    </header>
    {note.body.trim() === '' ? null : <Markdown source={note.body} />}
    <AttachmentList attachments={note.attachments} />
    {others.length === 0 ? null : <div className="flex flex-wrap items-center gap-1"><span className="text-2xs text-faint">Also on</span>{others.map((r) => <RefChip key={r} item={refs.resolve(r)} />)}</div>}
  </article>;
}

/** The record page's Notes panel. `record` is the item reference (`definition:pcbas:<id>`, `design:<id>`, `project:<id>`). */
export function NotesPanel({ record, readOnly = false, title = 'Notes' }: { record: string; readOnly?: boolean; title?: string }): JSX.Element | null {
  const client = useQueryClient();
  const query = useQuery({ queryKey: recordNotesKey(record), queryFn: () => fetchRecordNotes(record), retry: false });
  const [editing, setEditing] = useState<string | 'new'>();
  const [removing, setRemoving] = useState<NoteWithTag>();
  // a note is its own record: someone editing the board does not lock its notes
  const cannotWrite = readOnly;
  const refresh = (): void => { void client.invalidateQueries({ queryKey: knowledgeKey }); void client.invalidateQueries({ queryKey: ['representations'] }); };
  const notes = query.data ?? [];
  const decisions = notes.filter((n) => n.kind === 'decision').length;
  const empty = query.isSuccess && notes.length === 0 && editing !== 'new';
  const hosted = useSectionAdd('notes', 'Note', empty && !cannotWrite, () => setEditing('new'));
  if (hosted && (empty || query.isPending)) return null;
  return <Section id="notes" title={title} testId="notes-panel"
    summary={notes.length === 0 ? undefined : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}${decisions === 0 ? '' : ` · ${decisions} ${decisions === 1 ? 'decision' : 'decisions'}`}`}
    actions={cannotWrite || editing === 'new' ? undefined : <Button size="xs" onClick={() => setEditing('new')}>Add note</Button>}>
    <div className="flex flex-col gap-1">
    {editing === 'new' ? <NoteEditor fixed={record} onCancel={() => setEditing(undefined)} onDone={() => { setEditing(undefined); refresh(); }} /> : null}
    {query.isError ? <p role="alert" className="text-xs text-err">{query.error.message}</p> : null}
    {query.isPending ? <p className="text-xs text-faint">Loading notes…</p> : null}
    {notes.map((note) => editing === note.id
      ? <NoteEditor key={note.id} initial={note} fixed={record} onCancel={() => setEditing(undefined)} onDone={() => { setEditing(undefined); refresh(); }} />
      : <NoteCard key={note.id} note={note} about={record} readOnly={cannotWrite} onEdit={() => setEditing(note.id)} onDelete={() => setRemoving(note)} onRestored={refresh} />)}
    <ConfirmDialog open={removing !== undefined} title={`Delete “${removing?.title ?? ''}”?`} destructive confirmLabel="Delete note"
      onCancel={() => setRemoving(undefined)}
      onConfirm={() => {
        const note = removing;
        setRemoving(undefined);
        if (note === undefined) return;
        void deleteNote(note.id, note.etag).then((out) => { if (out.ok) { toast.success('Note deleted.'); refresh(); } else toast.error(out.message, { description: out.hint }); });
      }}>
      It is removed from every item it links. Attached files stay in the hub's file store.
    </ConfirmDialog>
    </div>
  </Section>;
}
