/**
 * `/jobs` — recent jobs (imports, model builds, housekeeping) and the
 * worker's heartbeat (`GET /api/jobs`). An import that finished and was not
 * published yet opens for review and Publish.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, Chip, DataTable, KeyValues, Page, PageBody, SidePanel, Toolbar, type DataColumn } from '@wirehub/editor-react';
import { useMemo, useState, type JSX } from 'react';

import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { ImportJob } from '../modules/ImportJob.tsx';
import { fetchJobs, isFinished, jobsKey, type JobView } from '../jobs.browser.ts';

const when = (iso: string | undefined): string => (iso === undefined ? '' : new Date(iso).toLocaleString());

export function describeJob(job: JobView): string {
  if (job.kind === 'import') return `${job.request.fileName ?? 'file'} (${job.request.module ?? ''}:${job.request.importer ?? ''})`;
  return job.request.reason === undefined ? job.kind : `${job.kind} — ${String(job.request.reason)}`;
}

export function stateOf(job: JobView): string {
  if (job.kind === 'import' && job.status === 'done') return job.publishedVersion === undefined ? 'ready to publish' : `published (v${job.publishedVersion})`;
  return job.status;
}

export function JobsRoute(): JSX.Element {
  const [open, setOpen] = useState<string>();
  const [selected, setSelected] = useState<string>();
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
  const jobs = data?.jobs ?? [];
  const job = jobs.find((j) => j.id === selected);
  const reviewable = (j: JobView): boolean => j.kind === 'import';
  const columns = useMemo((): DataColumn<JobView>[] => [
    { id: 'when', header: 'When', width: 150, cell: (j) => when(j.createdAt), sortValue: (j) => j.createdAt },
    { id: 'kind', header: 'Kind', width: 90, cell: (j) => j.kind, sortValue: (j) => j.kind },
    { id: 'job', header: 'Job', width: 260, cell: (j) => describeJob(j), sortValue: (j) => describeJob(j) },
    { id: 'by', header: 'By', width: 120, cell: (j) => j.requestedBy?.name ?? 'System', sortValue: (j) => j.requestedBy?.name ?? 'System' },
    { id: 'state', header: 'State', width: 140, cell: (j) => <span className={j.status === 'failed' ? 'text-err' : undefined} title={j.error}>{stateOf(j)}</span>, sortValue: (j) => stateOf(j) },
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
  ], []);
  return (
    <Page testId="jobs">
      <RouteHeader title="Jobs" count={data === undefined ? undefined : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`} />
      <Toolbar label="Job status">
        {data === undefined ? null : (
          <span className="text-xs text-faint" data-testid="jobs-runner">
            Run by {data.runner}.{' '}
            {data.worker === undefined ? null : data.worker === null ? 'No worker has reported in yet.' : `The worker (version ${data.worker.version}) last reported ${when(data.worker.beatAt)}.`}
          </span>
        )}
      </Toolbar>
      {query.isError ? <div role="alert" className="px-4 py-2 text-err">{query.error instanceof Error ? query.error.message : 'The jobs could not be read.'}</div> : null}
      <PageBody
        panel={
          job === undefined ? undefined : (
            <SidePanel title={describeJob(job)} subtitle={job.id} chips={<Chip tone={job.status === 'failed' ? 'err' : job.status === 'done' ? 'ok' : 'neutral'}>{stateOf(job)}</Chip>} onClose={() => setSelected(undefined)} label="Job details"
              footer={reviewable(job) ? <Button variant="primary" onClick={() => setOpen(job.id)}>{job.status === 'done' && job.publishedVersion === undefined ? 'Review…' : 'Open'}</Button> : undefined}>
              <KeyValues items={[['Kind', job.kind], ['Requested', when(job.createdAt)], ['By', job.requestedBy?.name ?? 'System'], ...(job.error === undefined ? [] : [['Error', job.error] as const])]} />
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
              <EmptyState
                topic="jobs"
                action={
                  <Link to="/extensions" search={{ tab: 'installed' }} className={`${EMPTY_PRIMARY} inline-flex items-center`}>
                    Open extensions
                  </Link>
                }
              >
                No jobs yet. Imports and long renders run here.
              </EmptyState>
            }
          />
        )}
      </PageBody>
      {open === undefined ? null : <ImportJob id={open} onClose={() => setOpen(undefined)} />}
    </Page>
  );
}
