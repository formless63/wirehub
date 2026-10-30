/**
 * Re-run a finished tool run with its recorded inputs and image, and see how the outputs compare
 * (`server/repro/api.ts`). One quiet line under a run: Re-run, then "identical" or "2 of 7
 * differ"; the per-file compare (sizes, line counts, picture overlay, hashes) opens in a drawer.
 */

import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Drawer, SegmentedControl, Select, cx } from '@wirehub/editor-react';

import { localDateTime } from '../when.ts';
import { compareToolRuns, readRepro, reproKey, runPackageHref, startRerun, type FileCompare, type RunCompare, type RunSummary, type TextDiff } from './repro.browser.ts';

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const FIELD: Record<string, string> = { image: 'Tool image', tool: 'Tool', pack: 'Pack', sources: 'Inputs', params: 'Parameters', status: 'Status' };

function Verdict({ compare, onOpen }: { compare: RunCompare; onOpen: () => void }): JSX.Element {
  const differ = compare.total - compare.same;
  return <Button size="xs" variant="ghost" onClick={onOpen} className="gap-1" data-testid="repro-verdict" title="Compare the two runs file by file">
    {compare.verdict === 'identical' ? <Badge tone="ok">identical</Badge>
      : compare.verdict === 'same-but-times' ? <Badge tone="ok">same but timestamps</Badge>
        : <Badge tone="warn">{differ === 0 ? 'status differs' : `${differ} of ${compare.total} differ`}</Badge>}
    <span className="text-dim">compare</span>
  </Button>;
}

