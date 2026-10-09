/**
 * "Bulk CSV…" in the Library (cs-5k1.19): pick a CSV or XLSX sheet of connectors, wire
 * stocks, components, mechanicals, boards or kits, pair its columns with the record's fields,
 * see a dry run (what is new, what the library already has and how the file
 * differs, which rows are invalid and why), then send the canonical file to the
 * import job, whose plan is reviewed and published as one change set from
 * `ImportJob`. Nothing is written before Publish. Templates are one click each.
 *
 * The mapping, validation and dry run are the module's own functions
 * (`@wirehub/module-csv-library`), the same ones the server's importer runs, so
 * what the dry run shows is what the job will plan.
 */

import { analyseCsv, applyMapping, detectKind, FIELDS, kindOfType, LIBRARY_KINDS, looksLikeZip, parseCsv, readXlsx, suggestMapping, templateCsv, templateFileName, TYPE_COLUMN, type LibraryKind } from '@wirehub/module-csv-library';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { uploadImportJob, startImportJob } from '../jobs.browser.ts';
import { useStudio } from '../studio-context.tsx';
import { ImportJob } from './ImportJob.tsx';
import { Button, Input, Select } from '@wirehub/editor-react';

/** the "none" option's value: a Radix Select has no empty value */
const NONE = '__none__';
const KIND_LABEL: Record<LibraryKind, string> = { connectors: 'Connectors', wires: 'Wire stocks', components: 'Components', mechanicals: 'Mechanicals', pcbas: 'Boards (PCBAs)', kits: 'Kits' };

