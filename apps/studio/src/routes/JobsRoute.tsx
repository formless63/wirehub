/**
 * `/jobs` — recent jobs (imports, model builds, housekeeping) and the
 * worker's heartbeat (`GET /api/jobs`). An import that finished and was not
 * published yet opens for review and Publish.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type JSX } from 'react';

import { EMPTY_PRIMARY, EmptyState } from '../shell/EmptyState.tsx';
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
  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="jobs">
      <h1 className="mb-3 text-[14px] font-semibold">Jobs</h1>
      {query.isError ? <div role="alert">{query.error instanceof Error ? query.error.message : 'The jobs could not be read.'}</div> : null}
      {data === undefined ? (
        query.isError ? null : <div className="text-faint">Loading…</div>
      ) : (
        <>
          <div className="mb-2 text-faint" data-testid="jobs-runner">
            Run by {data.runner}.{' '}
            {data.worker === undefined ? null : data.worker === null ? 'No worker has reported in yet.' : `Worker ${data.worker.worker} ${data.worker.version} last beat ${when(data.worker.beatAt)}.`}
          </div>
          {data.jobs.length === 0 ? (
            <EmptyState
              topic="jobs"
              action={
                <Link to="/modules" className={`${EMPTY_PRIMARY} inline-flex items-center`}>
                  Open modules
                </Link>
              }
            >
              No jobs yet. Imports and long renders run here.
            </EmptyState>
          ) : null}
          <table className="w-full max-w-4xl text-left">
            <thead>
              <tr className="text-faint">
                <th className="pr-3 font-normal">When</th>
                <th className="pr-3 font-normal">Kind</th>
                <th className="pr-3 font-normal">Job</th>
                <th className="pr-3 font-normal">By</th>
                <th className="pr-3 font-normal">State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => (
                <tr key={job.id} data-job={job.id} data-status={job.status}>
                  <td className="pr-3">{when(job.createdAt)}</td>
                  <td className="pr-3">{job.kind}</td>
                  <td className="pr-3">{describeJob(job)}</td>
                  <td className="pr-3">{job.requestedBy?.name ?? ''}</td>
                  <td className={job.status === 'failed' ? 'pr-3 text-err' : 'pr-3'} title={job.error}>
                    {stateOf(job)}
                  </td>
                  <td>
                    {job.kind === 'import' ? (
                      <button type="button" className="underline" onClick={() => setOpen(job.id)}>
                        {job.status === 'done' && job.publishedVersion === undefined ? 'Review…' : 'Open'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {open === undefined ? null : <ImportJob id={open} onClose={() => setOpen(undefined)} />}
    </div>
  );
}
