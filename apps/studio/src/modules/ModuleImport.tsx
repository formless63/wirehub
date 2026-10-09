/**
 * "Import…" in the Library (docs/modules.md, "Importers"): pick a file, a
 * module's importer that takes it reads it on the server and proposes records;
 * the person reviews the proposal and accepts it (one change set) or cancels.
 * Nothing is written before Accept, and an id the library already has is
 * listed and skipped, never overwritten.
 *
 * Where the studio runs jobs (the worker on Postgres, this process on files)
 * the import is a **job**: it is queued, its progress is followed, and its
 * plan is published from `ImportJob` (also from the Jobs page, later). A
 * studio without jobs (501) uses the one-request preview and Accept below.
 */

import { useQueryClient } from '@tanstack/react-query';
import type { ModuleRegistry } from '@wirehub/modules';
import { useEffect, useRef, useState, type JSX } from 'react';

import { startImportJob, uploadImportJob } from '../jobs.browser.ts';
import { useNotify } from '../notify.ts';
import { designsKey } from '../queries.ts';
import { ImportJob } from './ImportJob.tsx';

interface Proposal {
  definitions: Record<string, { id: string; label: string }[]>;
  existing: string[];
  updated?: Record<string, { id: string; label: string }[]>;
  designs: { id: string; label: string }[];
  existingDesigns: string[];
  boardParts?: string[];
  depictions?: string[];
  notes: string[];
}

interface Pending {
  module: string;
  importer: string;
  importerLabel: string;
  fileName: string;
  base64: string;
  proposal: Proposal;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function call(module: string, importer: string, body: unknown): Promise<{ status: number; body: { error?: string; hint?: string; proposal?: Proposal } }> {
  const response = await fetch(`/api/modules/${encodeURIComponent(module)}/_import/${encodeURIComponent(importer)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as { error?: string; hint?: string; proposal?: Proposal } };
}

export function ModuleImport({ registry, onImported, expose }: { registry: ModuleRegistry; onImported: () => void; expose?: (open: () => void) => void }): JSX.Element | null {
  const input = useRef<HTMLInputElement | null>(null);
  // the Library's Import menu opens the file picker from its own entry instead of a button here
  useEffect(() => { expose?.(() => input.current?.click()); }, [expose]);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const accepts = [...new Set(registry.importers().flatMap((i) => i.accepts))];
  if (accepts.length === 0) return null;

  const pick = async (file: File): Promise<void> => {
    const matches = registry.importersFor(file.name);
    const importer = matches[0];
    if (importer === undefined) {
      notify.error(`No importer takes ${file.name}.`, `It takes ${accepts.join(', ')}.`);
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // raw bytes first (no base64, and room for a big file); a host that takes only JSON gets the base64 form
      let queued = await uploadImportJob(importer.module, importer.id, file.name, bytes);
      // (the base64 copy is made only when a host needs it)
      let encoded: string | undefined;
      const base64Of = (): string => (encoded ??= toBase64(bytes));
      if (!queued.ok && (queued.status === 415 || queued.status === 405)) queued = await startImportJob(importer.module, importer.id, file.name, base64Of());
      if (queued.ok) {
        setJobId(queued.value.job.id);
        return;
      }
      // 501: no job runner here — the synchronous preview below; anything else is the importer's own refusal
      if (queued.status !== 501) {
        notify.error(queued.error, queued.hint);
        return;
      }
      const base64 = base64Of();
      const out = await call(importer.module, importer.id, { fileName: file.name, base64 });
      if (out.status >= 400 || out.body.proposal === undefined) notify.error(out.body.error ?? 'The import failed.', out.body.hint);
      else setPending({ module: importer.module, importer: importer.id, importerLabel: importer.label, fileName: file.name, base64, proposal: out.body.proposal });
    } finally {
      setBusy(false);
    }
  };

  const accept = async (): Promise<void> => {
    if (pending === undefined) return;
    setBusy(true);
    try {
      const out = await call(pending.module, pending.importer, { fileName: pending.fileName, base64: pending.base64, accept: true });
      if (out.status >= 400) {
        notify.error(out.body.error ?? 'The import failed.', out.body.hint);
        return;
      }
      setPending(undefined);
      notify.success(`Imported ${pending.fileName}.`, { view: { to: '/library' } });
      onImported();
      void queryClient.invalidateQueries({ queryKey: designsKey });
    } finally {
      setBusy(false);
    }
  };

  const proposal = pending?.proposal;
  const added = proposal === undefined ? 0 : Object.values(proposal.definitions).reduce((n, list) => n + list.length, 0) + Object.values(proposal.updated ?? {}).reduce((n, list) => n + list.length, 0) + proposal.designs.length + (proposal.boardParts?.length ?? 0) + (proposal.depictions?.length ?? 0);
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept={accepts.join(',')}
        data-testid="module-import-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void pick(file);
        }}
      />
      {expose !== undefined ? null : (
        <button type="button" disabled={busy} title={`Import from a file (${accepts.join(', ')}) with a module's importer`} onClick={() => input.current?.click()}>
          Import…
        </button>
      )}
      {jobId === undefined ? null : <ImportJob id={jobId} onClose={() => setJobId(undefined)} onPublished={onImported} />}
      {pending === undefined || proposal === undefined ? null : (
        <div role="dialog" aria-label="Review import" className="cs-import-dialog fixed inset-x-3 top-16 z-50 mx-auto flex max-w-md flex-col gap-1.5 rounded-md border border-line bg-panel p-3 text-xs text-ink shadow-lg">
          <strong>
            {pending.importerLabel}: {pending.fileName}
          </strong>
          {Object.entries(proposal.definitions).map(([kind, list]) => (
            <div key={kind}>
              {list.length} new {kind}: {list.map((r) => r.id).join(', ')}
            </div>
          ))}
          {Object.entries(proposal.updated ?? {}).map(([kind, list]) => (
            <div key={`updated-${kind}`}>
              {list.length} updated {kind}: {list.map((r) => r.id).join(', ')}
            </div>
          ))}
          {proposal.designs.length === 0 ? null : <div>{proposal.designs.length} new designs: {proposal.designs.map((d) => d.id).join(', ')}</div>}
          {(proposal.boardParts ?? []).length === 0 ? null : <div>Placed parts of: {proposal.boardParts!.join(', ')}</div>}
          {(proposal.depictions ?? []).length === 0 ? null : <div>Board art for: {proposal.depictions!.join(', ')}</div>}
          {proposal.existing.length + proposal.existingDesigns.length === 0 ? null : (
            <div>Already in the library, skipped: {[...proposal.existing, ...proposal.existingDesigns].join(', ')}</div>
          )}
          {proposal.notes.map((note) => (
            <div key={note}>Check: {note}</div>
          ))}
          <div className="cs-import-actions">
            <button type="button" className="cs-primary" disabled={busy || added === 0} onClick={() => void accept()}>
              {added === 0 ? 'Nothing new' : `Add ${added} record${added === 1 ? '' : 's'}`}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
