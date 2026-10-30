/**
 * Required manufacturing processes (`server/processes-settings.ts`, `@wirehub/model` `processes.ts`):
 * the hub's own processes and those a pack ships, a form for one (name, source, when it is derived
 * as rule-language selectors) with its JSON behind "Advanced", on/off, and Save (owner or editor).
 * Designs declare processes in their Notes tab; a derived one is added wherever its condition holds.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { Button, Chip, Input, Select, Textarea } from '@wirehub/editor-react';

import { newRecordId } from '../display.ts';
import { processesKey, processesQuery, saveProcesses, type ProcessEntry, type ProcessView } from '../settings.browser.ts';
import { useStudio } from '../studio-context.tsx';
import { ConditionEditor, draftObject } from './DeclarativeEditors.tsx';

type Draft = Record<string, unknown>;

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

/** A derive entry in a few words: "each mechanical (filtered)". */
const deriveText = (p: ProcessEntry): string =>
  (p.derive ?? []).map((d) => `${d.each}${d.where === undefined ? '' : ' (filtered)'}`).join(', ');

function DeriveRows({ value, subjects, max, onChange }: { value: Draft[]; subjects: readonly string[]; max: number; onChange: (next: Draft[]) => void }): JSX.Element {
  const set = (i: number, next: Draft): void => onChange(value.map((d, at) => (at === i ? next : d)));
  return (
    <div className="space-y-2" aria-label="Derived when">
      {value.map((d, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2" data-derive={i}>
          <div className="flex flex-wrap items-end gap-2">
            <Select aria-label={`Derive ${i + 1} subject`} className="w-40" value={typeof d['each'] === 'string' ? d['each'] : undefined} options={subjects.map((s) => ({ value: s, label: `each ${s}` }))} onValueChange={(each) => set(i, { ...d, each })} />
            <Input aria-label={`Derive ${i + 1} note`} className="min-w-0 flex-1" placeholder="why (optional)" value={typeof d['note'] === 'string' ? d['note'] : ''} onChange={(e) => { const { note: _n, ...rest } = d; set(i, e.target.value === '' ? rest : { ...rest, note: e.target.value }); }} />
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange(value.filter((_, at) => at !== i))}>Remove</Button>
          </div>
          {d['where'] === undefined ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => set(i, { ...d, where: { exists: { path: 'id' } } })}>Add filter</Button>
          ) : (
            <>
              <ConditionEditor label={`Derive ${i + 1} when`} value={d['where']} onChange={(where) => set(i, { ...d, where })} />
              <Button type="button" variant="ghost" size="xs" onClick={() => { const { where: _w, ...rest } = d; set(i, rest); }}>Every {String(d['each'] ?? 'subject')}</Button>
            </>
          )}
        </div>
      ))}
      <Button type="button" variant="ghost" size="xs" disabled={value.length >= max} onClick={() => onChange([...value, { each: subjects[0] ?? 'design' }])}>Add derive condition</Button>
    </div>
  );
}

function ProcessForm({ value, subjects, max, onChange }: { value: Draft; subjects: readonly string[]; max: number; onChange: (next: Draft) => void }): JSX.Element {
  const text = (key: string, next: string, optional = false): void => {
    const out = { ...value };
    if (optional && next === '') delete out[key];
    else out[key] = next;
    onChange(out);
  };
  const derive = Array.isArray(value['derive']) ? (value['derive'] as Draft[]) : [];
  return (
    <div className="space-y-2" aria-label="Process form">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-0.5"><span>Name</span><Input aria-label="Process name" value={typeof value['label'] === 'string' ? value['label'] : ''} onChange={(e) => text('label', e.target.value)} /></label>
        <label className="flex min-w-0 flex-col gap-0.5"><span>Source</span><Input aria-label="Process source" placeholder="shop practice" value={typeof value['src'] === 'string' ? value['src'] : ''} onChange={(e) => text('src', e.target.value)} /></label>
      </div>
      <label className="flex min-w-0 flex-col gap-0.5"><span>Description</span><Input aria-label="Process description" value={typeof value['description'] === 'string' ? value['description'] : ''} onChange={(e) => text('description', e.target.value, true)} /></label>
      <DeriveRows value={derive} subjects={subjects} max={max} onChange={(next) => { const { derive: _d, ...rest } = value; onChange(next.length === 0 ? rest : { ...rest, derive: next }); }} />
    </div>
  );
}

