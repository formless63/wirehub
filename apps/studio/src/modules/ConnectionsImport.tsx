/**
 * "Connections CSV…" in the Library (cs-8c4): pick a from/to pin CSV, say which
 * connector each part is (and, optionally, which wire stock carries the
 * rows), see a dry run — which rows become joints, which are left out and
 * why — then send the file to the `connection-list` import job, whose plan (a
 * proposed design) is reviewed and published as one change set from
 * `ImportJob`. Nothing is written before Publish.
 *
 * The reading is the module's own function (`analyseConnections`), the same
 * one the server's importer runs, so the dry run is the job's plan.
 */

import { analyseConnections, type ConnectionAnalysis } from '@wirehub/module-csv-library';
import { useMemo, useRef, useState, type JSX } from 'react';

import { startImportJob } from '../jobs.browser.ts';
import { useStudio } from '../studio-context.tsx';
import { ImportJob } from './ImportJob.tsx';

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const slug = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function ConnectionsImport({ onImported }: { onImported: () => void }): JSX.Element {
  const studio = useStudio();
  const input = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [designId, setDesignId] = useState('');
  const [label, setLabel] = useState('');
  const [wire, setWire] = useState('');
  const [parts, setParts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string>();

  const options = useMemo(
    () => ({
      ...(designId.trim() === '' ? {} : { design: designId.trim() }),
      ...(label.trim() === '' ? {} : { label: label.trim() }),
      ...(Object.keys(parts).length === 0 ? {} : { parts }),
      ...(wire === '' ? {} : { wire }),
    }),
    [designId, label, parts, wire],
  );
  const result = useMemo((): { analysis?: ConnectionAnalysis; error?: string } => {
    if (text === '') return {};
    try {
      return { analysis: analyseConnections(fileName, text, studio.db, options) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [text, fileName, studio.db, options]);
  const analysis = result.analysis;
  const joints = analysis?.rows.filter((r) => r.status === 'joint').length ?? 0;

  const read = async (file: File): Promise<void> => {
    const body = await file.text();
    setText(body);
    setFileName(file.name);
    setDesignId('');
    setLabel('');
    setWire('');
    setParts({});
    setMessage(undefined);
    setOpen(true);
  };

  const review = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const flat: Record<string, string> = { ...(options.design === undefined ? {} : { design: options.design }), ...(options.label === undefined ? {} : { label: options.label }), ...(wire === '' ? {} : { wire }), ...(Object.keys(parts).length === 0 ? {} : { parts: JSON.stringify(parts) }) };
      const queued = await startImportJob('csv-library', 'connection-list', fileName, toBase64(new TextEncoder().encode(text)), flat);
      if (!queued.ok) {
        setMessage(queued.status === 501 ? 'This studio runs no import jobs.' : `${queued.error}${queued.hint === undefined ? '' : ` ${queued.hint}`}`);
        return;
      }
      setJobId(queued.value.job.id);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept=".csv,text/csv"
        data-testid="connections-import-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void read(file);
        }}
      />
      <button type="button" className="cs-small" title="Make a design from a from/to pin CSV (a connection list)" onClick={() => input.current?.click()}>
        Connections CSV…
      </button>
      {jobId === undefined ? null : <ImportJob id={jobId} onClose={() => setJobId(undefined)} onPublished={onImported} />}
      {!open ? null : (
        <div role="dialog" aria-label="Connections CSV import" className="cs-import-dialog fixed inset-x-3 top-12 z-50 mx-auto flex max-h-[85vh] max-w-3xl flex-col gap-2 overflow-auto rounded-md border border-line bg-panel p-3 text-[12px] text-ink shadow-lg">
          <strong>Design from {fileName}</strong>
          <div className="text-faint">One row per connection, each end written part.pin (J1.3). A part is a connector: pick which, unless its name already is one.</div>
          <div className="flex flex-wrap items-center gap-2">
            <label>
              Design id{' '}
              <input aria-label="Design id" value={designId} onChange={(e) => setDesignId(e.target.value)} placeholder={slug(fileName.replace(/\.[^.]+$/, ''))} className="w-48 rounded border border-line bg-panel px-1 font-mono" />
            </label>
            <label>
              Name{' '}
              <input aria-label="Design name" value={label} onChange={(e) => setLabel(e.target.value)} className="w-56 rounded border border-line bg-panel px-1" />
            </label>
            <label>
              Carried on{' '}
              <select aria-label="Wire stock" value={wire} onChange={(e) => setWire(e.target.value)}>
                <option value="">direct pin to pin</option>
                {studio.db.wires.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {result.error === undefined ? null : <div role="alert">{result.error}</div>}
          {analysis === undefined || analysis.parts.length === 0 ? null : (
            <div className="cs-import-table">
              <table className="w-full border-collapse" aria-label="Parts">
                <thead>
                  <tr className="text-left text-faint">
                    <th>Part</th>
                    <th>Rows</th>
                    <th>Connector</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.parts.map((p) => (
                    <tr key={p.name}>
                      <td className="font-mono">{p.name}</td>
                      <td>{p.rows}</td>
                      <td>
                        <select aria-label={`Connector for ${p.name}`} value={parts[p.name] ?? p.connector ?? ''} onChange={(e) => setParts({ ...parts, [p.name]: e.target.value })}>
                          <option value="">not chosen</option>
                          {studio.db.connectors.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div role="status" data-testid="connections-dry-run">
            Dry run: {joints} of {analysis?.rows.length ?? 0} row(s) become joints.
          </div>
          {analysis === undefined || analysis.rows.every((r) => r.problems.length === 0) ? null : (
            <div className="cs-import-table">
              <table className="w-full border-collapse" aria-label="Left out">
                <thead>
                  <tr className="text-left text-faint">
                    <th>Line</th>
                    <th>Row</th>
                    <th>Why it is left out</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.rows
                    .filter((r) => r.problems.length > 0)
                    .slice(0, 200)
                    .map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td className="font-mono">{[r.from, r.to].filter((v) => v !== undefined).join(' → ')}</td>
                        <td>{r.problems.join('; ')}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {message === undefined ? null : <div role="alert">{message}</div>}
          <div className="cs-import-actions">
            <button type="button" className="cs-primary" disabled={busy || joints === 0} onClick={() => void review()}>
              {joints === 0 ? 'Nothing to import' : 'Review the design'}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
