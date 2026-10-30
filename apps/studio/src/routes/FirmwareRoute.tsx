import { newRecordId } from '../display.ts';
/**
 * `/firmware` and `/firmware/$id` (`docs/firmware.md`): firmware projects linked to a board and to
 * the board's placements in designs (occurrences), each with its own configuration overrides; a
 * compile through the offline `firmware-platformio` tool pack, its binaries, size, log and the
 * exact toolchain. Compiling makes files only — flashing and commissioning are not done here.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { Button, Callout, Chip, DataTable, Field, FileDrop, IconButton, Input, KeyValues, Page, PageBody, Select, type DataColumn, type Tone, FindingsList } from '@wirehub/editor-react';

import { EmptyState } from '../shell/EmptyState.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { useStudio } from '../studio-context.tsx';
import { cancelJob } from '../jobs.browser.ts';
import { unwrap } from '../products.browser.ts';
import type { ConfigParams, FirmwareBuild, FirmwareOccurrence, FirmwareProject } from '../firmware.ts';
import {
  configText,
  fetchFirmware,
  fetchFirmwareProject,
  fetchOccurrences,
  fileToBase64,
  fileUrl,
  firmwareKey,
  firmwareOccurrencesKey,
  firmwareProjectKey,
  formatConfigValue,
  parseConfigValue,
  saveFirmware,
  startCompile,
  uploadSource,
} from '../firmware.browser.ts';
import { localDateTime } from '../when.ts';
import { bundleUrl } from '../firmware-commission.browser.ts';
import { FirmwareCommissioning } from './FirmwareCommissioning.tsx';

export interface FirmwareSearch {
  board?: string;
  design?: string;
  instance?: string;
}

export function validateFirmwareSearch(search: Record<string, unknown>): FirmwareSearch {
  const out: FirmwareSearch = {};
  for (const key of ['board', 'design', 'instance'] as const) {
    const v = search[key];
    if (typeof v === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(v)) out[key] = v;
  }
  return out;
}

const STATUS_TONE: Record<FirmwareBuild['status'], Tone> = { queued: 'info', running: 'info', ok: 'ok', failed: 'err', error: 'warn', cancelled: 'neutral' };
const STATUS_LABEL: Record<FirmwareBuild['status'], string> = { queued: 'Waiting for the worker', running: 'Compiling…', ok: 'Compiled', failed: 'Build failed', error: 'Could not run', cancelled: 'Cancelled' };
const isOpen = (b: FirmwareBuild): boolean => b.status === 'queued' || b.status === 'running';
const kib = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);
const when = (iso: string): string => localDateTime(iso, true);

/* ------------------------------------------------------------------ *
 * Configuration rows: NAME = value, typed on the way out
 * ------------------------------------------------------------------ */

