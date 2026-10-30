import { useEffect, useRef, useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { announceRecordChange, Badge, Button, FileDrop, useEditLocked, FindingsList, Section } from '@wirehub/editor-react';
import { request } from './definitions.browser.ts';
import { coverKey } from './representations.browser.ts';
import { localDateTime } from './when.ts';
import { RunRepro } from './repro/RunRepro.tsx';

/** Native tool outputs of a board (`server/jobs/board-outputs.ts`): start the stage, follow it, download what it made. */

interface OutputFile { path: string; role: string; mediaType: string; size: number; sha256: string; href: string }
interface RunView {
  id: string; op: string; status: 'ok' | 'failed'; pack: string; packVersion: string; createdAt: string; durationMs?: number;
  tool: { name: string; version: string }; sources: { role: string; sha256: string }[];
  findings: { level: 'info' | 'warn' | 'error'; message: string }[]; outputs: OutputFile[]; logHref: string;
}
interface JobView { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'; steps: { at: string; text: string }[]; error?: string; createdAt: string }
interface OutputsView {
  available: { ok: boolean; reason?: string };
  source: { imported?: string; stored?: { path: string; sha256: string }; art?: string };
  pack: { version: string; tool: string; ops: Record<string, { label: string }> };
  latest: RunView[];
  jobs: JobView[];
}

const key = (id: string): readonly string[] => ['tool-outputs', 'pcbas', id];
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function readOutputs(id: string): Promise<OutputsView> {
  const out = await request<OutputsView>(`/api/tool-outputs/pcbas/${encodeURIComponent(id)}`, { method: 'GET' });
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function BoardOutputs({ id, editable }: { id: string; editable: boolean }): JSX.Element | null {
  const client = useQueryClient();
  const locked = useEditLocked();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [file, setFile] = useState<File>();
  const [replacing, setReplacing] = useState(false);
  const query = useQuery({
    queryKey: key(id), queryFn: () => readOutputs(id), retry: false, staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : false),
  });
  const data = query.data;
  const active = data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const last = data?.jobs[0];
  // a finished run adds cover candidates and may have built the 3D model: let the cover picker, the
  // record's views and its stepper read the board again
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const finished = last !== undefined && last.status !== 'queued' && last.status !== 'running' ? `${last.id}:${last.status}` : undefined;
    if (finished !== undefined && seen.current !== undefined && seen.current !== finished) {
      void client.invalidateQueries({ queryKey: coverKey('pcbas', id) });
      void client.invalidateQueries({ queryKey: ['representations'] });
      announceRecordChange('pcbas', id);
    }
    seen.current = finished ?? seen.current ?? '';
  }, [last, client, id]);

  // the newest Gerber set this stage made, offered as the board's art while its art is only a native preview
  const gerbers = data?.latest.find((r) => r.op === 'fab' && r.status === 'ok')?.outputs.find((o) => o.role === 'fab-gerbers');
  const useGerbers = async (): Promise<void> => {
    if (gerbers === undefined || busy) return;
    setBusy(true);
    setMessage('Reading the generated Gerbers…');
    try {
      const bytes = new Uint8Array(await (await fetch(gerbers.href)).arrayBuffer());
      const started = await request<{ job: { id: string } }>('/api/modules/board-import/_import/gerbers', { method: 'POST', body: { fileName: `${id}-${gerbers.path}`, base64: toBase64(bytes), job: true, options: { board: id } } });
      if (!started.ok) return setMessage(started.message);
      // the import is a job: wait for its plan, then publish it (one change set, like the Board import page)
      let status = 'queued';
      for (let i = 0; i < 120 && (status === 'queued' || status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await request<{ job: { status: string; error?: string } }>(`/api/jobs/${encodeURIComponent(started.value.job.id)}`, { method: 'GET' });
        if (job.ok) status = job.value.job.status;
        if (job.ok && status === 'failed') return setMessage(job.value.job.error ?? 'The Gerber import failed.');
      }
      if (status !== 'done') return setMessage('The Gerber import is still running; see Jobs.');
      const published = await request<{ committed?: boolean; hint?: string }>(`/api/jobs/${encodeURIComponent(started.value.job.id)}/publish`, { method: 'POST', body: {} });
      if (!published.ok) return setMessage(published.message);
      setMessage(published.value.committed === false ? published.value.hint ?? 'Nothing to change.' : 'The generated Gerbers are now the board’s art.');
      void client.invalidateQueries({ queryKey: coverKey('pcbas', id) });
      void client.invalidateQueries({ queryKey: ['representations'] });
      announceRecordChange('pcbas', id);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  };

  if (query.error !== null) return <section aria-label="Native outputs" className="border-t border-line p-2 text-xs text-err">{query.error.message}</section>;
  if (data === undefined) return null;
  const needsFile = data.source.stored === undefined;
  // the `netlist` op is the board journey's KiCad check (BoardCheck.tsx), not an output
  const outputRuns = data.latest.filter((run) => run.op !== 'netlist');

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const body = file === undefined ? {} : { fileName: file.name, base64: toBase64(new Uint8Array(await file.arrayBuffer())) };
      const out = await request<{ job: JobView; notes: string[] }>(`/api/tool-outputs/pcbas/${encodeURIComponent(id)}`, { method: 'POST', body });
      if (out.ok) {
        setFile(undefined);
        setReplacing(false);
        setMessage(out.value.notes.join(' ') || undefined);
      } else setMessage(out.message);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (jobId: string): Promise<void> => {
    const out = await request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: {} });
    if (!out.ok) setMessage(out.message);
    await query.refetch();
  };

  return <Section id="native-outputs" title="Native outputs" testId="board-outputs" defaultOpen={outputRuns.length > 0 || active !== undefined}
    summary={<span title={data.source.stored?.path}>{data.pack.tool}{data.source.stored === undefined ? '' : ' · source file stored'}{outputRuns.length === 0 ? '' : ` · ${outputRuns.length} run${outputRuns.length === 1 ? '' : 's'}`}</span>}>
    <div className="flex flex-col gap-2">
    {data.available.ok ? null : <p role="status" className="text-xs text-faint">{data.available.reason}</p>}
    {!editable || !data.available.ok ? null : <div className="flex flex-col gap-2">
      {needsFile || replacing ? <FileDrop accept=".kicad_pcb" onFiles={([f]) => setFile(f)} disabled={busy || locked}
        hint={needsFile ? 'No KiCad source is stored for this board yet; it is kept with the board and every output records its hash.' : undefined}>
        {file === undefined ? 'Choose the board’s .kicad_pcb' : file.name}
      </FileDrop> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={busy || locked || active !== undefined || ((needsFile || replacing) && file === undefined)} onClick={() => void start()}>Generate outputs</Button>
        {needsFile || replacing ? null : <Button size="xs" variant="ghost" disabled={busy || locked} onClick={() => setReplacing(true)} title="Run from another .kicad_pcb (it is stored and hashed)">Use another file</Button>}
        {active === undefined ? null : <Button size="xs" variant="ghost" onClick={() => void cancel(active.id)}>Cancel</Button>}
        {gerbers === undefined || data.source.art === 'gerber' ? null : <Button size="xs" variant="ghost" disabled={busy || locked || active !== undefined} onClick={() => void useGerbers()} title="Import the Gerber set the last run made as this board’s art (entry guides and fab-layer pictures need it)">Use generated Gerbers as art</Button>}
      </div>
    </div>}
    {last === undefined ? null : <div className="text-xs" role="status">
      <span className="font-medium">{last.status === 'queued' ? 'Waiting for the worker' : last.status === 'running' ? 'Running' : last.status === 'done' ? 'Last run finished' : last.status === 'cancelled' ? 'Last run cancelled' : last.status === 'interrupted' ? 'Last run interrupted (the worker stopped)' : 'Last run failed'}</span>
      {last.steps.length === 0 ? null : <span className="text-faint"> · {last.steps.at(-1)!.text}</span>}
      {(last.status === 'failed' || last.status === 'interrupted') && last.error !== undefined ? <p className="text-err">{last.error}</p> : null}
    </div>}
    {outputRuns.length === 0 ? null : <ul className="flex flex-col gap-2">
      {outputRuns.map((run) => {
        const pictures = run.outputs.filter((o) => o.mediaType === 'image/png');
        return <li key={run.id} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{data.pack.ops[run.op]?.label ?? run.op}</span>
            <Badge tone={run.status === 'ok' ? 'ok' : 'err'}>{run.status}</Badge>
            <span className="text-faint" title={`${run.tool.name} ${run.tool.version}`}>{run.tool.name} {run.tool.version} · {<span title={run.createdAt}>{localDateTime(run.createdAt)}</span>}</span>
            <a className="text-faint underline" href={run.logHref} target="_blank" rel="noreferrer">log</a>
            <RunRepro runId={run.id} canRun={editable && data.available.ok && !locked} onStarted={() => void query.refetch()} />
          </div>
          {pictures.length === 0 ? null : <div className="flex gap-2">{pictures.map((p) => <img key={p.sha256} src={p.href} alt={`${run.op} ${p.role}`} loading="lazy" className="h-20 w-28 border border-line object-contain" />)}</div>}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {run.outputs.map((o) => <a key={o.path} href={o.href} download={o.path} className="underline" title={o.role}>{o.path} <span className="text-faint">({size(o.size)})</span></a>)}
          </div>
          <FindingsList findings={run.findings.filter((f) => f.level !== 'info')} />
        </li>;
      })}
    </ul>}
    {message === undefined ? null : <p role="status" className="text-xs">{message}</p>}
    </div>
  </Section>;
}
