/**
 * "Import…" in the Library (docs/modules.md, "Importers"): pick a file, a
 * module's importer that takes it reads it on the server and proposes records;
 * the person reviews the proposal and accepts it (one change set) or cancels.
 * Nothing is written before Accept, and an id the library already has is
 * listed and skipped, never overwritten.
 */

import { useQueryClient } from '@tanstack/react-query';
import type { ModuleRegistry } from '@wirehub/modules';
import { useRef, useState, type JSX } from 'react';

import { designsKey } from '../queries.ts';

interface Proposal {
  definitions: Record<string, { id: string; label: string }[]>;
  existing: string[];
  designs: { id: string; label: string }[];
  existingDesigns: string[];
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

export function ModuleImport({ registry, onImported }: { registry: ModuleRegistry; onImported: () => void }): JSX.Element | null {
  const input = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const accepts = [...new Set(registry.importers().flatMap((i) => i.accepts))];
  if (accepts.length === 0) return null;

  const pick = async (file: File): Promise<void> => {
    const matches = registry.importersFor(file.name);
    const importer = matches[0];
    if (importer === undefined) {
      setMessage(`No importer takes ${file.name} (${accepts.join(', ')}).`);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
      const out = await call(importer.module, importer.id, { fileName: file.name, base64 });
      if (out.status >= 400 || out.body.proposal === undefined) setMessage(`${out.body.error ?? 'The import failed.'} ${out.body.hint ?? ''}`.trim());
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
        setMessage(`${out.body.error ?? 'The import failed.'} ${out.body.hint ?? ''}`.trim());
        return;
      }
      setPending(undefined);
      setMessage(`Imported ${pending.fileName}.`);
      onImported();
      void queryClient.invalidateQueries({ queryKey: designsKey });
    } finally {
      setBusy(false);
    }
  };

  const proposal = pending?.proposal;
  const added = proposal === undefined ? 0 : Object.values(proposal.definitions).reduce((n, list) => n + list.length, 0) + proposal.designs.length;
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
      <button type="button" disabled={busy} title={`Import from a file (${accepts.join(', ')}) with a module's importer`} onClick={() => input.current?.click()}>
        Import…
      </button>
      {message === undefined ? null : (
        <span role="status" className="cs-count">
          {message}
        </span>
      )}
      {pending === undefined || proposal === undefined ? null : (
        <div role="dialog" aria-label="Review import" className="fixed inset-x-0 top-16 z-50 mx-auto flex max-w-md flex-col gap-1.5 rounded-md border border-line bg-panel p-3 text-[12px] text-ink shadow-lg">
          <strong>
            {pending.importerLabel}: {pending.fileName}
          </strong>
          {Object.entries(proposal.definitions).map(([kind, list]) => (
            <div key={kind}>
              {list.length} new {kind}: {list.map((r) => r.id).join(', ')}
            </div>
          ))}
          {proposal.designs.length === 0 ? null : <div>{proposal.designs.length} new designs: {proposal.designs.map((d) => d.id).join(', ')}</div>}
          {proposal.existing.length + proposal.existingDesigns.length === 0 ? null : (
            <div>Already in the library, skipped: {[...proposal.existing, ...proposal.existingDesigns].join(', ')}</div>
          )}
          {proposal.notes.map((note) => (
            <div key={note}>Check: {note}</div>
          ))}
          <div>
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