/** a value in the dry run's change list, short */
const show = (value: unknown): string => {
  const text = value === undefined ? '(none)' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

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

export function CsvImport({ onImported, expose }: { onImported: () => void; expose?: (open: () => void) => void }): JSX.Element {
  const studio = useStudio();
  const input = useRef<HTMLInputElement | null>(null);
  // the Library's Import menu opens the file picker from its own entry instead of a button here
  useEffect(() => { expose?.(() => input.current?.click()); }, [expose]);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [kind, setKind] = useState<LibraryKind>('components');
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  const [fixed, setFixed] = useState<Record<string, string>>({});
  const [batchSrc, setBatchSrc] = useState('');
  const [update, setUpdate] = useState(false);
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
    let parsed: string[][];
    try {
      parsed = /\.xlsx$/i.test(file.name) || looksLikeZip(new Uint8Array(await file.slice(0, 4).arrayBuffer())) ? await readXlsx(new Uint8Array(await file.arrayBuffer())) : parseCsv(await file.text());
    } catch (error) {
      setMessage(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
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
  const analysis = useMemo(() => (csv === '' ? undefined : analyseCsv(csv, studio.db, { kind, update })), [csv, studio.db, kind, update]);
  const counts = {
    new: analysis?.rows.filter((r) => r.status === 'new').length ?? 0,
    exists: analysis?.rows.filter((r) => r.status === 'exists').length ?? 0,
    update: analysis?.rows.filter((r) => r.status === 'update').length ?? 0,
    invalid: analysis?.rows.filter((r) => r.status === 'invalid').length ?? 0,
  };

  const review = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const bytes = new TextEncoder().encode(csv);
      const name = `${fileName.replace(/\.csv$/i, '')}-mapped.csv`;
      const importer = update ? 'library-csv-update' : 'library-csv';
      let queued = await uploadImportJob('csv-library', importer, name, bytes);
      if (!queued.ok && (queued.status === 415 || queued.status === 405)) queued = await startImportJob('csv-library', importer, name, toBase64(bytes));
      if (!queued.ok) {
        setMessage(queued.status === 501 ? 'This hub runs no import jobs. Download the mapped file and use Import… instead.' : `${queued.error}${queued.hint === undefined ? '' : ` ${queued.hint}`}`);
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
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        data-testid="csv-import-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void read(file);
        }}
      />
      {expose !== undefined ? null : (
        <Button type="button" title="Import library parts from a CSV or an XLSX sheet, with a column mapping and a dry run" onClick={() => input.current?.click()} className="cs-small">
        Bulk CSV…
      </Button>
      )}
      {message === undefined || open ? null : (
        <span role="status" className="cs-count">
          {message}
        </span>
      )}
      {jobId === undefined ? null : <ImportJob id={jobId} onClose={() => setJobId(undefined)} onPublished={onImported} />}
      {!open ? null : (
        <div role="dialog" aria-label="Bulk CSV import" className="cs-import-dialog fixed inset-x-3 top-12 z-50 mx-auto flex max-h-[85vh] max-w-3xl flex-col gap-2 overflow-auto rounded-md border border-line bg-panel p-3 text-xs text-ink shadow-lg">
          <strong>Bulk import from {fileName}</strong>
          <div className="flex flex-wrap items-center gap-2">
            <label>
              These rows are{' '}
              <Select
                aria-label="Kind of record"
                value={kind}
                onValueChange={(v) => choose(v as LibraryKind)}
                options={LIBRARY_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              />
            </label>
            <label>
              Reference for rows without one{' '}
              <Input aria-label="Batch source" value={batchSrc} onChange={(e) => setBatchSrc(e.target.value)} placeholder="e.g. supplier catalog 2026" className="w-56" />
            </label>
            <label title="A row for an id the library has changes that record (blank cells keep what it has) instead of being skipped; the dry run shows each change">
              <input type="checkbox" aria-label="Update existing records" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Update existing records
            </label>
            <span className="text-faint">Templates:</span>
            {LIBRARY_KINDS.map((k) => (
              <Button key={k} type="button" onClick={() => download(templateFileName(k), templateCsv(k))} className="cs-small">
                {KIND_LABEL[k]}
              </Button>
            ))}
          </div>
          <div className="cs-import-table">
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
                      <Select
                        aria-label={`Column for ${f.label}`}
                        value={mapping[f.key] === undefined ? NONE : String(mapping[f.key])}
                        onValueChange={(v) => setMapping({ ...mapping, [f.key]: v === NONE ? undefined : Number(v) })}
                        options={[{ value: NONE, label: 'not in the file' }, ...headers.map((h, i) => ({ value: String(i), label: h || `(column ${i + 1})` }))]}
                      />
                    </td>
                    <td>
                      <Input
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
          </div>
          <div role="status" data-testid="csv-dry-run">
            Dry run: {counts.new} new, {update ? `${counts.update} to update, ${counts.exists} unchanged` : `${counts.exists} already in the library (left as they are)`}, {counts.invalid} invalid.
          </div>
          {analysis === undefined || analysis.rows.length === 0 ? null : (
            <div className="cs-import-table">
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
                      <td>{r.status === 'new' ? 'new' : r.status === 'update' ? 'update' : r.status === 'exists' ? (update ? 'unchanged' : 'exists, skipped') : 'invalid'}</td>
                      <td>
                        {r.problems.length > 0
                          ? r.problems.join('; ')
                          : r.status === 'update'
                            ? (r.changes ?? []).map((c) => `${c.field}: ${show(c.before)} → ${show(c.after)}`).join('; ')
                            : r.status === 'exists'
                              ? r.differs.length === 0
                                ? 'identical'
                                : `file differs in ${r.differs.join(', ')}`
                              : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {analysis !== undefined && analysis.rows.length > 200 ? <div className="text-faint">Showing the first 200 of {analysis.rows.length} rows.</div> : null}
          {analysis?.notes.map((n) => (
            <div key={n} role="alert">
              {n}
            </div>
          ))}
          {message === undefined ? null : <div role="alert">{message}</div>}
          <div className="cs-import-actions">
            <Button type="button" disabled={busy || counts.new + counts.update === 0} onClick={() => void review()} className="cs-primary">
              {counts.new + counts.update === 0
                ? 'Nothing to import'
                : `Review ${[counts.new > 0 ? `${counts.new} new` : '', counts.update > 0 ? `${counts.update} updated` : ''].filter((t) => t !== '').join(' and ')} record${counts.new + counts.update === 1 ? '' : 's'}`}
            </Button>
            <Button type="button" disabled={busy || csv === ''} onClick={() => download(`${fileName.replace(/\.csv$/i, '')}-mapped.csv`, csv)}>
              Download mapped file
            </Button>
            <Button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
