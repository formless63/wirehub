/**
 * Device exports (`server/devices/api.ts`): the whole device as an assembly STEP and GLB with an
 * A3 orthographic drawing, made by the enclosure pack from the stored design or the saved version
 * being viewed. The server reads the stored design, so unsaved edits are saved first: what is
 * exported is always what is on screen. Each run says which revision it was made from.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, FindingsList, ModelViewer, SegmentedControl, cx } from '@wirehub/editor-react';

import { RunRepro } from '../repro/RunRepro.tsx';
import { coverKey, readCover, saveCover } from '../representations.browser.ts';
import { cancelDeviceExport, deviceExportsKey, exportsForView, readDeviceExports, startDeviceExport, type DeviceExportRun } from './device-exports.browser.ts';

const LABELS: Record<string, string> = {
  'device-step': 'STEP', 'device-glb': 'GLB', 'device-drawing-pdf': 'Drawing (PDF)', 'device-drawing': 'Drawing (SVG)', 'preview-image': 'Preview (PNG)', result: 'Result (JSON)',
};
const ORDER = ['device-step', 'device-glb', 'device-drawing-pdf', 'device-drawing', 'preview-image', 'result'];

const revOf = (run: DeviceExportRun): number | undefined => run.params.design?.rev;
/** a run without a revision was made from the working copy as saved at that moment (`when`) */
const madeFrom = (run: DeviceExportRun): string => (revOf(run) === undefined ? 'Working copy' : `Rev ${revOf(run)}`);
const pad = (n: number): string => String(n).padStart(2, '0');
/** local time, to the minute */
const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function DeviceExports(props: { design: string; rev?: number; canExport: boolean; dirty?: boolean; save?: () => Promise<{ ok: true } | { ok: false; message: string }> }): JSX.Element {
  const { design, rev } = props;
  const query = useQuery({
    queryKey: deviceExportsKey(design),
    queryFn: () => readDeviceExports(design),
    refetchInterval: (q) => (q.state.data?.job?.status === 'queued' || q.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const data = query.data;
  const job = data?.job ?? null;
  const active = job !== null && (job.status === 'queued' || job.status === 'running') ? job : undefined;
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | undefined>();

  // a job that just finished: say so once
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const now = job === null ? undefined : `${job.id}:${job.status}`;
    if (active === undefined && now !== undefined && seen.current !== undefined && seen.current !== now) {
      if (job?.status === 'cancelled') setMessage({ tone: 'info', text: 'Cancelled; nothing was kept.' });
      else if (job?.status === 'failed' || job?.status === 'interrupted') setMessage({ tone: 'err', text: job.error ?? 'The export did not finish.' });
    }
    seen.current = now;
  }, [job, active]);

  const all = data?.runs ?? [];
  // a saved version's view lists only exports made from that version: a working-copy
  // export may hold newer geometry, so it is never offered from a Rev page
  const runs = useMemo(() => exportsForView(all, rev), [all, rev]);
  // the run shown: the one picked, else the newest made from what is being viewed, else the newest
  const shown = useMemo(() => runs.find((r) => r.id === picked) ?? runs.find((r) => r.status === 'ok' && revOf(r) === rev) ?? runs[0], [runs, picked, rev]);
  const drawing = shown?.outputs.find((o) => o.role === 'device-drawing');
  const glb = shown?.outputs.find((o) => o.role === 'device-glb');
  // the export's own GLB in the 3D viewer, read only when asked for
  const [look, setLook] = useState<'drawing' | '3d'>('drawing');
  const model = useQuery({
    queryKey: ['device-export-glb', glb?.sha256],
    queryFn: async () => {
      const res = await fetch(glb!.href, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`The GLB could not be read (${res.status}).`);
      return res.arrayBuffer();
    },
    enabled: look === '3d' && glb !== undefined,
    staleTime: Infinity,
  });

  // the newest export's preview is a cover candidate of the design (`server/representations.ts`): offer it here
  const client = useQueryClient();
  const cover = useQuery({ queryKey: coverKey('designs', design), queryFn: () => readCover('designs', design), staleTime: 30_000, enabled: props.canExport });
  const candidate = cover.data?.candidates.find((c) => c.view === 'device-preview');
  const isCover = candidate !== undefined && cover.data?.choice?.view === 'device-preview' && cover.data.choice.lineage === candidate.lineage;
  const newest = all.find((r) => r.status === 'ok' && r.outputs.some((o) => o.role === 'preview-image'));
  const makeCover = async (): Promise<void> => {
    if (cover.data === undefined || candidate === undefined) return;
    const out = await saveCover('designs', design, { view: candidate.view, lineage: candidate.lineage }, cover.data.etag);
    if (!out.ok) setMessage({ tone: 'err', text: out.message });
    await client.invalidateQueries({ queryKey: coverKey('designs', design) });
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    // the server exports the stored design: save the edits on screen first
    if (rev === undefined && props.dirty === true) {
      const saved = props.save === undefined ? { ok: false as const, message: 'Save the design to export it.' } : await props.save();
      if (!saved.ok) { setBusy(false); setMessage({ tone: 'err', text: saved.message }); return; }
    }
    const out = await startDeviceExport(design, rev);
    setBusy(false);
    if (!out.ok) { setMessage({ tone: 'err', text: out.message }); return; }
    setPicked(undefined);
    await query.refetch();
  };
  const cancel = async (id: string): Promise<void> => {
    const out = await cancelDeviceExport(id);
    if (!out.ok) setMessage({ tone: 'err', text: out.message });
    await query.refetch();
  };

  return (
    <section aria-label="Device exports" className="flex flex-col gap-2" data-testid="device-exports">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Exports</h3>
        <span className="ml-auto flex gap-2">
          {active === undefined || !props.canExport ? null : <Button size="sm" variant="ghost" onClick={() => void cancel(active.id)}>Cancel</Button>}
          <Button size="sm" variant="primary" disabled={!props.canExport || busy || active !== undefined || data?.available.ok === false} loading={busy || active !== undefined} onClick={() => void start()}
            title={rev === undefined && props.dirty === true ? 'Saves the design first' : undefined}>
            {rev === undefined ? 'Export STEP, GLB and drawing' : `Export Rev ${rev}`}
          </Button>
        </span>
      </div>
      {data?.available.ok === false ? <p role="status" className="text-xs text-faint">{data.available.reason}</p> : null}
      {active === undefined ? null : (
        <p role="status" className="text-xs" data-testid="device-export-job">
          <span className="font-medium">{active.status === 'queued' ? 'Waiting for the worker' : 'Assembling'}</span>
          {active.steps.length === 0 ? null : <span className="text-faint"> · {active.steps.at(-1)!.text}</span>}
        </p>
      )}
      {message === undefined ? null : <p role="status" className={message.tone === 'err' ? 'text-xs text-err' : 'text-xs'}>{message.text}</p>}
      {runs.length === 0 ? (data === undefined || rev !== undefined ? null : <p className="text-xs text-faint">No exports yet.</p>) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)' }}>
          <table className="w-full self-start text-xs" data-testid="device-export-runs">
            <thead className="text-faint"><tr><th className="text-left font-normal">Made</th><th className="text-left font-normal">From</th><th className="text-left font-normal">Status</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={cx('cursor-pointer hover:bg-hover', shown?.id === r.id && 'bg-selected')} onClick={() => setPicked(r.id)} data-run={r.id}>
                  <td className="py-0.5 pr-2 tabular-nums">{when(r.createdAt)}</td>
                  <td className="pr-2">{madeFrom(r)}</td>
                  <td>{r.status === 'ok' ? <Badge tone="ok">ok</Badge> : <Badge tone="err">failed</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown === undefined ? null : (
            <div className="flex min-w-0 flex-col gap-2" data-testid="device-export-shown">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{madeFrom(shown)}, {when(shown.createdAt)}</span>
                <span className="text-faint">{shown.params.parts ?? '?'} parts</span>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {[...shown.outputs].sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role)).map((o) => (
                  <a key={o.sha256} className="cs-ui-btn no-underline" href={o.href} download={`${design}${revOf(shown) === undefined ? '' : `-rev${revOf(shown)}`}-${o.path}`}>{LABELS[o.role] ?? o.path}</a>
                ))}
                {shown.id === newest?.id && candidate !== undefined && props.canExport ? (
                  <Button size="sm" variant="ghost" disabled={isCover} onClick={() => void makeCover()} title="The design's cover in lists and pickers">{isCover ? 'Cover' : 'Use as cover'}</Button>
                ) : null}
                <a className="cs-ui-btn no-underline" href={shown.logHref} target="_blank" rel="noreferrer"
                  title={`${shown.pack} ${shown.packVersion} · ${shown.tool.name} ${shown.tool.version}`}>Log</a>
              </div>
              <RunRepro runId={shown.id} canRun={props.canExport && data?.available.ok === true} onStarted={() => void query.refetch()} />
              {drawing !== undefined && glb !== undefined ? (
                <SegmentedControl size="xs" className="self-start" aria-label="Show the export as" value={look} onValueChange={(v) => setLook(v as 'drawing' | '3d')}
                  options={[{ value: 'drawing', label: 'Drawing' }, { value: '3d', label: '3D' }]} />
              ) : null}
              {look === '3d' && glb !== undefined ? (
                model.data === undefined
                  ? <div className="flex h-[420px] items-center justify-center text-sm text-faint">{model.error === null ? 'Loading the model…' : model.error.message}</div>
                  : <ModelViewer bytes={model.data} mime="model/gltf-binary" label={`${design}, ${madeFrom(shown)}`} height={420} />
              ) : drawing === undefined ? null : (
                <a href={drawing.href} target="_blank" rel="noreferrer" title="Open the drawing sheet">
                  <img src={drawing.href} alt={`Orthographic drawing of ${design}, ${madeFrom(shown)}`} className="w-full rounded-md border border-line bg-panel" loading="lazy" />
                </a>
              )}
              <FindingsList findings={shown.findings} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