function ConfigEditor({ value, onChange, readOnly, base, label }: { value: ConfigParams; onChange: (next: ConfigParams) => void; readOnly: boolean; base?: ConfigParams; label: string }): JSX.Element {
  const [draft, setDraft] = useState<{ name: string; value: string }>({ name: '', value: '' });
  const rows = Object.entries(value);
  return (
    <div className="flex flex-col gap-1" data-testid={`config-${label}`}>
      {rows.length === 0 ? <span className="text-sm text-muted">{base === undefined ? 'No values yet.' : 'Same as the project defaults.'}</span> : null}
      {rows.map(([name, v]) => (
        <div key={name} className="flex items-center gap-2">
          <code className="w-40 text-sm">{name}</code>
          <Input aria-label={`${label} ${name}`} className="w-48" mono disabled={readOnly} defaultValue={formatConfigValue(v)}
            onBlur={(e) => { const next = parseConfigValue(e.target.value); if (next !== v) onChange({ ...value, [name]: next }); }} />
          {base?.[name] === undefined ? null : <span className="text-sm text-muted">default {formatConfigValue(base[name] ?? null) || '(defined)'}</span>}
          {readOnly ? null : <IconButton label={`Remove ${name}`} icon={<IconTrash size={14} />} onClick={() => { const { [name]: _gone, ...rest } = value; onChange(rest); }} />}
        </div>
      ))}
      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <Input aria-label={`${label} new name`} className="w-40" mono placeholder="NAME" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
          <Input aria-label={`${label} new value`} className="w-48" mono placeholder="value" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          <Button size="sm" icon={<IconPlus size={14} />} disabled={!/^[A-Z_][A-Z0-9_]*$/.test(draft.name)}
            onClick={() => { onChange({ ...value, [draft.name]: parseConfigValue(draft.value) }); setDraft({ name: '', value: '' }); }}>
            {base === undefined ? 'Add value' : 'Override'}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * /firmware
 * ------------------------------------------------------------------ */

export function FirmwareRoute(): JSX.Element {
  const studio = useStudio();
  const readOnly = studio.me?.role === 'viewer';
  const search = useSearch({ strict: false }) as FirmwareSearch;
  const client = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: firmwareKey, queryFn: () => unwrap(fetchFirmware()), retry: false });
  const [adding, setAdding] = useState(search.board !== undefined || search.design !== undefined);
  const [form, setForm] = useState({ label: '', board: search.board ?? '', target: 'd1_mini', src: 'synthetic example' });
  const boardLabel = (id?: string): string => (id === undefined ? '—' : studio.db.pcbas.find((b) => b.id === id)?.label ?? 'Unavailable board');
  const shown = (list.data?.projects ?? []).filter((p) => search.board === undefined || p.board === search.board);

  const columns = useMemo((): DataColumn<FirmwareProject>[] => [
    { id: 'label', header: 'Project', width: 240, sortValue: (p) => p.label, cell: (p) => <Link to="/firmware/$id" params={{ id: p.id }} className="font-semibold underline">{p.label}</Link> },
    { id: 'board', header: 'Board', width: 220, sortValue: (p) => boardLabel(p.board), cell: (p) => p.board === undefined ? <span className="text-muted">none</span> : <Link to="/library/$kind/$id" params={{ kind: 'boards', id: p.board }} className="underline">{boardLabel(p.board)}</Link> },
    { id: 'target', header: 'Target', width: 120, mono: true, cell: (p) => p.toolchain.target },
    { id: 'occ', header: 'Occurrences', width: 110, numeric: true, sortValue: (p) => p.occurrences.length, cell: (p) => p.occurrences.length },
    { id: 'src', header: 'Files', width: 80, numeric: true, cell: (p) => p.source.length },
  ], [studio.db.pcbas]);

  const create = async (): Promise<void> => {
    if (list.data === undefined) return;
    const id = newRecordId(form.label, list.data.projects.map((p) => p.id), 'firmware');
    const occurrences: FirmwareOccurrence[] = search.design !== undefined && search.instance !== undefined ? [{ design: search.design, instance: search.instance, overrides: {} }] : [];
    const project: FirmwareProject = {
      id, label: form.label.trim(), src: form.src.trim() || 'not stated', ...(form.board === '' ? {} : { board: form.board }),
      toolchain: { pack: list.data.targets.find((t) => t.id === form.target)?.pack ?? 'firmware-platformio', target: form.target }, source: [], params: {}, occurrences,
    };
    const out = await saveFirmware([...list.data.projects, project], list.data.etag);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    client.setQueryData(firmwareKey, out.value);
    toast.success(`Created ${project.label}.`);
    void navigate({ to: '/firmware/$id', params: { id } });
  };

  return (
    <Page>
      <RouteHeader title="Firmware" count={list.data === undefined ? undefined : `${shown.length} project${shown.length === 1 ? '' : 's'}`}
        primary={readOnly ? undefined : <Button variant="primary" onClick={() => setAdding(true)}>New firmware project</Button>} />
      <PageBody padded>
        {search.board === undefined ? null : (
          <Callout tone="info" action={<Link to="/firmware" className="underline">Show all</Link>}>Projects for {boardLabel(search.board)}.</Callout>
        )}
        {list.error === null ? null : <Callout tone="err">{String(list.error.message)}</Callout>}
        {!adding || readOnly ? null : (
          <fieldset className="mb-3 flex flex-wrap items-end gap-2 rounded-md border border-line p-2" data-testid="new-firmware">
            <legend>New firmware project</legend>
            <Field label="Name"><Input aria-label="Project name" className="w-56" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
            <Field label="Board">
              <Select aria-label="Board" className="w-56" placeholder="No board yet" value={form.board === '' ? undefined : form.board}
                options={studio.db.pcbas.map((b) => ({ value: b.id, label: b.label }))} onValueChange={(v) => setForm({ ...form, board: v })} />
            </Field>
            <Field label="Target">
              <Select aria-label="Target" className="w-56" value={form.target} options={(list.data?.targets ?? []).map((t) => ({ value: t.id, label: t.label }))} onValueChange={(v) => setForm({ ...form, target: v })} />
            </Field>
            <Field label="Source from"><Input aria-label="Source provenance" className="w-56" value={form.src} onChange={(e) => setForm({ ...form, src: e.target.value })} /></Field>
            <Button variant="primary" disabled={form.label.trim() === ''} onClick={() => void create()}>Create</Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            {search.design === undefined ? null : <span className="text-sm text-muted">Linked to {studio.designs.find((d) => d.id === search.design)?.label ?? 'the selected design'} · {search.instance} once created.</span>}
          </fieldset>
        )}
        <DataTable label="Firmware projects" testId="firmware-projects" rows={shown} columns={columns} getRowId={(p) => p.id} columnsKey="firmware" loading={list.isLoading}
          empty={<EmptyState topic="library-pcbas">No firmware projects yet.</EmptyState>} />
      </PageBody>
    </Page>
  );
}

