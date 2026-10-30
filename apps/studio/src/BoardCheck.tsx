import { useMemo, useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFileImport } from '@tabler/icons-react';
import { Badge, Button, FileDrop, IconButton, useEditLocked } from '@wirehub/editor-react';
import { vocabEntry, type PcbaDefinition } from '@wirehub/model';
import { boardDisagreements, boardWithFileRow, fileRowAction, netText, parseKicadPcb, type DisagreementKind, type DisagreementRow, type KicadNets } from '@wirehub/module-board-import';
import { request } from './definitions.browser.ts';
import { useOptionalStudio } from './studio-context.tsx';
import { localDateTime } from './when.ts';

/**
 * A board record against its KiCad files (`modules/board-import/src/disagree.ts`): one row per
 * terminal where the schematic, the board file, the record's stored net or its curated terminals
 * differ. The board file is the one stored with the board; the schematic's nets come from the
 * `kicad` pack's `netlist` op (a `board-outputs` job). Keep hides a row until its values change.
 */

interface RunView { id: string; op: string; status: string; createdAt: string; sources: { role: string; path: string; sha256: string; fileName?: string }[]; outputs: { role: string; href: string }[] }
interface JobView { id: string; status: string; error?: string; steps: { text: string }[] }
interface OutputsView {
  available: { ok: boolean; reason?: string };
  source: { stored?: { path: string; sha256: string } };
  latest: RunView[];
  jobs: JobView[];
}
interface Kept { kept: Record<string, string> }

const TAKE: Record<'add' | 'rename' | 'net', (r: DisagreementRow) => string> = {
  add: (r) => `Add ${r.fileTerminal} from the board file`,
  rename: (r) => `Rename ${r.terminal} to ${r.fileTerminal} (label, role and signal stay)`,
  net: (r) => `Take the board file’s net ${r.pcb.map(netText).join(', ')} for ${r.terminal}`,
};

const outputsKey = (id: string): readonly string[] => ['tool-outputs', 'pcbas', id];
const keptPath = (id: string): string => `data/board-checks/${id}.json`;

const ISSUE: Record<DisagreementKind, { text: string; title: string; file?: boolean; warn?: boolean }> = {
  'sch-pcb': { text: 'sch ≠ board', title: 'The schematic puts a pad on another net than the board file (fix in KiCad: update the PCB from the schematic)' },
  'not-in-sch': { text: 'not in sch', title: 'The pad’s part is on the board but not in the schematic' },
  'record-pcb': { text: 'record ≠ file', title: 'The record stored another net than the board file has now', file: true },
  'not-in-file': { text: 'not in file', title: 'The board file yields no terminal on these pads', file: true },
  'not-in-record': { text: 'new in file', title: 'The board file yields a terminal the record lacks', file: true },
  renamed: { text: 'alias', title: 'The board file names these pads differently (the record’s name stands)', file: true },
  'pads-differ': { text: 'pads differ', title: 'The record puts this terminal on other pads than the board file', file: true },
  'signal-net': { text: 'signal ≠ net', title: 'The curated signal contradicts the board file’s net name' },
  'voltage-unstated': { text: 'voltage not stated', title: 'Voltage not stated in KiCad: the net name gives no voltage and names no supply', warn: true },
};

