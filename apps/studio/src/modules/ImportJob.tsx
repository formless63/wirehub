/**
 * One import job, followed from the browser (docs/modules.md, "Importers";
 * `specs/postgres-backend.md` §7.5): progress while the importer runs (in the
 * worker on Postgres), then the plan to review — what it adds, what the
 * library already has, which files change — and **Publish**, which commits it
 * as one change set. A record that moved since the run answers 409 and
 * nothing is written. Nothing is in the catalog before Publish.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import { fetchJob, isFinished, jobKey, jobsKey, publishJob, type ImportProposal, type JobView } from '../jobs.browser.ts';
import { designsKey } from '../queries.ts';

const when = (iso: string | undefined): string => (iso === undefined ? '' : new Date(iso).toLocaleString());

/** The plan, in words: new records by kind, what is skipped, the importer's notes. */
export function PlanSummary({ proposal, notes }: { proposal: ImportProposal | undefined; notes: string[] }): JSX.Element {
  return (
    <>
      {proposal === undefined
        ? null
        : Object.entries(proposal.definitions).map(([kind, list]) => (
            <div key={kind}>
              {list.length} new {kind}: {list.map((r) => r.id).join(', ')}
            </div>
          ))}
      {proposal === undefined
        ? null
        : Object.entries(proposal.updated ?? {}).map(([kind, list]) => (
            <div key={`updated-${kind}`}>
              {list.length} updated {kind}: {list.map((r) => r.id).join(', ')}
            </div>
          ))}
      {proposal === undefined || proposal.designs.length === 0 ? null : (
        <div>
          {proposal.designs.length} new designs: {proposal.designs.map((d) => d.id).join(', ')}
        </div>
      )}
      {(proposal?.boardParts ?? []).length === 0 ? null : <div>Placed parts of: {proposal!.boardParts!.join(', ')}</div>}
      {(proposal?.depictions ?? []).length === 0 ? null : <div>Board art for: {proposal!.depictions!.join(', ')}</div>}
      {proposal === undefined || proposal.existing.length + proposal.existingDesigns.length === 0 ? null : (
        <div>Already in the library, skipped: {[...proposal.existing, ...proposal.existingDesigns].join(', ')}</div>
      )}
      {notes.map((note) => (
        <div key={note}>Check: {note}</div>
      ))}
    </>
  );
}

export function addedCount(proposal: ImportProposal | undefined): number {
  return proposal === undefined ? 0 : Object.values(proposal.definitions).reduce((n, list) => n + list.length, 0) + Object.values(proposal.updated ?? {}).reduce((n, list) => n + list.length, 0) + proposal.designs.length + (proposal.boardParts?.length ?? 0) + (proposal.depictions?.length ?? 0);
}

/** The job's own words for where it is. */
export function statusLine(job: JobView): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting for the worker…';
    case 'running':
      return 'Reading the file…';
    case 'failed':
      return 'The import failed.';
    case 'cancelled':
      return 'The import was cancelled.';
    default:
      return job.publishedVersion === undefined ? 'Ready to review.' : `Published as catalog version ${job.publishedVersion}.`;
  }
}

export function ImportJob({ id, onClose, onPublished }: { id: string; onClose: () => void; onPublished?: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: jobKey(id),
    queryFn: async () => {
      const answer = await fetchJob(id);
      if (!answer.ok) throw new Error(`${answer.error}${answer.hint === undefined ? '' : ` ${answer.hint}`}`);
      return answer.value;
    },
    // follow it until it has finished
    refetchInterval: (q) => (q.state.data !== undefined && isFinished(q.state.data.job) ? false : 1000),
  });
  const job = query.data?.job;
  const files = query.data?.files ?? [];
  const proposal = job?.result?.proposal;
  const added = addedCount(proposal);
  const changed = files.filter((f) => f.status !== 'unchanged');

  const publish = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const answer = await publishJob(id);
      if (!answer.ok) {
        setMessage(`${answer.error}${answer.hint === undefined ? '' : ` ${answer.hint}`}`);
        return;
      }
      setMessage(answer.value.committed ? `Published: ${answer.value.applied ?? 0} change(s) as catalog version ${answer.value.version ?? ''}.`.replace(' .', '.') : (answer.value.hint ?? 'Nothing to change.'));
      onPublished?.();
      await queryClient.invalidateQueries({ queryKey: jobKey(id) });
      await queryClient.invalidateQueries({ queryKey: jobsKey });
      void queryClient.invalidateQueries({ queryKey: designsKey });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-label="Import job" className="fixed inset-x-0 top-16 z-50 mx-auto flex max-h-[80vh] max-w-lg flex-col gap-1.5 overflow-auto rounded-md border border-line bg-panel p-3 text-[12px] text-ink shadow-lg">
      {query.isError ? (
        <div role="alert">{query.error instanceof Error ? query.error.message : 'That job could not be read.'}</div>
      ) : job === undefined ? (
        <div>Loading…</div>
      ) : (
        <>
          <strong>
            {job.result?.importer ?? `${job.request.module ?? ''}:${job.request.importer ?? ''}`}: {job.request.fileName}
          </strong>
          <div role="status" data-testid="job-status" data-status={job.status}>
            {statusLine(job)}
          </div>
          {job.steps.length === 0 ? null : (
            <ol data-testid="job-steps" className="ml-4 list-decimal text-dim">
              {job.steps.map((s, i) => (
                <li key={`${s.at}-${i}`}>{s.text}</li>
              ))}
            </ol>
          )}
          {job.status === 'failed' ? <div role="alert" className="text-err">{job.error}</div> : null}
          {job.status === 'done' ? (
            <>
              <PlanSummary proposal={proposal} notes={job.result?.notes ?? []} />
              {files.length === 0 ? null : (
                <details data-testid="job-files">
                  <summary>
                    {changed.length} file{changed.length === 1 ? '' : 's'} change{changed.length === 1 ? 's' : ''}
                  </summary>
                  <ul className="ml-4 list-disc">
                    {files.map((f) => (
                      <li key={f.path}>
                        {f.path} ({f.status})
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {job.publishedVersion === undefined ? null : <div>Published {when(job.finishedAt)} as catalog version {job.publishedVersion}.</div>}
            </>
          ) : null}
          {message === undefined ? null : <div role="status" data-testid="job-message">{message}</div>}
          <div>
            {job.status === 'done' && job.publishedVersion === undefined ? (
              <button type="button" className="cs-primary" disabled={busy || added === 0} onClick={() => void publish()}>
                {added === 0 ? 'Nothing new' : `Publish ${added} record${added === 1 ? '' : 's'}`}
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={onClose}>
              {job.status === 'done' && job.publishedVersion === undefined ? 'Close (publish later from Jobs)' : 'Close'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