/* ------------------------------------------------------------------ *
 * /firmware/$id
 * ------------------------------------------------------------------ */

function BuildDetails({ build, project, onCancel, placement }: { build: FirmwareBuild; project: string; onCancel?: (job: string) => void; placement: (o: { design: string; instance: string }) => string }): JSX.Element {
  const size = build.findings.filter((f) => /^(RAM|FLASH):/.test(f.message)).map((f) => f.message).join(' · ');
  const platforms = (build.toolchain?.platforms ?? []).map((p) => `${p.name} ${p.version}`).join(', ');
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-2" data-testid={`build-${build.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={STATUS_TONE[build.status]}>{STATUS_LABEL[build.status]}</Chip>
        <span className="text-sm">{when(build.startedAt)}</span>
        <span className="text-sm text-muted">{build.occurrence === undefined ? 'project defaults' : placement(build.occurrence)}</span>
        {build.durationMs === undefined ? null : <span className="text-sm text-muted">{(build.durationMs / 1000).toFixed(1)} s</span>}
        {size === '' ? null : <span className="text-sm">{size}</span>}
        {build.job === undefined ? null : <a className="text-sm text-muted" href={`/jobs?job=${build.job}`} title="The compile's job">job</a>}
        {!isOpen(build) || build.job === undefined || onCancel === undefined ? null : <Button size="xs" variant="ghost" onClick={() => onCancel(build.job!)}>Cancel</Button>}
      </div>
      {!isOpen(build) || build.progress === undefined ? null : <span className="text-sm text-muted" role="status">{build.progress}</span>}
      {build.message === undefined ? null : <Callout tone={build.status === 'cancelled' ? 'info' : 'warn'}>{build.message}</Callout>}
      {build.outputs.length === 0 && build.log === undefined ? null : (
        <div className="flex flex-wrap gap-2">
          {build.outputs.map((o) => (
            <a key={o.sha256} className="cs-ui-btn no-underline" href={fileUrl(project, o.sha256)} download={o.path.split('/').pop()} title={o.role}>
              {o.path} <span className="text-muted">{kib(o.bytes)}</span>
            </a>
          ))}
          {build.log === undefined ? null : <a className="cs-ui-btn no-underline" href={fileUrl(project, build.log)} download="build-log.txt">Build log</a>}
          {build.status !== 'ok' || !build.outputs.some((o) => o.role === 'firmware') ? null : (
            <a className="cs-ui-btn no-underline" href={bundleUrl(project, build.id)} download title="The firmware files, their hashes and flashing instructions, for the bench">Flash bundle</a>
          )}
        </div>
      )}
      <FindingsList findings={build.findings.filter((f) => f.level !== 'info')} />
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">Details</summary>
        <KeyValues items={[
          ['Configuration', <code key="c">{configText(build.effective.defines) || '—'}</code>],
          ['Toolchain', build.tool === undefined ? '—' : `${build.pack ?? ''} ${build.packVersion ?? ''} · ${build.tool.name} ${build.tool.version}${platforms === '' ? '' : ` · ${platforms}`}`],
          ['Image', build.image ?? '—'],
          ['Packages', (build.toolchain?.packages ?? []).map((p) => `${p.name} ${p.version}`).join(', ') || '—'],
          ['Source', build.effective.source.map((s) => s.path).join(', ')],
        ]} />
      </details>
    </div>
  );
}

