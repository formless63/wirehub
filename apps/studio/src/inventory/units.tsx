/**
 * Built units and their test results (`src/units.ts`, `docs/inventory.md` § Units and test results):
 * the units of a design under its Build panel, the inventory's Units tab, one unit's drawer (its
 * results and firmware commissioning) and the Result dialog. Results are optional; a stale one
 * only says so.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, Chip, DataTable, Drawer, Field, Input, KeyValues, SegmentedControl, type DataColumn } from '@wirehub/editor-react';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { RESULT_LABEL, type CommissionResult } from '../firmware-commission.ts';
import { inventoryKey, unwrap } from '../inventory.browser.ts';
import { UNIT_TEST_KIND_COVERS, UNIT_TEST_KIND_LABEL, UNIT_TEST_KINDS, unitName, type BuiltUnit, type UnitTestKind, type UnitTestResult, type UnitTestView } from '../units.ts';
import { fetchUnit, fetchUnitCommissions, fetchUnits, recordUnitTest, unitCommissionsKey, unitKey, unitsKey } from '../units.browser.ts';
import { localDate, localDateTime } from '../when.ts';
import { Shell } from './dialogs.tsx';

const revText = (rev: number | undefined): string => (rev === undefined ? '—' : `Rev ${rev}`);
const BUILT_FROM_WORKING = 'Built from the working copy, not a saved revision';

function appliesTitle(t: UnitTestView): string {
  const at = t.coverage?.rev === undefined ? 'the working copy' : `Rev ${t.coverage.rev}`;
  if (t.applies === 'stale') return `Tested at ${at}. ${t.change ?? 'What it covers changed.'}`;
  if (t.applies === 'carried') return `Tested at ${at}; Rev ${t.against} covers the same.`;
  if (t.applies === 'unknown') return 'Coverage could not be worked out.';
  return `Tested at ${at}. ${UNIT_TEST_KIND_COVERS[t.kind]}`;
}

/** `Continuity pass`, plus `stale` when what it covered has changed since. */
export function ResultChip({ test, short }: { test: UnitTestView; short?: boolean }): JSX.Element {
  const label = short === true ? test.result : `${UNIT_TEST_KIND_LABEL[test.kind]} ${test.result}`;
  return (
    <span className="inline-flex items-center gap-1" data-testid={`result-${test.kind}`} data-result={test.result} data-applies={test.applies} title={appliesTitle(test)}>
      <Chip tone={test.result === 'pass' ? 'ok' : 'err'}>{label}</Chip>
      {test.applies === 'stale' ? <Chip tone="warn">stale</Chip> : null}
    </span>
  );
}

