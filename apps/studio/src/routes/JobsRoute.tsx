/**
 * `/jobs` — recent jobs (imports, model builds, housekeeping) and the
 * worker's heartbeat (`GET /api/jobs`). An import that finished and was not
 * published yet opens for review and Publish.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Button, Chip, DataTable, KeyValues, Page, PageBody, Select, SidePanel, StatusDot, Switch, Toolbar, type DataColumn } from '@wirehub/editor-react';
import { useMemo, useState, type JSX } from 'react';

import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { ImportJob } from '../modules/ImportJob.tsx';
import { useModules } from '../modules/ModulesContext.tsx';
import type { RecordNames } from '../history/labels.ts';
import { useRecordNames } from '../history/names.ts';
import { cancelJob, canRetry, fetchJobs, isFinished, jobsKey, retryJob, type JobView } from '../jobs.browser.ts';
import { localDateTime } from '../when.ts';
import { ago } from '../backup.browser.ts';

const when = (iso: string | undefined): string => (iso === undefined ? '' : localDateTime(iso, true));

/** What each kind of job is called on this page (a module's own kinds keep their id, made readable). */
const KIND_LABEL: Readonly<Record<string, string>> = {
  import: 'Import',
  convert: '3D model build',
  'model-cache': '3D model cache',
  derive: 'Derived records',
  'blob-gc': 'File clean-up',
  backup: 'Backup',
  'git-mirror': 'Git mirror',
  webhook: 'Webhook delivery',
  'board-outputs': 'Board outputs',
  'firmware-compile': 'Firmware build',
  'enclosure-generate': 'Enclosure',
  'print-prepare': 'Print slicing',
  'device-export': 'Device export',
};
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? (kind.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
const REASON: Readonly<Record<string, string>> = { schedule: 'scheduled', boot: 'at start-up', commit: 'after a save', requested: 'on request' };
/** A job nobody asked for: the worker's schedule, its start-up work, housekeeping after a save. */
export const isSystemJob = (job: JobView): boolean => job.requestedBy === undefined && job.kind !== 'import';

const STATUS_FILTERS = [
  { value: 'all', label: 'Any state' },
  { value: 'active', label: 'Queued or running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;
const statusMatches = (job: JobView, filter: string): boolean =>
  filter === 'all' ? true : filter === 'active' ? !isFinished(job) : filter === 'failed' ? job.status === 'failed' || job.status === 'interrupted' : job.status === filter;

/** What a job names, as people call it: records by their labels (`useRecordNames`), an importer by its label. */
export interface JobNames extends RecordNames {
  importer: (module: string, importer: string) => string | undefined;
}

/** The board-outputs ops, short: `render, 3D, fab`. */
const OP_SHORT: Readonly<Record<string, string>> = { 'board-render': 'render', 'board-3d': '3D', fab: 'fab' };

export function describeJob(job: JobView, names?: JobNames): string {
  const r = job.request;
  if (job.kind === 'import') {
    const importer = names?.importer(job.request.module ?? '', job.request.importer ?? '');
    return `${job.request.fileName ?? 'file'}${importer === undefined ? '' : ` (${importer})`}`;
  }
  if (job.kind === 'board-outputs' && typeof r['board'] === 'string') {
    const identity = r['identity'] as { revision?: unknown } | undefined;
    const board = names?.board(r['board'], typeof identity?.revision === 'string' ? identity.revision : undefined) ?? 'Board';
    return `${board} — ${Array.isArray(r['ops']) ? (r['ops'] as string[]).map((op) => OP_SHORT[op] ?? op).join(', ') : 'outputs'}`;
  }
  if (job.kind === 'firmware-compile' && typeof r['project'] === 'string') {
    const design = typeof r['design'] === 'string' ? names?.design(r['design']) ?? 'Design' : undefined;
    return `${names?.firmware(r['project']) ?? 'Firmware project'}${typeof r['target'] === 'string' ? ` — ${r['target']}` : ''}${design === undefined ? '' : ` for ${design}`}`;
  }
  if (job.kind === 'enclosure-generate' && typeof r['enclosure'] === 'string') return String(r['label'] ?? names?.definition('mechanicals', r['enclosure']) ?? 'Enclosure');
  if (job.kind === 'print-prepare' && typeof r['mechanical'] === 'string') return `Slice ${names?.definition('mechanicals', r['mechanical']) ?? 'Part'}${Array.isArray(r['parts']) ? ` — ${(r['parts'] as unknown[]).length} part${(r['parts'] as unknown[]).length === 1 ? '' : 's'}` : ''}`;
  const reason = job.request.reason === undefined ? undefined : REASON[String(job.request.reason)] ?? String(job.request.reason);
  return reason === undefined ? kindLabel(job.kind) : `${kindLabel(job.kind)}, ${reason}`;
}

export function stateOf(job: JobView): string {
  if (job.kind === 'import' && job.status === 'done') return job.publishedVersion === undefined ? 'ready to publish' : job.publishedVersion.length <= 12 ? `published (v${job.publishedVersion})` : 'published';
  return job.status;
}

interface CapturedInputs {
  capturedAt?: string;
  design?: { id: string; rev?: number };
  error?: string;
  inputs?: { kind: string; id: string; label?: string; revision?: string; recordRev?: number; designRev?: number; hash: string }[];
}

/** The effective inputs a job recorded for the design it named (`request.effectiveInputs`, `effective-inputs.ts`). */
function EffectiveInputsList({ captured }: { captured: CapturedInputs }): JSX.Element {
  const inputs = captured.inputs ?? [];
  const names = useRecordNames();
  return (
    <section aria-label="Effective inputs" className="mt-2 flex flex-col gap-1">
      <p className="text-xs font-medium">
        Effective inputs{captured.design === undefined ? '' : ` · ${names.design(captured.design.id) ?? 'Design'}${captured.design.rev === undefined ? ' (working copy)' : ` rev ${captured.design.rev}`}`}
      </p>
      {captured.error === undefined ? null : <p className="text-xs text-err">{captured.error}</p>}
      <ul className="flex flex-col text-xs" data-testid="job-effective-inputs">
        {inputs.map((i) => (
          <li key={`${i.kind}/${i.id}`} className="flex gap-2" title={i.label}>
            <span className="text-faint">{i.kind}</span>
            <span>{i.label ?? names.definition(i.kind, i.id) ?? 'Unavailable input'}</span>
            <span className="text-faint">{[i.revision, i.recordRev === undefined ? undefined : `rec ${i.recordRev}`, i.designRev === undefined ? undefined : `rev ${i.designRev}`].filter((x) => x !== undefined).join(' · ')}</span>

          </li>
        ))}
      </ul>
    </section>
  );
}

export function JobsRoute(): JSX.Element {
  const search = useSearch({ strict: false }) as { job?: string };
  const [open, setOpen] = useState<string>();
  const [selected, setSelected] = useState<string | undefined>(search.job);
  const [note, setNote] = useState<string>();
  const [system, setSystem] = useState(false);
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const recordNames = useRecordNames();
  const modules = useModules();
  const names = useMemo((): JobNames => {
    const importers = new Map(modules.importers().map((i) => [`${i.module}:${i.id}`, i.label.replace(/\s*\(.*\)\s*$/, '')] as const));
    return { ...recordNames, importer: (module, importer) => importers.get(`${module}:${importer}`) };
  }, [recordNames, modules]);
  const query = useQuery({
    queryKey: jobsKey,
    queryFn: async () => {
      const answer = await fetchJobs();
      if (!answer.ok) throw new Error(`${answer.error}${answer.hint === undefined ? '' : ` ${answer.hint}`}`);
      return answer.value;
    },
    // while something runs, look again
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => !isFinished(j)) === true ? 2000 : 15000),
  });
  const data = query.data;
  const all = data?.jobs ?? [];
  const jobs = all.filter((j) => (system || !isSystemJob(j) || j.id === selected) && (kind === 'all' || j.kind === kind) && statusMatches(j, status));
  const hiddenSystem = system ? 0 : all.filter(isSystemJob).length;
  const kindOptions = [{ value: 'all', label: 'Any kind' }, ...[...new Set(all.filter((j) => system || !isSystemJob(j)).map((j) => j.kind))].sort().map((k) => ({ value: k, label: kindLabel(k) }))];
  const job = all.find((j) => j.id === selected);
  const worker = data?.worker;
  const runnerTone = worker === null ? 'warn' : worker !== undefined && Date.now() - new Date(worker.beatAt).getTime() > 5 * 60_000 ? 'warn' : 'ok';
  const reviewable = (j: JobView): boolean => j.kind === 'import';
  const act = async (what: 'cancel' | 'retry', j: JobView): Promise<void> => {
    const out = what === 'cancel' ? await cancelJob(j.id) : await retryJob(j.id);
    setNote(out.ok ? undefined : `${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    if (out.ok && what === 'retry') setSelected(out.value.job.id);
    await query.refetch();
  };
  const columns = useMemo((): DataColumn<JobView>[] => [
    { id: 'when', header: 'When', width: 150, cell: (j) => when(j.createdAt), sortValue: (j) => j.createdAt },
    { id: 'job', header: 'Job', width: 300, cell: (j) => describeJob(j, names), sortValue: (j) => describeJob(j, names) },
    { id: 'kind', header: 'Kind', width: 120, defaultHidden: true, cell: (j) => kindLabel(j.kind), sortValue: (j) => kindLabel(j.kind) },
    { id: 'by', header: 'By', width: 120, cell: (j) => j.requestedBy?.name ?? 'System', sortValue: (j) => j.requestedBy?.name ?? 'System' },
    { id: 'state', header: 'State', width: 140, cell: (j) => <span className={j.status === 'failed' || j.status === 'interrupted' ? 'text-err' : undefined} title={j.error}>{stateOf(j)}</span>, sortValue: (j) => stateOf(j) },
    {
      id: 'open',
      header: '',
      fixed: true,
      width: 90,
      cell: (j) =>
        reviewable(j) ? (
          <Button size="xs" variant="ghost" onClick={() => setOpen(j.id)}>
            {j.status === 'done' && j.publishedVersion === undefined ? 'Review…' : 'Open'}
          </Button>
        ) : null,
    },
  ], [names]);
  return (
    <Page testId="jobs">
      <RouteHeader
        title="Jobs"
        count={data === undefined ? undefined : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`}
        secondary={
          data === undefined ? undefined : (
            <span className="flex items-center gap-1.5 text-xs text-dim" title={worker === undefined ? undefined : worker === null ? 'No worker has reported in yet.' : `The worker (version ${worker.version}) last reported ${when(worker.beatAt)}.`}>
              <StatusDot tone={runnerTone} label={runnerTone === 'ok' ? 'Runner ok' : 'Runner needs attention'} />
              <span data-testid="jobs-runner">
                Runner: {data.runner}
                {worker === undefined ? '' : worker === null ? ' · no worker yet' : ` · ${ago(worker.beatAt, new Date())}`}
              </span>
            </span>
          )
        }
      />
      <Toolbar label="Job filters">
        <Select aria-label="Kind" className="w-44" value={kind} options={kindOptions} onValueChange={setKind} />
        <Select aria-label="State" className="w-44" value={status} options={[...STATUS_FILTERS]} onValueChange={setStatus} />
        <Switch label={hiddenSystem > 0 ? `Show system jobs (${hiddenSystem})` : 'Show system jobs'} checked={system} onCheckedChange={setSystem} aria-label="Show system jobs" />
      </Toolbar>
      {query.isError ? <div role="alert" className="px-4 py-2 text-err">{query.error instanceof Error ? query.error.message : 'The jobs could not be read.'}</div> : null}
      <PageBody
        panel={
          job === undefined ? undefined : (
            <SidePanel title={describeJob(job, names)} chips={<Chip tone={job.status === 'failed' || job.status === 'interrupted' ? 'err' : job.status === 'done' ? 'ok' : 'neutral'}>{stateOf(job)}</Chip>} onClose={() => setSelected(undefined)} label="Job details"
              footer={
                reviewable(job) ? <Button variant="primary" onClick={() => setOpen(job.id)}>{job.status === 'done' && job.publishedVersion === undefined ? 'Review…' : 'Open'}</Button>
                  : !isFinished(job) ? <Button onClick={() => void act('cancel', job)}>Cancel</Button>
                    : canRetry(job) ? <Button variant="primary" onClick={() => void act('retry', job)}>Run again</Button> : undefined
              }>
              <KeyValues items={[
                ['Kind', kindLabel(job.kind)], ['Requested', when(job.createdAt)], ['By', job.requestedBy?.name ?? 'System'],
                ...(job.startedAt === undefined ? [] : [['Started', when(job.startedAt)] as const]),
                ...(job.finishedAt === undefined ? [] : [['Finished', when(job.finishedAt)] as const]),
                ...(typeof job.request['retryOf'] === 'string' ? [['Retry of', when(all.find((x) => x.id === job.request['retryOf'])?.createdAt) || 'an earlier run'] as const] : []),
                ...(job.error === undefined ? [] : [['Error', job.error] as const]),
              ]} />
              {note === undefined ? null : <p role="alert" className="text-xs text-err">{note}</p>}
              {job.steps.length === 0 ? null : (
                <ol aria-label="Steps" className="mt-2 flex flex-col gap-0.5 text-xs">
                  {job.steps.map((s, i) => <li key={i}><span className="text-faint">{localDateTime(s.at, true).slice(11)}</span> {s.text}</li>)}
                </ol>
              )}
              {typeof job.request['effectiveInputs'] === 'object' && job.request['effectiveInputs'] !== null ? <EffectiveInputsList captured={job.request['effectiveInputs'] as CapturedInputs} /> : null}
            </SidePanel>
          )
        }
      >
        {query.isError && data === undefined ? null : (
          <DataTable
            loading={data === undefined}
            label="Jobs"
            rows={jobs}
            columns={columns}
            getRowId={(j) => j.id}
            selectedId={selected}
            onSelect={(j) => setSelected(j.id)}
            columnsKey="jobs"
            rowAttrs={(j) => ({ 'data-job': j.id, 'data-status': j.status })}
            empty={
              all.length > 0 ? <div className="px-4 py-3 text-faint">No jobs match.</div> : <EmptyState
                topic="jobs"
                action={
                  <Link to="/extensions" search={{ tab: 'installed' }} className={`${EMPTY_PRIMARY} inline-flex items-center`}>
                    Open extensions
                  </Link>
                }
              >
                No jobs yet.
              </EmptyState>
            }
          />
        )}
      </PageBody>
      {open === undefined ? null : <ImportJob id={open} onClose={() => setOpen(undefined)} />}
    </Page>
  );
}