export function FirmwareProjectRoute(): JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const search = useSearch({ strict: false }) as FirmwareSearch;
  const studio = useStudio();
  const readOnly = studio.me?.role === 'viewer';
  const client = useQueryClient();
  const page = useQuery({
    queryKey: firmwareProjectKey(id), queryFn: () => unwrap(fetchFirmwareProject(id)), retry: false,
    refetchInterval: (q) => (q.state.data?.builds.some(isOpen) === true ? 1500 : false),
  });
  const project = page.data?.project;
  const occurrences = useQuery({ queryKey: firmwareOccurrencesKey(project?.board), queryFn: () => unwrap(fetchOccurrences(project?.board)), enabled: project !== undefined, retry: false });
  const [pick, setPick] = useState<string | undefined>(search.design !== undefined && search.instance !== undefined ? `${search.design}/${search.instance}` : undefined);
  const [uploading, setUploading] = useState(false);
  const [network, setNetwork] = useState(false);
  const [details, setDetails] = useState<Pick<FirmwareProject, 'label' | 'board' | 'src' | 'toolchain'>>();

  if (page.error !== null) return <Page><RouteHeader title="Firmware" /><PageBody padded><Callout tone="err">{String(page.error.message)}</Callout></PageBody></Page>;
  if (page.data === undefined || project === undefined) return <Page><RouteHeader title="Firmware" /><PageBody padded><span className="text-muted">Loading…</span></PageBody></Page>;
  const data = page.data;
  const target = data.targets.find((t) => t.id === project.toolchain.target);

  const save = async (next: FirmwareProject, message: string): Promise<boolean> => {
    const all = await unwrap(fetchFirmware());
    const out = await saveFirmware(all.projects.map((p) => (p.id === next.id ? next : p)), all.etag);
    if (!out.ok) { toast.error(out.message, { description: out.hint }); return false; }
    client.setQueryData(firmwareKey, out.value);
    await client.invalidateQueries({ queryKey: firmwareProjectKey(id) });
    toast.success(message);
    return true;
  };
  const compile = async (occurrence?: { design: string; instance: string }): Promise<void> => {
    const out = await startCompile(id, occurrence, network);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    await client.invalidateQueries({ queryKey: firmwareProjectKey(id) });
  };
  const cancelCompile = async (job: string): Promise<void> => {
    const out = await cancelJob(job);
    if (!out.ok) toast.error(out.error, { description: out.hint });
    await client.invalidateQueries({ queryKey: firmwareProjectKey(id) });
  };
  const store = async (payload: { path: string; base64: string }[], done: string): Promise<void> => {
    const out = await uploadSource(id, payload, data.etag);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    await client.invalidateQueries({ queryKey: firmwareProjectKey(id) });
    toast.success(done);
  };
  const upload = async (files: File[]): Promise<void> => {
    setUploading(true);
    try {
      const payload = await Promise.all(files.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, base64: await fileToBase64(f) })));
      await store(payload, `Stored ${files.length} source file${files.length === 1 ? '' : 's'}.`);
    } finally {
      setUploading(false);
    }
  };
  const fromExample = async (example: string): Promise<void> => {
    const files = data.examples?.find((e) => e.id === example)?.files;
    if (files === undefined) return;
    setUploading(true);
    try {
      await store(files, `Started from ${example.replaceAll('-', ' ')}.`);
    } finally {
      setUploading(false);
    }
  };
  const linked = new Set(project.occurrences.map((o) => `${o.design}/${o.instance}`));
  const candidates = (occurrences.data?.occurrences ?? []).filter((o) => !linked.has(`${o.design}/${o.instance}`));
  const finding = (o: FirmwareOccurrence) => data.occurrences.find((x) => x.design === o.design && x.instance === o.instance);
  // a placement by its design's name, not its id
  const placement = (o: { design: string; instance: string }): string => `${finding({ ...o, overrides: {} })?.designLabel ?? 'Unavailable design'} / ${o.instance}`;

  return (
    <Page>
      <RouteHeader title={project.label}
        secondary={<Link to="/firmware" className="cs-ui-btn no-underline">All firmware</Link>}
        primary={readOnly ? undefined : <Button variant="primary" disabled={project.source.length === 0} title="Makes files only; nothing is flashed. Flashing is done at the bench and recorded under Commissioning." onClick={() => void compile()}>Compile</Button>} />
      <PageBody padded>
        <div className="flex flex-col gap-3">
          <KeyValues items={[
            ['Board', data.board === null ? <span key="b" className="text-muted">none linked</span> : data.board.missing === true
              ? <span key="b" className="text-warn">Board removed from the library</span>
              : <Link key="b" to="/library/$kind/$id" params={{ kind: 'boards', id: data.board.id }} className="underline">{data.board.label}</Link>],
            ['Target', `${target?.label ?? project.toolchain.target} · ${target?.platform ?? ''} · ${target?.framework ?? ''}`],
            ['Source from', (project.src ?? '').trim() === '' ? <span key="s" className="text-warn">not said yet</span> : project.src],
          ]} />

          {readOnly ? null : <>
            {details === undefined ? <Button className="self-start" size="sm" onClick={() => setDetails({ label: project.label, board: project.board, src: project.src, toolchain: project.toolchain })}>Edit project details</Button> : <fieldset className="grid grid-cols-2 gap-2 rounded border border-line p-2"><legend>Project details</legend>
              <Field label="Name"><Input aria-label="Project name" value={details.label} onChange={(e) => setDetails({ ...details, label: e.target.value })} /></Field>
              <Field label="Board"><Select aria-label="Project board" value={details.board ?? '__none__'} options={[{ value: '__none__', label: 'No board linked' }, ...studio.db.pcbas.map((b) => ({ value: b.id, label: b.label }))]} onValueChange={(v) => setDetails({ ...details, board: v === '__none__' ? undefined : v })} /></Field>
              <Field label="Target"><Select aria-label="Project target" value={details.toolchain.target} options={data.targets.map((t) => ({ value: t.id, label: t.label }))} onValueChange={(v) => { const t = data.targets.find((t) => t.id === v); if (t) setDetails({ ...details, toolchain: { ...details.toolchain, target: t.id, pack: t.pack ?? project.toolchain.pack } }); }} /></Field>
              <Field label="Source"><Input aria-label="Project source" value={details.src ?? ''} onChange={(e) => setDetails({ ...details, src: e.target.value })} /></Field>
              <div className="col-span-2 flex gap-2"><Button size="sm" disabled={!details.label.trim()} onClick={() => { void save({ ...project, ...details }, 'Saved project details.').then((ok) => { if (ok) setDetails(undefined); }); }}>Save details</Button><Button size="sm" onClick={() => setDetails(undefined)}>Cancel</Button></div>
            </fieldset>}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} />Allow this compile to download project dependencies</label>
            <p className="m-0 text-xs text-faint">Enable when the project needs libraries that are not included with its toolchain. Applies to the next compile, including a selected board placement.</p>
          </>}

          <h2 className="text-md font-semibold">Builds</h2>
          {data.builds.length === 0 ? <span className="text-sm text-muted">Not compiled yet.</span> : data.builds.map((b) => <BuildDetails key={b.id} build={b} project={id} placement={placement} {...(readOnly ? {} : { onCancel: (job: string) => void cancelCompile(job) })} />)}

          <h2 className="text-md font-semibold" title="Where this board is placed in designs, with what differs for each placement.">Occurrences</h2>
          {project.occurrences.length === 0 ? <span className="text-sm text-muted">Not linked to a placement yet.</span> : null}
          {project.occurrences.map((o) => {
            const f = finding(o);
            const key = `${o.design}/${o.instance}`;
            return (
              <div key={key} className={`flex flex-col gap-2 rounded-md border p-2 ${pick === key ? 'border-accent' : 'border-line'}`} data-testid={`occurrence-${key}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link to="/cables/$id" params={{ id: o.design }} className="font-semibold underline">{f?.designLabel ?? 'Unavailable design'}</Link>
                  <Chip mono>{o.instance}</Chip>
                  {f?.problem === undefined ? null : <Chip tone="warn">{f.problem}</Chip>}
                  <span className="cs-ui-grow" />
                  {readOnly ? null : <Button size="sm" disabled={project.source.length === 0} onClick={() => void compile({ design: o.design, instance: o.instance })}>Compile for this occurrence</Button>}
                  {readOnly ? null : <IconButton label={`Unlink ${key}`} icon={<IconTrash size={14} />} onClick={() => void save({ ...project, occurrences: project.occurrences.filter((x) => x !== o) }, `Unlinked ${f?.designLabel ?? 'Unavailable design'} / ${o.instance}.`)} />}
                </div>
                <ConfigEditor label={key} value={o.overrides ?? {}} base={project.params} readOnly={readOnly}
                  onChange={(overrides) => void save({ ...project, occurrences: project.occurrences.map((x) => (x === o ? { ...o, overrides } : x)) }, `Saved the overrides for ${f?.designLabel ?? 'Unavailable design'} / ${o.instance}.`)} />
              </div>
            );
          })}
          {readOnly ? null : (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Link a placement">
                <Select aria-label="Placement" className="w-80" placeholder={candidates.length === 0 ? 'No other placements of this board' : 'Design / board instance…'}
                  disabled={candidates.length === 0} value={pick !== undefined && candidates.some((c) => `${c.design}/${c.instance}` === pick) ? pick : undefined}
                  options={candidates.map((c) => ({ value: `${c.design}/${c.instance}`, label: `${c.designLabel} / ${c.instance}` }))} onValueChange={setPick} />
              </Field>
              <Button disabled={pick === undefined || !candidates.some((c) => `${c.design}/${c.instance}` === pick)} onClick={() => {
                const c = candidates.find((x) => `${x.design}/${x.instance}` === pick);
                if (c !== undefined) void save({ ...project, occurrences: [...project.occurrences, { design: c.design, instance: c.instance, overrides: {} }] }, `Linked ${c.designLabel} / ${c.instance}.`).then(() => setPick(undefined));
              }}>Link</Button>
            </div>
          )}

          <h2 className="text-md font-semibold" title="Passed to the build as C macros (-DNAME=value). Each occurrence can override them.">Configuration</h2>
          <ConfigEditor label="Project" value={project.params} readOnly={readOnly} onChange={(params) => void save({ ...project, params }, 'Saved the configuration.')} />

          <h2 className="text-md font-semibold" title="Folder paths are kept for files dropped from a folder; zip and tar.gz archives are unpacked at build time.">Source</h2>
          {project.source.length === 0 ? <span className="text-sm text-muted">No source yet.</span> : (
            <ul className="flex flex-col gap-1 text-sm" data-testid="firmware-source">
              {project.source.map((f) => (
                <li key={f.path} className="flex gap-2"><a className="underline" href={fileUrl(id, f.sha256)} download={f.path.split('/').pop()}>{f.path}</a><span className="text-muted">{kib(f.bytes)}</span></li>
              ))}
            </ul>
          )}
          {readOnly ? null : (
            <FileDrop multiple disabled={uploading} onFiles={(files) => void upload(files)}>
              {project.source.length === 0 ? 'Drop source files (platformio.ini, src/…) or one .zip / .tar.gz here, or choose them' : 'Replace the source'}
            </FileDrop>
          )}
          {readOnly || project.source.length > 0 || (data.examples?.length ?? 0) === 0 ? null : (
            <Select aria-label="Start from example" className="w-64" placeholder="Or start from an example…" disabled={uploading} value={undefined}
              options={data.examples!.map((e) => ({ value: e.id, label: e.id.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase()) }))} onValueChange={(v) => void fromExample(v)} />
          )}

          <FirmwareCommissioning project={id} builds={data.builds} placement={placement} />
        </div>
      </PageBody>
    </Page>
  );
}