export function RunRepro({ runId, canRun, onStarted, packageLink = true }: { runId: string; canRun: boolean; onStarted?: () => void; packageLink?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState<'rerun' | 'of' | 'choose' | undefined>();
  const [other, setOther] = useState<string>();
  const comparison = useQuery({ queryKey: ['run-compare', runId, other], queryFn: () => compareToolRuns(runId, other!), enabled: open === 'choose' && other !== undefined, retry: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const query = useQuery({
    queryKey: reproKey(runId), queryFn: () => readRepro(runId), retry: false, staleTime: 5_000,
    refetchInterval: (q) => (q.state.data?.rerun?.job.status === 'queued' || q.state.data?.rerun?.job.status === 'running' ? 1500 : false),
  });
  const data = query.data;
  if (data === undefined) return null;
  const job = data.rerun?.job;
  const active = job !== undefined && (job.status === 'queued' || job.status === 'running');
  const rerun = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    const out = await startRerun(runId);
    setBusy(false);
    if (!out.ok) setMessage(out.message);
    onStarted?.();
    await query.refetch();
  };
  const shown = open === 'of' ? data.of ?? undefined : open === 'rerun' && data.rerun?.compare != null && data.rerun.run !== null ? { run: data.rerun.run, compare: data.rerun.compare } : undefined;
  return <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="run-repro" data-run={runId}>
    {data.of === null ? null : <span className="flex items-center gap-1 text-faint">
      <span title={data.of.run.createdAt}>re-run of {localDateTime(data.of.run.createdAt)}</span>
      <Verdict compare={data.of.compare} onOpen={() => setOpen('of')} />
    </span>}
    {!canRun ? null : <Button size="xs" variant="ghost" disabled={busy || active || !data.canRerun.ok} loading={busy || active} onClick={() => void rerun()}
      title={data.canRerun.ok ? 'Run it again from the same inputs in the same tool image, then compare the outputs' : data.canRerun.reason}>Re-run</Button>}
    {job === undefined ? null : active ? <span className="text-faint" role="status">{job.status === 'queued' ? 'waiting for the worker' : job.steps.at(-1)?.text ?? 'running'}</span>
      : job.status !== 'done' ? <span className="text-err" role="status" title={job.error}>re-run {job.status}{job.error === undefined ? '' : `: ${job.error.length > 90 ? `${job.error.slice(0, 90)}…` : job.error}`}</span>
      : data.rerun?.compare == null ? null : <span className="flex items-center gap-1 text-faint"><span title={data.rerun.run?.createdAt}>re-run {data.rerun.run === null ? '' : localDateTime(data.rerun.run.createdAt)}</span><Verdict compare={data.rerun.compare} onOpen={() => setOpen('rerun')} /></span>}
    {packageLink ? <a className="text-faint underline" href={runPackageHref(runId)} download title="Outputs, the exact inputs, a manifest of hashes and tool identity, and verify.py to check it offline">package</a> : null}
    {message === undefined ? null : <span role="status" className="text-err">{message}</span>}
    {(data.comparisons?.length ?? 0) === 0 ? null : <Button size="xs" variant="ghost" onClick={() => { setOther(data.comparisons?.[0]?.id); setOpen('choose'); }}>Compare with…</Button>}
    <Drawer open={shown !== undefined || open === 'choose'} title="Compare runs" onClose={() => setOpen(undefined)} width={620} testId="repro-compare">
      {open !== 'choose' ? null : <div className="mb-3 flex flex-col gap-2"><Select aria-label="Compare with run" value={other} options={(data.comparisons ?? []).map((r, index) => ({ value: r.id, label: `${r.identity?.rev === undefined ? r.identity?.revision ?? 'Working copy' : `Rev ${r.identity.rev}`} · ${localDateTime(r.createdAt, true)} · ${r.status === 'ok' ? 'Completed' : 'Failed'} (${index + 1})` }))} onValueChange={setOther} />{comparison.isPending ? <p role="status">Comparing outputs…</p> : comparison.error ? <p role="alert">{comparison.error.message}</p> : comparison.data ? <CompareView {...comparison.data} /> : null}</div>}
      {shown === undefined ? null : <CompareView a={open === 'of' ? shown.run : data.run} b={open === 'of' ? data.run : shown.run} compare={shown.compare} />}
    </Drawer>
  </div>;
}

function CompareView({ a, b, compare }: { a: RunSummary; b: RunSummary; compare: RunCompare }): JSX.Element {
  const [all, setAll] = useState(false);
  const files = all ? compare.files : compare.files.filter((f) => f.state !== 'same');
  return <div className="flex flex-col gap-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      {compare.verdict === 'identical' ? <Badge tone="ok">identical</Badge> : compare.verdict === 'same-but-times' ? <Badge tone="ok">same but timestamps</Badge> : <Badge tone="warn">differs</Badge>}
      <span className="text-dim">{compare.total > 0 && compare.same === compare.total ? `All ${compare.total} file${compare.total === 1 ? '' : 's'} identical` : `${compare.same} of ${compare.total} files byte-identical`}{compare.verdict === 'same-but-times' ? '; the rest differ only in dates, times or durations' : ''}</span>
      <span className="ml-auto text-faint"><span title={a.createdAt}>{localDateTime(a.createdAt)}</span> → <span title={b.createdAt}>{localDateTime(b.createdAt)}</span></span>
    </div>
    {compare.changes.length === 0 ? <p className="m-0 text-faint">Same inputs, parameters and tool image.</p> : <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="repro-changes">
      {compare.changes.map((c) => <li key={c.field}><span className="font-medium">{FIELD[c.field] ?? c.field}</span> <span className="text-faint">changed</span></li>)}
    </ul>}
    {compare.files.length === compare.same ? null : <SegmentedControl size="xs" value={all ? 'all' : 'changed'} onValueChange={(v) => setAll(v === 'all')}
      options={[{ value: 'changed', label: `Changed (${compare.total - compare.same})` }, { value: 'all', label: `All (${compare.total})` }]} />}
    {files.length === 0 ? null : <table className="w-full table-fixed text-xs" data-testid="repro-files">
      <colgroup><col /><col style={{ width: '5.5rem' }} /><col style={{ width: '5.5rem' }} /><col style={{ width: '11rem' }} /></colgroup>
      <thead className="text-faint"><tr><th className="text-left font-normal">File</th><th className="text-right font-normal">Before</th><th className="text-right font-normal">After</th><th className="text-left font-normal pl-2">Result</th></tr></thead>
      <tbody>{files.map((f) => <FileRow key={f.path} file={f} />)}</tbody>
    </table>}
    {files.filter((f) => f.visual === true && f.text?.onlyTimes !== true && f.a !== undefined && f.b !== undefined).map((f) => <PictureDiff key={f.path} file={f} />)}
  </div>;
}

function FileRow({ file }: { file: FileCompare }): JSX.Element {
  const inside = file.inside;
  const quiet = file.state === 'same' || file.text?.onlyTimes === true || inside?.onlyTimes === true;
  const result = file.state === 'same' ? 'same' : file.state === 'added' ? 'new' : file.state === 'removed' ? 'gone' : file.text !== undefined ? textResult(file.text)
    : inside !== undefined ? (inside.onlyTimes ? `timestamp only (${inside.total - inside.same} ${inside.kind === 'glb' ? 'chunk' : 'file'}${inside.total - inside.same === 1 ? '' : 's'})` : `${inside.total - inside.same} of ${inside.total} ${inside.kind === 'glb' ? 'chunks' : 'files'}`) : 'differs';
  return <>
    <tr className="border-t border-line">
      <td className="truncate py-0.5 pr-2">{file.path}</td>
      <td className="pr-2 text-right tabular-nums">{file.a === undefined ? '' : <a href={file.a.href} download={file.path} className="text-dim">{size(file.a.size)}</a>}</td>
      <td className="text-right tabular-nums">{file.b === undefined ? '' : <a href={file.b.href} download={file.path} className="text-dim">{size(file.b.size)}</a>}</td>
      <td className={cx('pl-2', quiet ? 'text-faint' : 'text-warn')}>{result}</td>
    </tr>
    {file.text === undefined || file.text.sample.length === 0 ? null : <tr><td colSpan={4} className="pb-1">
      <details><summary className="cursor-pointer text-faint">first differing lines</summary>
        <pre className="m-0 overflow-x-auto bg-raised p-1 font-mono text-2xs">{file.text.sample.map((s) => `${s.line}  - ${s.a}\n${s.line}  + ${s.b}`).join('\n')}</pre>
      </details>
    </td></tr>}
    {inside === undefined || inside.members.length === 0 ? null : <tr><td colSpan={4} className="pb-1">
      <details data-testid="repro-inside"><summary className="cursor-pointer text-faint">{inside.kind === 'glb' ? 'chunks' : 'files inside'}</summary>
        <ul className="m-0 flex list-none flex-col p-0">{inside.members.map((m) => <li key={m.path} className="flex gap-2" title={[...(m.text?.sample ?? []).map((s) => `${s.line} - ${s.a}\n${s.line} + ${s.b}`)].filter(Boolean).join('\n')}>
          <span className="truncate">{m.path}</span>
          <span className={cx('ml-auto shrink-0', m.text?.onlyTimes === true ? 'text-faint' : 'text-warn')}>{m.state === 'added' ? 'new' : m.state === 'removed' ? 'gone' : m.text === undefined ? 'differs' : textResult(m.text)}</span>
        </li>)}</ul>
      </details>
    </td></tr>}
  </>;
}

function textResult(text: TextDiff): string {
  return text.onlyTimes === true ? `timestamp only (${text.differing} line${text.differing === 1 ? '' : 's'})` : `${text.differing} of ${text.lines} lines`;
}

/** Before, after, and the two laid over each other with a difference blend (unchanged pixels go black). */
function PictureDiff({ file }: { file: FileCompare }): JSX.Element {
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  return <div className="flex flex-col gap-1" data-testid="repro-picture">
    <div className="flex items-center gap-2"><span className="font-medium">{file.path}</span>
      <SegmentedControl size="xs" value={mode} onValueChange={(v) => setMode(v as 'side' | 'overlay')} options={[{ value: 'side', label: 'Side by side' }, { value: 'overlay', label: 'Difference' }]} /></div>
    {mode === 'side' ? <div className="grid grid-cols-2 gap-2">
      <img src={file.a!.href} alt={`${file.path} before`} className="w-full border border-line bg-panel object-contain" />
      <img src={file.b!.href} alt={`${file.path} after`} className="w-full border border-line bg-panel object-contain" />
    </div> : <div className="relative" style={{ isolation: 'isolate', background: 'black' }}>
      <img src={file.a!.href} alt={`${file.path} before`} className="block w-full object-contain" />
      <img src={file.b!.href} alt={`${file.path} difference`} className="absolute inset-0 h-full w-full object-contain" style={{ mixBlendMode: 'difference' }} />
    </div>}
  </div>;
}
