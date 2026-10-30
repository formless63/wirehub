/**
 * The Commissioning section of a firmware project (`docs/firmware.md` § Commissioning): the units
 * an operator flashed with one of the project's builds, and what they saw. WireHub never reaches a
 * device; the operator downloads a build's flash bundle, flashes at the bench and records it here.
 * Recording is authorised separately from compiling (owners, and the operators an owner names).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';
import { Button, Callout, Chip, Combobox, DataTable, Field, Input, Select, Textarea, type DataColumn, type Tone } from '@wirehub/editor-react';

import { unwrap } from '../products.browser.ts';
import type { FirmwareBuild } from '../firmware.ts';
import {
  COMMISSION_METHODS,
  COMMISSION_RESULTS,
  METHOD_LABEL,
  RESULT_LABEL,
  type CommissionMethod,
  type CommissionResult,
  type FirmwareCommission,
} from '../firmware-commission.ts';
import { commissionsKey, fetchCommissions, recordCommission } from '../firmware-commission.browser.ts';
import { displayName } from '../display.ts';
import { fileUrl } from '../firmware.browser.ts';
import { localDateTime } from '../when.ts';
import { unitName } from '../units.ts';
import { fetchUnits, unitsKey } from '../units.browser.ts';

const RESULT_TONE: Record<CommissionResult, Tone> = { ok: 'ok', partial: 'warn', failed: 'err' };

interface Draft {
  build: string;
  artifact: string;
  ref: string;
  serial: string;
  method: CommissionMethod;
  result: CommissionResult;
  operator: string;
  performedAt: string;
  observed: string;
  note: string;
  supersedes: string;
}

const emptyDraft = (build?: FirmwareBuild): Draft => ({
  build: build?.id ?? '', artifact: build?.outputs.find((o) => o.role === 'firmware')?.sha256 ?? '', ref: '', serial: '',
  method: 'usb', result: 'ok', operator: '', performedAt: '', observed: '', note: '', supersedes: '',
});

export function FirmwareCommissioning({ project, builds, placement }: { project: string; builds: FirmwareBuild[]; placement?: (o: { design: string; instance: string }) => string }): JSX.Element {
  const client = useQueryClient();
  const list = useQuery({ queryKey: commissionsKey(project), queryFn: () => unwrap(fetchCommissions(project)), retry: false });
  const compiled = builds.filter((b) => b.status === 'ok' && b.outputs.some((o) => o.role === 'firmware'));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(compiled[0]));
  const [saving, setSaving] = useState(false);
  const records = list.data?.commissions ?? [];
  const superseded = new Set(records.map((c) => c.supersedes).filter((s): s is string => s !== undefined));
  const build = compiled.find((b) => b.id === draft.build);
  const artifacts = build?.outputs.filter((o) => o.role === 'firmware') ?? [];
  // the inventory's built units: picked in the form, and named in the table when a record links one
  const units = useQuery({ queryKey: unitsKey(), queryFn: async () => { const out = await fetchUnits(); return out.ok ? out.value.units : []; }, retry: false });
  const unitById = useMemo(() => new Map((units.data ?? []).map((u) => [u.id, u])), [units.data]);
  const unitOptions = useMemo(() => {
    const opts = (units.data ?? []).map((u) => ({ value: u.id, label: unitName(u), hint: u.label.length > 24 ? `${u.label.slice(0, 23)}…` : u.label }));
    return draft.ref !== '' && !unitById.has(draft.ref) ? [{ value: draft.ref, label: displayName(draft.ref, 'Unavailable unit') }, ...opts] : opts;
  }, [units.data, unitById, draft.ref]);

  const columns = useMemo((): DataColumn<FirmwareCommission>[] => [
    { id: 'at', header: 'Performed', width: 140, sortValue: (c) => c.performedAt, cell: (c) => localDateTime(c.performedAt, true) },
    { id: 'unit', header: 'Unit', width: 200, mono: true, sortValue: (c) => c.unit.ref, cell: (c) => (
      <span title={c.unit.inventoryUnit === undefined ? 'Not linked to an inventory unit' : unitById.get(c.unit.inventoryUnit)?.label ?? 'Inventory unit'}>
        {(() => {
          const linked = c.unit.inventoryUnit === undefined ? undefined : unitById.get(c.unit.inventoryUnit);
          if (linked !== undefined) return unitName(linked);
          return <>{displayName(c.unit.ref, 'Unavailable unit')}{c.unit.serial === undefined || c.unit.serial === c.unit.ref ? null : <span className="text-muted"> · {c.unit.serial}</span>}</>;
        })()}
      </span>
    ) },
    { id: 'result', header: 'Result', width: 250, sortValue: (c) => c.result, cell: (c) => (
      <span className="flex gap-1"><Chip tone={RESULT_TONE[c.result]}>{RESULT_LABEL[c.result]}</Chip>{superseded.has(c.id) ? <Chip tone="neutral">superseded</Chip> : null}</span>
    ) },
    { id: 'artifact', header: 'Firmware', width: 120, mono: true, cell: (c) => (
      <a className="underline" href={fileUrl(project, c.artifact.sha256)} download={c.artifact.path.split('/').pop()} title={c.artifact.path}>
        {c.artifact.path.split('/').pop()}
      </a>
    ) },
    { id: 'method', header: 'Method', width: 90, cell: (c) => <span title={METHOD_LABEL[c.method]}>{c.method}</span> },
    { id: 'operator', header: 'Operator', width: 140, sortValue: (c) => c.operator, cell: (c) => <span title={`Recorded by ${c.recordedBy}, ${localDateTime(c.recordedAt, true)}`}>{c.operator}</span> },
    { id: 'observed', header: 'Observed', width: 320, cell: (c) => <span title={c.note}>{c.observed}{c.supersedes === undefined ? '' : ` (corrects ${records.find((record) => record.id === c.supersedes) ? localDateTime(records.find((record) => record.id === c.supersedes)!.performedAt, true) : 'an earlier record'})`}</span> },
  ], [project, records, unitById]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      const out = await recordCommission(project, {
        build: draft.build, artifact: draft.artifact, unit: { ref: draft.ref.trim(), ...(draft.serial.trim() === '' ? {} : { serial: draft.serial.trim() }) },
        method: draft.method, result: draft.result, ...(draft.observed.trim() === '' ? {} : { observed: draft.observed }),
        ...(draft.operator.trim() === '' ? {} : { operator: draft.operator.trim() }),
        ...(draft.performedAt === '' ? {} : { performedAt: new Date(draft.performedAt).toISOString() }),
        ...(draft.note.trim() === '' ? {} : { note: draft.note }),
        ...(draft.supersedes === '' ? {} : { supersedes: draft.supersedes }),
      });
      if (!out.ok) return void toast.error(out.message, { description: out.hint });
      await client.invalidateQueries({ queryKey: commissionsKey(project) });
      toast.success(`Recorded commissioning of ${displayName(out.value.commission.unit.ref, 'unit')}.`);
      setDraft(emptyDraft(build));
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const allowed = list.data?.authority.allowed === true;
  return (
    <div className="flex flex-col gap-2" data-testid="firmware-commissioning">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-semibold" title="Which unit got which compiled firmware, by whom, and what was seen. WireHub does not flash devices: download a build's flash bundle, flash at the bench, then record it here.">Commissioning</h2>
        <span className="cs-ui-grow" />
        {allowed && !open ? <Button size="sm" disabled={compiled.length === 0} title={compiled.length === 0 ? 'Compile the project first' : undefined} onClick={() => { setDraft(emptyDraft(compiled[0])); setOpen(true); }}>Record commissioning</Button> : null}
      </div>
      {list.error === null ? null : <Callout tone="err">{String(list.error.message)}</Callout>}
      {list.data !== undefined && !allowed ? <Callout tone="info">{list.data.authority.reason ?? 'You may not record commissioning.'}</Callout> : null}
      {!open ? null : (
        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2" data-testid="commission-form">
          <legend>Record commissioning</legend>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Build">
              <Select aria-label="Build" className="w-72" value={draft.build === '' ? undefined : draft.build}
                options={compiled.map((b) => ({ value: b.id, label: `${localDateTime(b.startedAt, true)} · ${b.occurrence === undefined ? 'defaults' : placement?.(b.occurrence) ?? `${b.occurrence.design} / ${b.occurrence.instance}`}` }))}
                onValueChange={(v) => { const b = compiled.find((x) => x.id === v); setDraft({ ...draft, build: v, artifact: b?.outputs.find((o) => o.role === 'firmware')?.sha256 ?? '' }); }} />
            </Field>
            <Field label="Firmware file">
              <Select aria-label="Firmware file" className="w-72" value={draft.artifact === '' ? undefined : draft.artifact}
                options={artifacts.map((o) => ({ value: o.sha256, label: o.path }))} onValueChange={(v) => setDraft({ ...draft, artifact: v })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Unit" required hint="A built unit, or type an asset tag or serial.">
              <Combobox aria-label="Unit" className="w-72" placeholder="Built unit or serial" value={draft.ref === '' ? null : draft.ref} options={unitOptions}
                onValueChange={(v) => { const u = unitById.get(v); setDraft({ ...draft, ref: v, serial: u?.serial ?? (u === undefined ? draft.serial : '') }); }}
                onCreate={(text) => setDraft({ ...draft, ref: text })} />
            </Field>
            <Field label="Serial"><Input aria-label="Serial" className="w-48" mono value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} /></Field>
            <Field label="Method">
              <Select aria-label="Method" className="w-60" value={draft.method} options={COMMISSION_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))} onValueChange={(v) => setDraft({ ...draft, method: v as CommissionMethod })} />
            </Field>
            <Field label="Result">
              <Select aria-label="Result" className="w-60" value={draft.result} options={COMMISSION_RESULTS.map((r) => ({ value: r, label: RESULT_LABEL[r] }))} onValueChange={(v) => setDraft({ ...draft, result: v as CommissionResult })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Operator" hint="Who flashed it; you, when empty.">
              <Input aria-label="Operator" className="w-56" value={draft.operator} onChange={(e) => setDraft({ ...draft, operator: e.target.value })} />
            </Field>
            <Field label="Performed" hint="Now, when empty.">
              <Input aria-label="Performed at" type="datetime-local" className="w-56" value={draft.performedAt} onChange={(e) => setDraft({ ...draft, performedAt: e.target.value })} />
            </Field>
            {records.length === 0 ? null : (
              <Field label="Corrects" hint="An earlier record this one replaces.">
                <Select aria-label="Corrects" className="w-72" placeholder="Nothing" value={draft.supersedes === '' ? undefined : draft.supersedes}
                  options={records.map((c) => ({ value: c.id, label: `${displayName(c.unit.ref, 'Unavailable unit')} · ${localDateTime(c.performedAt, true)}` }))} onValueChange={(v) => setDraft({ ...draft, supersedes: v })} />
              </Field>
            )}
          </div>
          <Field label="Observed">
            <Textarea aria-label="Observed" rows={2} placeholder="Boot messages, indicators, a self-test, a measured value" value={draft.observed} onChange={(e) => setDraft({ ...draft, observed: e.target.value })} />
          </Field>
          <Field label="Note"><Input aria-label="Note" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Button variant="primary" disabled={saving || draft.artifact === '' || draft.ref.trim() === ''} onClick={() => void submit()}>Record</Button>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </fieldset>
      )}
      {records.length === 0 ? <span className="text-sm text-muted">No unit commissioned yet.</span> : (
        <DataTable label="Commissioning records" testId="commission-records" rows={records} columns={columns} getRowId={(c) => c.id} columnsKey="firmware-commissions" />
      )}
    </div>
  );
}
