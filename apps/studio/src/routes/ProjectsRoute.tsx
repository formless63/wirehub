/**
 * `/projects` and `/projects/$id` (`specs/knowledge.md`): a project groups references to existing
 * reusable records — designs, boards, stock, parts — without copying them, and keeps its own notes,
 * decisions and files. Removing an item from a project never touches the item.
 *
 * A design item shows its tags; "Show in Designs" opens the Designs list filtered to the project's
 * designs (`/cables?project=<id>`, `docs/design-tags.md`), where they can be tagged in bulk.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useRef, useState, type JSX } from 'react';
import { toast } from 'sonner';
import { Button, Chip, Combobox, ConfirmDialog, DataTable, FileDrop, Field, Input, Page, PageBody, Select, Textarea, type DataColumn } from '@wirehub/editor-react';

import { PROJECT_STATUSES, describeRef, matchesKnowledge, projectRecord, type Attachment, type Project, type ProjectStatus, type ProjectSummary } from '../knowledge.ts';
import { createProject, deleteProject, fetchKnowledgeIndex, fetchProject, knowledgeKey, knowledgeIndexKey, projectKey, saveProject, uploadAttachment, type ProjectDraft } from '../knowledge.browser.ts';
import { HistoryButton } from '../history/HistoryPanel.tsx';
import { Markdown } from '../knowledge/Markdown.tsx';
import { AttachmentList, NotesPanel } from '../knowledge/NotesPanel.tsx';
import { RefChip, useItemRefs } from '../knowledge/refs.tsx';
import { EmptyState } from '../shell/EmptyState.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { useStudio } from '../studio-context.tsx';
import { cableListKey, loadCableList } from '../queries.ts';
import { TagChips } from '../shell/DesignTags.tsx';
import { localDate } from '../when.ts';

const STATUS_TONE: Readonly<Record<ProjectStatus, 'ok' | 'warn' | 'neutral'>> = { active: 'ok', paused: 'warn', done: 'neutral' };
const statusLabel = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

export function ProjectsRoute(): JSX.Element {
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const navigate = useNavigate();
  const client = useQueryClient();
  const query = useQuery({ queryKey: knowledgeIndexKey, queryFn: fetchKnowledgeIndex, retry: false });
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<{ title: string; summary: string }>();
  const rows = useMemo(() => (query.data?.projects ?? []).filter((p) => matchesKnowledge(p, filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [query.data, filter]);
  // the table keeps its column choices per definition: the columns must be stable between renders
  const columns = useMemo((): DataColumn<ProjectSummary>[] => {
  const notesFor = (p: ProjectSummary): number => (query.data?.notes ?? []).filter((n) => n.links.includes(projectRecord(p.id))).length;
  return [
    { id: 'title', header: 'Project', width: 260, sortValue: (p) => p.title, cell: (p) => <Link to="/projects/$id" params={{ id: p.id }} className="font-semibold underline">{p.title}</Link> },
    { id: 'status', header: 'Status', width: 90, sortValue: (p) => p.status, cell: (p) => <Chip tone={STATUS_TONE[p.status]}>{statusLabel(p.status)}</Chip> },
    { id: 'items', header: 'Items', width: 70, numeric: true, sortValue: (p) => p.items.length, cell: (p) => String(p.items.length) },
    { id: 'notes', header: 'Notes', width: 70, numeric: true, sortValue: notesFor, cell: (p) => String(notesFor(p)) },
    { id: 'summary', header: 'Summary', width: 360, cell: (p) => <span className="text-faint">{p.text.slice(0, 120)}</span> },
    { id: 'updated', header: 'Updated', width: 110, sortValue: (p) => p.updatedAt, cell: (p) => localDate(p.updatedAt) },
  ];
  }, [query.data]);
  const create = async (): Promise<void> => {
    if (creating === undefined || creating.title.trim() === '') return;
    const out = await createProject({ title: creating.title, summary: creating.summary, status: 'active', items: [], attachments: [] });
    if (!out.ok) { toast.error(out.message, { description: out.hint }); return; }
    setCreating(undefined);
    void client.invalidateQueries({ queryKey: knowledgeKey });
    void navigate({ to: '/projects/$id', params: { id: out.value.id } });
  };
  return <Page testId="projects">
    <RouteHeader title="Projects" count={query.data === undefined ? undefined : `${query.data.projects.length} ${query.data.projects.length === 1 ? 'project' : 'projects'}`}
      primary={readOnly ? undefined : <Button variant="primary" disabled={creating !== undefined} onClick={() => setCreating({ title: '', summary: '' })}>New project…</Button>} />
    <PageBody>
      <div className="flex flex-col gap-2 px-4 py-2">
        <Input aria-label="Filter projects" placeholder="Filter projects…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        {creating === undefined ? null : <form className="flex max-w-xl flex-col gap-2 rounded border border-line bg-raised p-2" aria-label="New project" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field label="Title"><Input autoFocus value={creating.title} maxLength={200} onChange={(e) => setCreating({ ...creating, title: e.target.value })} placeholder="Bench power supply rework" /></Field>
          <Field label="Summary" hint="Markdown"><Textarea rows={3} value={creating.summary} onChange={(e) => setCreating({ ...creating, summary: e.target.value })} /></Field>
          <div className="flex gap-2"><Button type="submit" variant="primary" size="xs" disabled={creating.title.trim() === ''}>Create project</Button><Button size="xs" onClick={() => setCreating(undefined)}>Cancel</Button></div>
        </form>}
      </div>
      {query.isError ? <div className="px-4 py-3 text-faint">The projects could not be read.</div> : <DataTable
        loading={query.data === undefined}
        label="Projects"
        testId="project-list"
        rows={rows}
        columns={columns}
        getRowId={(p) => p.id}
        onActivate={(p) => void navigate({ to: '/projects/$id', params: { id: p.id } })}
        columnsKey="projects"
        rowAttrs={(p) => ({ 'data-project': p.id })}
        empty={<EmptyState topic="overview">Group the designs, boards and parts of one piece of work, with its notes and files. Nothing is copied.</EmptyState>}
      />}
    </PageBody>
  </Page>;
}

export function ProjectRoute(): JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const client = useQueryClient();
  const navigate = useNavigate();
  const refs = useItemRefs();
  const page = useQuery({ queryKey: projectKey(id), queryFn: () => fetchProject(id), retry: false });
  const [editingSummary, setEditingSummary] = useState<{ title: string; summary: string }>();
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const [removing, setRemoving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const project = page.data?.project;
  // the design items' tags, from the Designs list's rows (only fetched when the project lists a design)
  const listsDesigns = (project?.items ?? []).some((i) => describeRef(i.record).type === 'design');
  const designList = useQuery({ queryKey: cableListKey, queryFn: loadCableList, enabled: listsDesigns, staleTime: 30_000 });
  const designTags = useMemo(() => new Map((designList.data?.entries ?? []).map((e) => [e.id, e.tags ?? []] as const)), [designList.data]);

  const save = (change: (p: Project) => ProjectDraft, done?: string): Promise<boolean> => {
    // Item picks can arrive before the previous save finishes. Serialize edits and apply each
    // change to the refreshed record, so rapid picks never replace one another.
    const next = saves.current.then(async () => {
      const current = client.getQueryData<typeof page.data>(projectKey(id));
      if (current === undefined) return false;
      const out = await saveProject(id, change(current.project), current.etag);
      if (!out.ok) { toast.error(out.message, { description: out.hint }); await page.refetch(); return false; }
      if (done !== undefined) toast.success(done);
      await client.invalidateQueries({ queryKey: knowledgeKey });
      return true;
    });
    saves.current = next.catch(() => undefined);
    return next;
  };
  const draftOf = (p: Project): ProjectDraft => ({ title: p.title, summary: p.summary, status: p.status, items: p.items, attachments: p.attachments });
  const addFiles = async (files: File[]): Promise<void> => {
    const added: Attachment[] = [];
    setUploading(files.length);
    for (const file of files) {
      const out = await uploadAttachment(file);
      if (out.ok) added.push(out.value); else toast.error(`${file.name}: ${out.message}`);
    }
    setUploading(0);
    if (added.length > 0) await save((p) => ({ ...draftOf(p), attachments: [...p.attachments, ...added.filter((a) => !p.attachments.some((x) => x.asset === a.asset))] }), 'Files attached.');
  };

  if (page.isError) return <Page testId="project"><RouteHeader title="Project" /><div className="px-4 py-3 text-faint">{page.error.message} <Link to="/projects" className="underline">All projects</Link></div></Page>;
  if (project === undefined) return <Page testId="project"><RouteHeader title="Project" /><div className="px-4 py-3 text-faint">Loading…</div></Page>;

  const grouped = new Map<string, { record: string; note?: string }[]>();
  for (const item of project.items) {
    const noun = refs.resolve(item.record).noun;
    grouped.set(noun, [...(grouped.get(noun) ?? []), item]);
  }
  return <Page testId="project">
    <RouteHeader title={project.title} count={`${project.items.length} ${project.items.length === 1 ? 'item' : 'items'}`}
      secondary={<><Link to="/projects" className="cs-ui-btn no-underline">All projects</Link>{listsDesigns ? <Link to="/cables" search={{ project: [id] }} className="cs-ui-btn no-underline" title="The Designs list, filtered to this project's designs">Show in Designs</Link> : null}<HistoryButton subject={`project:${id}`} label={project.title} onRestored={() => { void client.invalidateQueries({ queryKey: knowledgeKey }); void page.refetch(); }} /></>}
      primary={readOnly ? undefined : <Button variant="ghost" onClick={() => setRemoving(true)}>Delete project</Button>} />
    <PageBody>
      <div className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <section aria-label="Summary" className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs">Summary</span>
              {readOnly ? <Chip tone={STATUS_TONE[project.status]}>{statusLabel(project.status)}</Chip>
                : <Select aria-label="Project status" size="xs" className="w-28" value={project.status} onValueChange={(v) => void save((p) => ({ ...draftOf(p), status: v as ProjectStatus }), 'Status saved.')} options={PROJECT_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))} />}
              <span className="grow" />
              {readOnly || editingSummary !== undefined ? null : <Button size="xs" variant="ghost" onClick={() => setEditingSummary({ title: project.title, summary: project.summary })}>Edit</Button>}
            </div>
            {editingSummary === undefined ? (project.summary.trim() === '' ? <p className="text-xs text-faint">No summary.</p> : <Markdown source={project.summary} />)
              : <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void save((p) => ({ ...draftOf(p), title: editingSummary.title, summary: editingSummary.summary }), 'Summary saved.').then((done) => { if (done) setEditingSummary(undefined); }); }}>
                <Field label="Project name"><Input value={editingSummary.title} maxLength={200} onChange={(e) => setEditingSummary({ ...editingSummary, title: e.target.value })} /></Field>
                <Textarea aria-label="Project summary" rows={5} value={editingSummary.summary} onChange={(e) => setEditingSummary({ ...editingSummary, summary: e.target.value })} />
                <div className="flex gap-2"><Button type="submit" size="xs" variant="primary" disabled={!editingSummary.title.trim()}>Save</Button><Button size="xs" onClick={() => setEditingSummary(undefined)}>Cancel</Button></div>
              </form>}
          </section>
          <section aria-label="Items" className="flex flex-col gap-1.5" data-testid="project-items">
            <div className="flex items-center gap-2"><span className="font-semibold text-xs">Items</span><span className="text-2xs text-faint">References to library records and designs; nothing is copied.</span></div>
            {project.items.length === 0 ? <p className="text-xs text-faint">No items yet.</p> : [...grouped.entries()].map(([noun, items]) => <div key={noun} className="flex flex-col gap-1">
              <span className="text-2xs uppercase text-faint">{noun}</span>
              <ul className="flex flex-col gap-1">
                {items.map((item) => {
                  const resolved = refs.resolve(item.record);
                  const count = page.data?.itemNotes[item.record] ?? 0;
                  return <li key={item.record} className="flex flex-wrap items-center gap-2" data-item={item.record}>
                    <RefChip item={resolved} />
                    {describeRef(item.record).type === 'design' ? <TagChips tags={designTags.get(describeRef(item.record).id)} max={6} /> : null}
                    {resolved.missing ? <span className="text-2xs text-warn">no longer in this hub</span> : null}
                    {count === 0 ? null : <span className="text-2xs text-faint">{count} {count === 1 ? 'note' : 'notes'}</span>}
                    {item.note === undefined ? null : <span className="text-xs text-dim">{item.note}</span>}
                    <span className="grow" />
                    {readOnly ? null : <Button size="xs" variant="ghost" onClick={() => void save((p) => ({ ...draftOf(p), items: p.items.filter((i) => i.record !== item.record) }), 'Removed from the project.')}>Remove</Button>}
                  </li>;
                })}
              </ul>
            </div>)}
            {readOnly ? null : <Combobox aria-label="Add an item" placeholder="Add a design, board, stock or part…" value={null}
              options={refs.options.filter((o) => !o.value.startsWith('project:') && !project.items.some((i) => i.record === o.value))}
              onValueChange={(record) => void save((p) => ({ ...draftOf(p), items: [...p.items, { record }] }), 'Added to the project.')} />}
          </section>
          <section aria-label="Project files" className="flex flex-col gap-1.5">
            <span className="font-semibold text-xs">Files</span>
            <AttachmentList attachments={project.attachments} {...(readOnly ? {} : { onRemove: (asset: string) => void save((p) => ({ ...draftOf(p), attachments: p.attachments.filter((a) => a.asset !== asset) })) })} />
            {readOnly ? null : <FileDrop multiple onFiles={(files) => void addFiles(files)} hint="Photos, PDFs or any file up to 24 MB">{uploading > 0 ? `Uploading ${uploading}…` : 'Drop files here, or choose'}</FileDrop>}
          </section>
        </div>
        <div className="min-w-0">
          <NotesPanel record={projectRecord(id)} readOnly={readOnly} title="Project notes" />
        </div>
      </div>
    </PageBody>
    <ConfirmDialog open={removing} title={`Delete project “${project.title}”?`} destructive confirmLabel="Delete project" onCancel={() => setRemoving(false)}
      onConfirm={() => {
        setRemoving(false);
        void deleteProject(id, page.data!.etag).then((out) => {
          if (!out.ok) { toast.error(out.message, { description: out.hint }); return; }
          toast.success('Project deleted. Its items and notes are unchanged.');
          void client.invalidateQueries({ queryKey: knowledgeKey });
          void navigate({ to: '/projects' });
        });
      }}>
      The designs and records it groups are not changed. Its notes stay and still show on the other items they link.
    </ConfirmDialog>
  </Page>;
}