/** An alias alone (same pads, another name in the file) is no disagreement. */
const differs = (r: DisagreementRow): boolean => r.issues.some((i) => i !== 'renamed');

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function get<T>(url: string): Promise<T> {
  const out = await request<T>(url, { method: 'GET' });
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

function Nets({ nets, empty = '—' }: { nets: string[] | undefined; empty?: string }): JSX.Element {
  if (nets === undefined) return <span className="cs-dim">·</span>;
  if (nets.length === 0) return <span className="cs-dim">{empty}</span>;
  return <span className="cs-mono">{nets.map(netText).join(', ')}</span>;
}

export function BoardCheck({ board, editable, onUseFile }: { board: PcbaDefinition; editable: boolean; onUseFile?: () => void }): JSX.Element | null {
  const id = board.id;
  const client = useQueryClient();
  const studio = useOptionalStudio();
  const locked = useEditLocked();
  const [sheets, setSheets] = useState<File[]>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [all, setAll] = useState(false);
  const [showKept, setShowKept] = useState(false);

  const outputs = useQuery({
    queryKey: outputsKey(id), queryFn: () => get<OutputsView>(`/api/tool-outputs/pcbas/${encodeURIComponent(id)}`), retry: false, staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : false),
  });
  const stored = outputs.data?.source.stored;
  const run = outputs.data?.latest.find((r) => r.op === 'netlist');
  const netsHref = run?.outputs.find((o) => o.role === 'nets')?.href;
  const sheetNames = run?.sources.filter((s) => s.role === 'kicad-sch').map((s) => s.fileName ?? /-([^/]+\.kicad_sch)\.txt$/.exec(s.path)?.[1] ?? 'schematic') ?? [];
  const active = outputs.data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const failed = outputs.data?.jobs[0]?.status === 'failed' ? outputs.data.jobs[0] : undefined;

  const boardFile = useQuery({
    queryKey: ['board-check', 'pcb', stored?.sha256], enabled: stored !== undefined, staleTime: Infinity, retry: false,
    queryFn: async () => parseKicadPcb(await get<string>(`/api/docs/${stored!.path}`), `${board.kicadProject ?? id}.kicad_pcb`),
  });
  const nets = useQuery({
    queryKey: ['board-check', 'nets', netsHref], enabled: netsHref !== undefined, staleTime: Infinity, retry: false,
    queryFn: async () => (await (await fetch(netsHref!)).json()) as KicadNets,
  });
  const kept = useQuery({
    queryKey: ['board-check', 'kept', id], retry: false,
    queryFn: async (): Promise<{ doc: Kept; etag: string }> => {
      const response = await fetch(`/api/docs/${keptPath(id)}`);
      if (response.status === 404) return { doc: { kept: {} }, etag: '' };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { doc: (await response.json()) as Kept, etag: response.headers.get('etag') ?? '' };
    },
  });

  const report = useMemo(() => (boardFile.data === undefined ? undefined : boardDisagreements(board, boardFile.data, nets.data, studio?.db.vocab)), [board, boardFile.data, nets.data, studio?.db.vocab]);
  if (stored === undefined) return null;
  if (boardFile.error !== null) return <p className="cs-dim" role="status">{boardFile.error.message}</p>;
  if (report === undefined) return null;

  const keptMap = kept.data?.doc.kept ?? {};
  const isKept = (r: DisagreementRow): boolean => differs(r) && keptMap[r.key] === r.fingerprint;
  const differ = report.rows.filter((r) => differs(r) && !isKept(r));
  const keptRows = report.rows.filter(isKept);
  const agree = report.rows.length - differ.length - keptRows.length;
  const rows = all ? report.rows : showKept ? [...differ, ...keptRows] : differ;
  const fileSide = differ.some((r) => r.issues.some((i) => ISSUE[i].file === true));
  const canWrite = editable && !locked;
  const hasSch = nets.data?.schematic !== undefined;

  const setKept = async (row: DisagreementRow, on: boolean): Promise<void> => {
    const next: Kept = { kept: { ...keptMap } };
    if (on) next.kept[row.key] = row.fingerprint;
    else delete next.kept[row.key];
    const etag = kept.data?.etag ?? '';
    const out = await request(`/api/docs/${keptPath(id)}`, { method: 'PUT', body: next, headers: { 'if-match': etag === '' ? '*' : etag } });
    if (!out.ok) setMessage(out.message);
    await kept.refetch();
  };

  // one row from the board file: re-read the record (its ETag guards the write), change that terminal only, save
  const take = async (row: DisagreementRow): Promise<void> => {
    if (busy || boardFile.data === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const url = `/api/definitions/pcbas/${encodeURIComponent(id)}`;
      const response = await fetch(url);
      if (!response.ok) return setMessage(`Could not read the board (HTTP ${response.status}).`);
      const current = (await response.json()) as PcbaDefinition;
      const next = boardWithFileRow(current, boardFile.data, row.key);
      if (next === undefined) return setMessage('That row no longer differs.');
      const out = await request(url, { method: 'PUT', body: next, headers: { 'if-match': response.headers.get('etag') ?? '' } });
      if (!out.ok) return setMessage(out.message);
      studio?.onDefinitionsChange();
    } finally {
      setBusy(false);
    }
  };

  const check = async (files: File[] | undefined): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const schematics = files === undefined ? undefined : await Promise.all(files.map(async (f) => ({ fileName: f.name, base64: base64(new Uint8Array(await f.arrayBuffer())) })));
      const out = await request<{ job: JobView }>(`/api/tool-outputs/pcbas/${encodeURIComponent(id)}`, { method: 'POST', body: { ops: ['netlist'], ...(schematics === undefined ? {} : { schematics }) } });
      if (!out.ok) setMessage(out.message);
      else setSheets(undefined);
      await client.invalidateQueries({ queryKey: outputsKey(id) });
    } finally {
      setBusy(false);
    }
  };

  const counts = [`${differ.length} differ`, keptRows.length === 0 ? undefined : `${keptRows.length} kept`, `${agree} agree`].filter((x) => x !== undefined).join(' · ');
  return (
    <section className="cs-bj-check-section" data-testid="board-check" aria-label="KiCad check">
      <h4 className="cs-bj-h">KiCad check</h4>
      <div className="cs-bj-toolbar">
        <span data-testid="board-check-counts" className={differ.length === 0 ? 'cs-dim' : ''}>{counts}</span>
        <span className="cs-dim" title="Saved netlist check">
          {sheetNames.length === 0 ? 'board file only' : `sch ${sheetNames.join(', ')}`}
          {run === undefined ? '' : ` · ${localDateTime(run.createdAt)}`}
        </span>
        <span className="cs-spacer" />
        {!canWrite || outputs.data?.available.ok !== true ? null : (
          <>
            <FileDrop accept=".kicad_sch" multiple onFiles={(fs) => setSheets(fs)} disabled={busy || active !== undefined} className="cs-bj-sheetdrop" data-testid="board-check-sheets">
              {sheets === undefined ? (sheetNames.length === 0 ? 'Add schematic…' : 'Other schematic…') : sheets.map((f) => f.name).join(', ')}
            </FileDrop>
            {sheets === undefined && sheetNames.length === 0 ? null : (
              <Button size="xs" disabled={busy || active !== undefined} onClick={() => void check(sheets)} data-testid="board-check-run" title="Run KiCad’s netlist export on the schematic and read the board’s nets (kicad tool pack)">
                {sheets === undefined ? 'Re-check' : 'Check'}
              </Button>
            )}
          </>
        )}
        {!canWrite || !fileSide || onUseFile === undefined ? null : (
          <Button size="xs" onClick={onUseFile} data-testid="board-check-use-file" title="Preview replacing the record’s terminals and nets from the stored board file, then Apply (roles, signals and labels of kept terminals stay)">
            Take the file’s terminals
          </Button>
        )}
      </div>
      {active === undefined ? null : <p role="status" className="cs-dim">{active.status === 'queued' ? 'Waiting for the worker' : 'Reading the nets'}{active.steps.length === 0 ? '' : ` · ${active.steps.at(-1)!.text}`}</p>}
      {failed === undefined || active !== undefined || failed.error === undefined ? null : <p role="alert" className="text-err">{failed.error}</p>}
      {rows.length === 0 ? null : (
        <table className="cs-bj-table" data-testid="board-check-table">
          <thead>
            <tr>
              <th>Terminal</th>
              <th>Pads</th>
              {hasSch ? <th title="Net in the schematic (KiCad netlist export)">Schematic</th> : null}
              <th title="Net in the stored board file">Board file</th>
              <th title="Net the record stored at its import">Record</th>
              <th title="Curated role · signal">Curated</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const keptNow = isKept(r);
              return (
                <tr key={r.key} data-testid={`board-check-row-${r.key}`} className={differs(r) && !keptNow ? (r.issues.includes('signal-net') ? 'is-bad is-contradiction' : r.issues.every((i) => i === 'renamed' || ISSUE[i].warn === true) ? 'is-warn' : 'is-bad') : undefined}>
                  <th scope="row" className="cs-mono" title={r.label}>
                    {r.terminal ?? <span className="cs-dim">—</span>}
                    {r.fileTerminal !== undefined && r.fileTerminal !== r.terminal ? <span className="cs-dim"> ← {r.fileTerminal}</span> : null}
                  </th>
                  <td className="cs-mono cs-dim" title={[r.recordPads === undefined ? undefined : `record: ${r.recordPads.join(' ')}`, r.idPads === undefined ? undefined : `the file’s ${r.terminal}: ${r.idPads.join(' ')}`].filter(Boolean).join(' · ') || undefined}>
                    {r.recordPads === undefined ? null : <><span className="line-through">{r.recordPads.join(' ')}</span>{' '}</>}
                    {r.pads.join(' ') || '—'}
                  </td>
                  {hasSch ? <td><Nets nets={r.schematic} /></td> : null}
                  <td><Nets nets={r.pcb} /></td>
                  <td>{r.record === undefined ? <span className="cs-dim">—</span> : <span className="cs-mono">{netText(r.record) || '—'}</span>}</td>
                  <td className="cs-dim" title={[r.role, r.signal].filter(Boolean).join(' · ') || undefined}>{[r.role === undefined ? undefined : vocabEntry(studio?.db.vocab, 'pad-roles', r.role)?.label ?? r.role, r.signal === undefined ? undefined : vocabEntry(studio?.db.vocab, 'signals', r.signal)?.label ?? r.signal].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{r.issues.map((i) => <Badge key={i} tone={keptNow || i === 'renamed' ? 'neutral' : ISSUE[i].file === true || ISSUE[i].warn === true ? 'warn' : 'err'}><span title={(i === 'signal-net' || i === 'voltage-unstated') && r.contradiction !== undefined ? `${ISSUE[i].title}: ${r.contradiction}` : i === 'renamed' ? `${ISSUE[i].title}: ${r.fileTerminal}` : ISSUE[i].title}>{ISSUE[i].text}</span></Badge>)}</td>
                  <td className="whitespace-nowrap">
                    {(() => {
                      const action = fileRowAction(r);
                      return !canWrite || keptNow || action === undefined ? null : (
                        <IconButton size="xs" label={TAKE[action](r)} icon={<IconFileImport size={13} aria-hidden />} disabled={busy} onClick={() => void take(r)} data-testid={`board-check-take-${r.key}`} />
                      );
                    })()}
                    {!canWrite || !differs(r) ? null : (
                      <Button size="xs" variant="ghost" onClick={() => void setKept(r, !keptNow)} data-testid={`board-check-keep-${r.key}`} title={keptNow ? 'Show it as a disagreement again' : 'Keep the record as it is; the row returns if the files change'}>
                        {keptNow ? 'Unkeep' : 'Keep'}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="cs-bj-toolbar">
        {report.rows.length === 0 ? null : <Button size="xs" variant="ghost" onClick={() => setAll(!all)} data-testid="board-check-all">{all ? 'Differences only' : `All ${report.rows.length} terminals`}</Button>}
        {keptRows.length === 0 || all ? null : <Button size="xs" variant="ghost" onClick={() => setShowKept(!showKept)}>{showKept ? 'Hide kept' : `Show ${keptRows.length} kept`}</Button>}
        {report.pads.length + report.onlySchematic.length + report.onlyPcb.length === 0 ? null : (
          <details data-testid="board-check-other">
            <summary className="cs-dim">
              {[report.pads.length === 0 ? undefined : `${report.pads.length} other pad${report.pads.length === 1 ? '' : 's'} differ`, report.onlySchematic.length === 0 ? undefined : `only in sch: ${report.onlySchematic.join(', ')}`, report.onlyPcb.length === 0 ? undefined : `only on board: ${report.onlyPcb.join(', ')}`].filter(Boolean).join(' · ')}
            </summary>
            {report.pads.length === 0 ? null : (
              <table className="cs-bj-table">
                <tbody>
                  {report.pads.map((p) => <tr key={p.pad}><th scope="row" className="cs-mono">{p.pad}</th><td className="cs-mono">{netText(p.schematic) || '—'}</td><td className="cs-mono">{netText(p.pcb) || '—'}</td></tr>)}
                </tbody>
              </table>
            )}
          </details>
        )}
      </div>
      {message === undefined ? null : <p role="status">{message}</p>}
    </section>
  );
}