export function ProcessesSettings(): JSX.Element {
  const box = useRef<HTMLElement>(null);
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(processesQuery);
  const view = query.data;
  const [editing, setEditing] = useState<{ text: string; replaces?: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const strip = (p: ProcessView): ProcessEntry => {
    const { origin: _o, pack: _p, problems: _pr, ...entry } = p;
    return entry;
  };

  const persist = async (processes: unknown[], done: string): Promise<boolean> => {
    if (view === undefined) return false;
    setBusy(true);
    const out = await saveProcesses(processes, view.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return false;
    }
    client.setQueryData(processesKey, out.value);
    // designs check their declared processes against these, and derive from them
    void client.invalidateQueries({ queryKey: ['studio', 'db'] });
    toast.success(done);
    return true;
  };

  const save = async (): Promise<void> => {
    if (editing === undefined || view === undefined) return;
    if (box.current?.querySelector('[data-invalid-json="true"]')) {
      toast.error('Correct the invalid JSON field before saving.');
      return;
    }
    let entry: Draft;
    try {
      entry = JSON.parse(editing.text) as Draft;
    } catch (error) {
      toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
      return;
    }
    if (editing.replaces === undefined && (!entry['id'] || view.processes.some((p) => p.id === entry['id']))) entry['id'] = newRecordId(String(entry['label'] || 'process'), view.processes.map((p) => p.id), 'process');
    const others = view.local.filter((p) => p.id !== (editing.replaces ?? entry['id']) && p.id !== entry['id']);
    if (await persist([...others, entry], `Saved ${String(entry['label'] || 'process')}.`)) setEditing(undefined);
  };

  const toggle = async (p: ProcessView): Promise<void> => {
    if (view === undefined) return;
    await persist([...view.local.filter((x) => x.id !== p.id), { ...strip(p), enabled: p.enabled === false }], `${p.label} is ${p.enabled === false ? 'on' : 'off'}.`);
  };

  const remove = async (p: ProcessView): Promise<void> => {
    if (view === undefined) return;
    await persist(view.local.filter((x) => x.id !== p.id), `Removed ${p.label}.`);
  };

  if (view === undefined) return <div className="text-faint">{query.isError ? 'The processes could not be read.' : 'Loading…'}</div>;
  const draft = editing === undefined ? undefined : draftObject(editing.text);
  return (
    <section ref={box} className="max-w-2xl" data-testid="processes-settings">
      {view.processes.length === 0 ? <div className="text-faint">No processes yet.</div> : null}
      <ul>
        {view.processes.map((p) => (
          <li key={p.id} className="my-1 flex flex-wrap items-center gap-2 border border-line p-2" data-process={p.id}>
            <b title={p.description}>{p.label}</b>
            {(p.derive ?? []).length > 0 ? <Chip title={(p.derive ?? []).map((d) => d.note ?? '').filter(Boolean).join('; ') || undefined}>derived: {deriveText(p)}</Chip> : null}
            {p.enabled === false ? <Chip>off</Chip> : null}
            {p.origin === 'pack' ? <Chip>pack {p.pack ?? ''}</Chip> : null}
            {p.problems.length > 0 ? <Chip tone="err" role="alert" title={p.problems.join('; ')}>cannot be used</Chip> : null}
            {readOnly ? null : (
              <span className="ml-auto flex gap-1">
                <Button type="button" variant="ghost" size="xs" onClick={() => setEditing({ text: pretty(strip(p)), replaces: p.id })}>{p.origin === 'pack' ? 'Override…' : 'Edit…'}</Button>
                <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void toggle(p)}>{p.enabled === false ? 'Turn on' : 'Turn off'}</Button>
                {p.origin === 'local' ? <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void remove(p)}>Remove</Button> : null}
              </span>
            )}
          </li>
        ))}
      </ul>
      {readOnly || editing !== undefined ? null : (
        <Button type="button" className="mt-2" size="xs" disabled={view.processes.length >= view.limits.processes} onClick={() => setEditing({ text: pretty({ label: '', src: '' }) })}>New process</Button>
      )}
      {editing === undefined ? null : (
        <div className="mt-2" data-testid="process-editor">
          {draft === undefined ? <p className="text-faint">Correct the advanced JSON to use the form.</p> : <ProcessForm value={draft} subjects={view.subjects} max={view.limits.derivePerProcess} onChange={(next) => setEditing({ ...editing, text: pretty(next) })} />}
          <details className="mt-2"><summary>Advanced JSON</summary>
            <Textarea aria-label="Process definition" value={editing.text} spellCheck={false} mono className="w-full" onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          </details>
          <div className="mt-1 flex gap-2">
            <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>Save process</Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