export function RecordResultDialog({ unit, onClose, onDone }: { unit: Pick<BuiltUnit, 'id' | 'serial' | 'batchCode' | 'builtAt' | 'n'>; onClose: () => void; onDone: (t: UnitTestView) => void }): JSX.Element {
  const [kind, setKind] = useState<UnitTestKind>('continuity');
  const [result, setResult] = useState<UnitTestResult>('pass');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (): Promise<void> => {
    setBusy(true);
    const out = await recordUnitTest(unit.id, { kind, result, ...(note.trim() === '' ? {} : { note: note.trim() }) });
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onDone(out.value.test);
    onClose();
  };
  return (
    <Shell open onClose={onClose} title={`Result for ${unitName(unit)}`} busy={busy} error={error} submit={() => void submit()} submitLabel="Record">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Test"><SegmentedControl aria-label="Test" value={kind} onValueChange={(v) => setKind(v as UnitTestKind)} options={UNIT_TEST_KINDS.map((k) => ({ value: k, label: UNIT_TEST_KIND_LABEL[k] }))} /></Field>
        <Field label="Result"><SegmentedControl aria-label="Result" value={result} onValueChange={(v) => setResult(v as UnitTestResult)} options={[{ value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Fail' }]} /></Field>
      </div>
      <Field label="Note"><Input aria-label="Note" value={note} placeholder="optional" onChange={(e) => setNote(e.target.value)} /></Field>
    </Shell>
  );
}

const COMMISSION_TONE: Record<CommissionResult, 'ok' | 'warn' | 'err'> = { ok: 'ok', partial: 'warn', failed: 'err' };

/** One unit: where it came from, every result (newest first) and its firmware commissioning. */
export function UnitDrawer({ id, readOnly, onClose }: { id: string; readOnly: boolean; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const [recording, setRecording] = useState(false);
  const query = useQuery({ queryKey: unitKey(id), queryFn: () => unwrap(fetchUnit(id)), retry: false });
  const unit = query.data?.unit;
  const commissions = useQuery({ queryKey: unitCommissionsKey(id), queryFn: () => fetchUnitCommissions(unit!), enabled: unit !== undefined, retry: false });
  return (
    <Drawer open title={unit === undefined ? 'Unit details' : unitName(unit)} onClose={onClose} width={440} testId="unit-drawer" footer={readOnly || unit === undefined ? undefined : <Button variant="primary" size="sm" onClick={() => setRecording(true)}>Result…</Button>}>
      {query.isError ? <div className="text-faint">{query.error instanceof Error ? query.error.message : 'Not found.'}</div> : unit === undefined ? <div className="text-faint">…</div> : (
        <div className="flex flex-col gap-3 text-xs">
          <KeyValues
            items={[
              ['Design', <Link key="d" to="/cables/$id" params={{ id: unit.design }} search={{ view: 'build' }} className="underline">{unit.label}</Link>],
              ['Built to', <span key="r" title={unit.rev === undefined ? BUILT_FROM_WORKING : undefined}>{revText(unit.rev)}</span>],
              ['Batch', <span key="b" title={unit.batchCode || localDateTime(unit.builtAt)}>{unit.batchCode === undefined ? "" : `${unit.batchCode} · `}#{unit.n}</span>],
              ...(unit.serial === undefined ? [] : [['Serial', <span key="s" className="font-mono">{unit.serial}</span>] as const]),
              ['Built', `${localDateTime(unit.builtAt)} · ${unit.builtBy}`],
            ]}
          />
          <div className="text-2xs font-medium uppercase tracking-wide text-faint">Results</div>
          {(query.data?.tests ?? []).length === 0 ? <div className="text-faint">None</div> : (
            <ul className="flex flex-col gap-1" data-testid="unit-results">
              {query.data!.tests.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-2" data-test={t.id}>
                  <span className="w-20 text-faint" title={`${localDateTime(t.at)} · ${t.by}`}>{localDate(t.at)}</span>
                  <ResultChip test={t} />
                  {t.applies === 'stale' && t.change !== undefined ? <span className="text-warn">{t.change}</span> : null}
                  {t.note === undefined ? null : <span className="min-w-0 truncate text-dim" title={t.note}>{t.note}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="text-2xs font-medium uppercase tracking-wide text-faint">Firmware</div>
          {(commissions.data ?? []).length === 0 ? <div className="text-faint">{commissions.isLoading ? '…' : 'None'}</div> : (
            <ul className="flex flex-col gap-1" data-testid="unit-commissions">
              {commissions.data!.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-2" title={`${c.artifact.path} · ${c.operator}`}>
                  <span className="w-20 text-faint">{localDate(c.performedAt)}</span>
                  <Link to="/firmware/$id" params={{ id: c.project }} className="underline">{c.projectLabel ?? 'Firmware project'}</Link>
                  <Chip tone={COMMISSION_TONE[c.result]}>{RESULT_LABEL[c.result]}</Chip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {recording && unit !== undefined ? <RecordResultDialog unit={unit} onClose={() => setRecording(false)} onDone={() => { void client.invalidateQueries({ queryKey: inventoryKey }); toast.success('Recorded.'); }} /> : null}
    </Drawer>
  );
}

function Latest({ unit, kind }: { unit: BuiltUnit; kind: UnitTestKind }): JSX.Element | null {
  const t = unit.latest[kind];
  return t === undefined ? null : <ResultChip test={t} />;
}

/** The units of one design, under its Build panel's batches. */
export function DesignUnits({ design, readOnly }: { design: string; readOnly: boolean }): JSX.Element | null {
  const client = useQueryClient();
  const query = useQuery({ queryKey: unitsKey(design), queryFn: () => unwrap(fetchUnits(design)), retry: false });
  const [open, setOpen] = useState<string>();
  const [recording, setRecording] = useState<BuiltUnit>();
  const units = query.data?.units ?? [];
  if (units.length === 0) return null;
  const stale = units.filter((u) => Object.values(u.latest).some((t) => t?.applies === 'stale')).length;
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="design-units">
      <div className="text-2xs font-medium uppercase tracking-wide text-faint">Units{stale === 0 ? '' : <span className="normal-case text-warn"> · {stale} stale</span>}</div>
      <ul className="flex flex-col gap-0.5">
        {units.slice(0, 50).map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-x-2" data-unit={u.id}>
            <button type="button" className="w-32 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-2xs text-accent hover:underline" title={unitName(u)} onClick={() => setOpen(u.id)}>{unitName(u)}</button>
            <span className="w-14 text-faint" title={u.rev === undefined ? BUILT_FROM_WORKING : undefined}>{revText(u.rev)}</span>
            <Latest unit={u} kind="continuity" />
            <Latest unit={u} kind="bench" />
            <span className="flex-1" />
            {readOnly ? null : <Button size="xs" variant="ghost" onClick={() => setRecording(u)}>Result…</Button>}
          </li>
        ))}
      </ul>
      {units.length > 50 ? <div className="text-faint">{units.length - 50} more in Inventory → Units</div> : null}
      {open === undefined ? null : <UnitDrawer id={open} readOnly={readOnly} onClose={() => setOpen(undefined)} />}
      {recording === undefined ? null : <RecordResultDialog unit={recording} onClose={() => setRecording(undefined)} onDone={() => { void client.invalidateQueries({ queryKey: inventoryKey }); toast.success('Recorded.'); }} />}
    </div>
  );
}

/** Inventory → Units: every built unit, its latest results; a row opens the unit. */
export function UnitsTab({ readOnly }: { readOnly: boolean }): JSX.Element {
  const query = useQuery({ queryKey: unitsKey(), queryFn: () => unwrap(fetchUnits()), retry: false });
  const [open, setOpen] = useState<string>();
  const columns = useMemo((): DataColumn<BuiltUnit>[] => [
    { id: 'unit', header: 'Unit', width: 150, mono: true, sortValue: (u) => unitName(u), cell: (u) => <span title={unitName(u)}>{unitName(u)}</span> },
    { id: 'design', header: 'Design', width: 220, sortValue: (u) => u.label, cell: (u) => u.label },
    { id: 'rev', header: 'Built to', width: 80, sortValue: (u) => u.rev ?? -1, cell: (u) => <span className="text-dim" title={u.rev === undefined ? BUILT_FROM_WORKING : undefined}>{revText(u.rev)}</span> },
    { id: 'continuity', header: 'Continuity', width: 150, sortValue: (u) => u.latest.continuity?.result ?? '', cell: (u) => (u.latest.continuity === undefined ? '' : <ResultChip test={u.latest.continuity} short />) },
    { id: 'bench', header: 'Bench', width: 150, sortValue: (u) => u.latest.bench?.result ?? '', cell: (u) => (u.latest.bench === undefined ? '' : <ResultChip test={u.latest.bench} short />) },
    { id: 'built', header: 'Built', width: 110, sortValue: (u) => u.builtAt, cell: (u) => <span title={`${u.builtAt} · ${u.builtBy}`}>{localDate(u.builtAt)}</span> },
  ], []);
  return (
    <>
      <DataTable
        loading={query.data === undefined && !query.isError}
        label="Built units"
        testId="inventory-units"
        rows={query.data?.units ?? []}
        columns={columns}
        getRowId={(u) => u.id}
        selectedId={open}
        onSelect={(u) => setOpen(u.id)}
        columnsKey="inventory-units"
        empty={<div className="px-4 py-3 text-faint">No built units. Finish units from a design's Build panel.</div>}
      />
      {open === undefined ? null : <UnitDrawer id={open} readOnly={readOnly} onClose={() => setOpen(undefined)} />}
    </>
  );
}
