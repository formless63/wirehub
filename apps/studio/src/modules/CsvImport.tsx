/**
 * "Bulk CSV…" in the Library (cs-5k1.19): pick a CSV of connectors, wire
 * stocks, components or mechanicals, pair its columns with the record's fields,
 * see a dry run (what is new, what the library already has and how the file
 * differs, which rows are invalid and why), then send the canonical file to the
 * import job, whose plan is reviewed and published as one change set from
 * `ImportJob`. Nothing is written before Publish. Templates are one click each.
 *
 * The mapping, validation and dry run are the module's own functions
 * (`@wirehub/module-csv-library`), the same ones the server's importer runs, so
 * what the dry run shows is what the job will plan.
 */

import { analyseCsv, applyMapping, detectKind, FIELDS, kindOfType, LIBRARY_KINDS, parseCsv, suggestMapping, templateCsv, templateFileName, TYPE_COLUMN, type LibraryKind } from '@wirehub/module-csv-library';
import { useMemo, useRef, useState, type JSX } from 'react';

import { uploadImportJob, startImportJob } from '../jobs.browser.ts';
import { useStudio } from '../studio-context.tsx';
import { ImportJob } from './ImportJob.tsx';

const KIND_LABEL: Record<LibraryKind, string> = { connectors: 'Connectors', wires: 'Wire stocks', components: 'Components', mechanicals: 'Mechanicals' };

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export function CsvImport({ onImported }: { onImported: () => void }): JSX.Element {
  const studio = useStudio();
  const input = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [kind, setKind] = useState<LibraryKind>('components');
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  const [fixed, setFixed] = useState<Record<string, string>>({});
  const [batchSrc, setBatchSrc] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string>();

  const headers = rows[0] ?? [];
  const choose = (next: LibraryKind, hs: readonly string[] = headers): void => {
    setKind(next);
    setMapping(suggestMapping(next, hs));
    setFixed({});
  };

  const read = async (file: File): Promise<void> => {
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) {
      setMessage(`${file.name} has no data rows.`);
      return;
    }
    const hs = parsed[0] as string[];
    const typeIndex = hs.findIndex((h) => h.trim().toLowerCase() === TYPE_COLUMN);
    const guess = (typeIndex >= 0 ? kindOfType(parsed[1]?.[typeIndex] ?? '') : undefined) ?? detectKind(hs) ?? 'components';
    setRows(parsed);
    setFileName(file.name);
    setMessage(undefined);
    setOpen(true);
    choose(guess, hs);
  };

  const csv = useMemo(() => (rows.length === 0 ? '' : applyMapping(rows, kind, mapping, batchSrc, fixed)), [rows, kind, mapping, batchSrc, fixed]);
  const analysis = useMemo(() => (csv === '' ? undefined : analyseCsv(csv, studio.db, { kind })), [csv, studio.db, kind]);
  const counts = {
    new: analysis?.rows.filter((r) => r.status === 'new').length ?? 0,
    exists: analysis?.rows.filter((r) => r.status === 'exists').length ?? 0,
    invalid: analysis?.rows.filter((r) => r.status === 'invalid').length ?? 0,
  };

  const review = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const bytes = new TextEncoder().encode(csv);
      const name = `${fileName.replace(/\.csv$/i, '')}-mapped.csv`;
      let queued = await uploadImportJob('csv-library', 'library-csv', name, bytes);
      if (!queued.ok && (queued.status === 415 || queued.status === 405)) queued = await startImportJob('csv-library', 'library-csv', name, toBase64(bytes));
      if (!queued.ok) {
        setMessage(queued.status === 501 ? 'This studio runs no import jobs. Download the mapped file and use Import… instead.' : `${queued.error}${queued.hint === undefined ? '' : ` ${queued.hint}`}`);
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
        data-testid="csv-import-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void read(file);
        }}
      />
      <button type="button" className="cs-small" title="Import connectors, wire stocks, components or mechanicals from a CSV, with a column mapping and a dry run" onClick={() => input.current?.click()}>
        Bulk CSV…
      </button>
      {message === undefined || open ? null : (
        <span role="status" className="cs-count">
          {message}
        </span>
      )}
      {jobId === undefined ? null : <ImportJob id={jobId} onClose={() => setJobId(undefined)} onPublished={onImported} />}
      {!open ? null : (
        <div role="dialog" aria-label="Bulk CSV import" className="fixed inset-x-0 top-12 z-50 mx-auto flex max-h-[85vh] max-w-3xl flex-col gap-2 overflow-auto rounded-md border border-line bg-panel p-3 text-[12px] text-ink shadow-lg">
          <strong>Bulk import from {fileName}</strong>
          <div className="flex flex-wrap items-center gap-2">
            <label>
              These rows are{' '}
              <select aria-label="Kind of record" value={kind} onChange={(e) => choose(e.target.value as LibraryKind)}>
                {LIBRARY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Source for rows without one{' '}
              <input aria-label="Batch source" value={batchSrc} onChange={(e) => setBatchSrc(e.target.value)} placeholder="e.g. supplier catalog 2026" className="w-56 rounded border border-line bg-panel px-1" />
            </label>
            <span className="text-faint">Templates:</span>
            {LIBRARY_KINDS.map((k) => (
              <button key={k} type="button" className="cs-small" onClick={() => download(templateFileName(k), templateCsv(k))}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <table className="w-full border-collapse" aria-label="Column mapping">
            <thead>
              <tr className="text-left text-faint">
                <th>Field</th>
                <th>Column in your file</th>
                <th>Or the same value for every row</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS[kind].map((f) => (
                <tr key={f.key} title={f.hint}>
                  <td>
                    {f.label}
                    {f.required ? ' *' : ''}
                  </td>
                  <td>
                    <select
                      aria-label={`Column for ${f.label}`}
                      value={mapping[f.key] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) })}
                    >
                      <option value="">not in the file</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `(column ${i + 1})`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`Fixed ${f.label}`}
                      className="w-40 rounded border border-line bg-panel px-1"
                      value={fixed[f.key] ?? ''}
                      onChange={(e) => setFixed({ ...fixed, [f.key]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div role="status" data-testid="csv-dry-run">
            Dry run: {counts.new} new, {counts.exists} already in the library (left as they are), {counts.invalid} invalid.
          </div>
          {analysis === undefined || analysis.rows.length === 0 ? null : (
            <table className="w-full border-collapse" aria-label="Dry run">
              <thead>
                <tr className="text-left text-faint">
                  <th>Line</th>
                  <th>Id</th>
                  <th>Result</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rows.slice(0, 200).map((r) => (
                  <tr key={r.row} data-status={r.status}>
                    <td>{r.row}</td>
                    <td className="font-mono">{r.id}</td>
                    <td>{r.status === 'new' ? 'new' : r.status === 'exists' ? 'exists, skipped' : 'invalid'}</td>
                    <td>{r.problems.length > 0 ? r.problems.join('; ') : r.status === 'exists' ? (r.differs.length === 0 ? 'identical' : `file differs in ${r.differs.join(', ')}`) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {analysis !== undefined && analysis.rows.length > 200 ? <div className="text-faint">Showing the first 200 of {analysis.rows.length} rows.</div> : null}
          {analysis?.notes.map((n) => (
            <div key={n} role="alert">
              {n}
            </div>
          ))}
          {message === undefined ? null : <div role="alert">{message}</div>}
          <div>
            <button type="button" className="cs-primary" disabled={busy || counts.new === 0} onClick={() => void review()}>
              {counts.new === 0 ? 'Nothing new to import' : `Review ${counts.new} new record${counts.new === 1 ? '' : 's'}`}
            </button>
            <button type="button" disabled={busy || csv === ''} onClick={() => download(`${fileName.replace(/\.csv$/i, '')}-mapped.csv`, csv)}>
              Download mapped file
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
