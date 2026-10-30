/**
 * A shell's enclosure: the boards it holds (native outline or declared facts), their
 * occurrences, the design parameters, and Generate → real solids from the `enclosure` tool pack.
 *
 * Saving goes through the ordinary definitions adapter (locks, history, revisions); an incomplete
 * draft saves. Generate saves pending edits first, then runs the pack; its GLB becomes the shell's
 * 3D model (the Library viewer above), STEP/STL/PNG are downloads. Findings warn, never block.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Button, Callout, Combobox, KeyValues, Input, NumberInput, SegmentedControl, Select, Switch, useEditLocked,
  type DefinitionsAdapter, Section, FindingsList, findingsSummary } from '@wirehub/editor-react';
import {
  ENCLOSURE_DEFAULTS, FACT_BASES, enclosureProblems,
  type Db, type EnclosureBoard, type EnclosureFact, type EnclosureParams, type EnclosurePort, type EnclosureSpec, type MechanicalDefinition,
} from '@wirehub/model';
import { UseInDesign } from '../devices/UseInDesign.tsx';
import { cancelEnclosureJob, enclosureKey, generateEnclosure, readEnclosure, type EnclosureRunView, type NativeGeometryView } from './enclosures.browser.ts';
import { localDate } from '../when.ts';

type NumKey = 'wallMm' | 'floorMm' | 'lidMm' | 'clearanceMm' | 'topClearanceMm' | 'standoffMm' | 'standoffDiameterMm' | 'pilotDiameterMm' | 'cornerRadiusMm' | 'lipHeightMm' | 'fitMm' | 'assumedPartHeightMm';

const PARAMS: readonly { key: NumKey; label: string; hint?: string }[] = [
  { key: 'wallMm', label: 'Wall' },
  { key: 'floorMm', label: 'Floor' },
  { key: 'lidMm', label: 'Lid' },
  { key: 'clearanceMm', label: 'Board clearance', hint: 'board edge to inner wall' },
  { key: 'topClearanceMm', label: 'Top clearance', hint: 'tallest part to the lid' },
  { key: 'standoffMm', label: 'Standoff height' },
  { key: 'standoffDiameterMm', label: 'Standoff Ø' },
  { key: 'pilotDiameterMm', label: 'Pilot Ø', hint: 'screw pilot in each standoff and lid post' },
  { key: 'cornerRadiusMm', label: 'Corner radius' },
  { key: 'lipHeightMm', label: 'Lip height' },
  { key: 'fitMm', label: 'Lid fit', hint: 'gap per side between lip and wall' },
  { key: 'assumedPartHeightMm', label: 'Unknown part height', hint: 'used where a part height is unknown; reported as an assumption' },
];

const BASIS_OPTIONS = FACT_BASES.map((b) => ({ value: b, label: b === 'native' ? 'from KiCad source' : b }));
const EDGE_OPTIONS = ['front', 'back', 'left', 'right'].map((e) => ({ value: e, label: e }));
const ROTATIONS = ['0', '90', '180', '270'].map((r) => ({ value: r, label: `${r}°` }));

function FactInput({ label, fact: own, source, onChange, disabled }: { label: string; fact: EnclosureFact | undefined; source?: EnclosureFact | undefined; onChange: (f: EnclosureFact | undefined) => void; disabled: boolean }): JSX.Element {
  // what the record states wins; else what the board's own source states (used at generation the same way)
  const fromSource = (own === undefined || own.value === null) && source !== undefined && source.value !== null;
  const fact = fromSource ? source : own;
  const value = fact?.value ?? null;
  return (
    <label className="flex flex-col gap-1 text-xs" title={fromSource ? source?.note : undefined}>
      <span className="text-faint">{label}{fromSource ? (source?.basis === 'estimated' ? ' · estimated from the board file' : ' · from KiCad source') : ''}</span>
      <span className="flex items-center gap-1">
        <NumberInput className="w-28" aria-label={label} value={value} unit="mm" min={0} step={0.1} disabled={disabled} placeholder="unknown"
          onChange={(v) => onChange(v === null ? (fact === undefined ? undefined : { value: null, basis: 'unknown' }) : { value: v, basis: fromSource || fact === undefined || fact.basis === 'unknown' ? 'declared' : fact.basis })} />
        <Select className="w-28" aria-label={`${label}: how it is known`} size="xs" value={fact?.basis ?? 'unknown'} options={BASIS_OPTIONS} disabled={disabled || value === null}
          onValueChange={(basis) => onChange({ value, basis: basis as EnclosureFact['basis'] })} />
      </span>
    </label>
  );
}

const BASIS_LABEL: Record<string, string> = { native: 'from KiCad source', estimated: 'estimated', declared: 'declared', measured: 'measured', unknown: 'unknown' };

/**
 * Per-part heights of a native board: what the source states (3D model bounds, a Height property),
 * an estimate from the footprint's name, or unknown; a value typed here is the enclosure's own
 * (`componentHeights`, declared) and wins at generation. Unknown and estimated parts first, then
 * the tallest; the tallest part decides the shell's height.
 */
function PartHeights({ board, native, disabled, onChange }: { board: EnclosureBoard; native: NativeGeometryView; disabled: boolean; onChange: (next: EnclosureBoard) => void }): JSX.Element {
  const own = board.componentHeights ?? {};
  // pads, mounting holes and the like: nothing stands on them, so they are listed last and not counted as parts
  const noPart = new Set(native.facts?.noPart ?? []);
  const rows = native.footprints.map((f) => {
    const mine = own[f.ref];
    const fact = mine !== undefined && mine.value !== null ? mine : native.facts?.componentHeights[f.ref];
    const set = mine !== undefined && mine.value !== null;
    return { ...f, fact, source: native.facts?.componentHeights[f.ref], set, bare: noPart.has(f.ref) && !set };
  });
  // ordered by what the source states, so a row does not jump while it is being edited
  const rank = (r: (typeof rows)[number]): number => (noPart.has(r.ref) ? 3 : r.source?.value == null ? 0 : r.source.basis === 'estimated' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (b.source?.value ?? 0) - (a.source?.value ?? 0) || a.ref.localeCompare(b.ref));
  const parts = rows.filter((r) => !r.bare).length;
  const unknown = rows.filter((r) => r.fact?.value == null).length;
  const estimated = rows.filter((r) => r.fact?.basis === 'estimated' && !r.set && !r.bare).length;
  const tallest = rows.filter((r) => r.side === 'top' && r.fact?.value != null).reduce<(typeof rows)[number] | undefined>((t, r) => (t === undefined || r.fact!.value! > t.fact!.value! ? r : t), undefined);
  const setHeight = (ref: string, v: number | null): void => {
    // a field left without a change is not a declaration
    if (v !== null && own[ref] === undefined && v === native.facts?.componentHeights[ref]?.value) return;
    const next = { ...own };
    if (v === null) delete next[ref];
    else next[ref] = { value: v, basis: 'declared' };
    const out = { ...board };
    if (Object.keys(next).length === 0) delete out.componentHeights;
    else out.componentHeights = next;
    onChange(out);
  };
  return (
    <details className="text-xs" data-testid="enclosure-part-heights">
      <summary className="cursor-pointer text-faint">
        Part heights · {parts} parts{rows.length > parts ? ` and ${rows.length - parts} pads or holes` : ''}{tallest === undefined ? '' : `, tallest ${tallest.ref} ${tallest.fact!.value} mm`}
        {unknown > 0 ? ` · ${unknown} unknown` : ''}{estimated > 0 ? ` · ${estimated} estimated` : ''}
      </summary>
      <div className="mt-1 flex max-h-64 flex-col gap-1 overflow-auto">
        {rows.map((r) => (
          <div key={r.ref} className="flex flex-wrap items-center gap-1" data-testid="enclosure-part-height">
            <span className="w-14 font-mono">{r.ref}</span>
            <span className="w-56 truncate text-faint" title={r.footprint}>{r.footprint.split(':').pop()}{r.side === 'bottom' ? ' · underside' : ''}</span>
            <NumberInput className="w-28" aria-label={`${r.ref} height`} value={r.fact?.value ?? null} unit="mm" min={0} step={0.1} placeholder="unknown" disabled={disabled}
              onChange={(v) => setHeight(r.ref, v)} />
            <span title={r.fact?.note}>
              {r.set ? <Badge>declared</Badge> : r.bare ? <Badge>no part</Badge> : r.fact?.value == null ? <Badge tone="warn">unknown</Badge> : r.fact.basis === 'estimated' ? <Badge tone="warn">estimated</Badge> : <Badge tone="info">{BASIS_LABEL[r.fact.basis] ?? r.fact.basis}</Badge>}
            </span>
            {r.set ? <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setHeight(r.ref, null)}>Use source</Button> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function download(name: string, asset: string): JSX.Element {
  return <a key={asset} className="cs-ui-btn no-underline" href={`/api/assets/${asset}`} download={name}>{name}</a>;
}

/** JSON with object keys sorted, for comparing values that went through a store. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

export function EnclosurePanel({ record, db, definitions, onSaved, onGenerated, readOnly }: {
  record: MechanicalDefinition; db: Db; definitions: DefinitionsAdapter | undefined; onSaved: () => void; onGenerated: () => void; readOnly: boolean;
}): JSX.Element {
  const id = record.id;
  const client = useQueryClient();
  const locked = useEditLocked();
  const disabled = readOnly || locked || definitions === undefined;
  const saved = record.enclosure ?? { boards: [], occurrences: [] };
  const [draft, setDraft] = useState<EnclosureSpec>(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setDraft(JSON.parse(savedKey) as EnclosureSpec), [savedKey]);
  const dirty = JSON.stringify(draft) !== savedKey;
  const query = useQuery({
    queryKey: enclosureKey(id), queryFn: () => readEnclosure(id), retry: false, staleTime: 10_000,
    // while a generation job runs, look again
    refetchInterval: (q) => (q.state.data?.job?.status === 'queued' || q.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const run: EnclosureRunView | null = query.data?.run ?? null;
  const job = query.data?.job ?? null;
  const active = job !== null && (job.status === 'queued' || job.status === 'running') ? job : undefined;
  // a job that just finished: the shell's model and outputs changed
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const now = job === null ? undefined : `${job.id}:${job.status}`;
    if (seen.current !== undefined && now !== undefined && seen.current !== now && active === undefined) {
      if (job?.status === 'done') onGenerated();
      else if (job?.status === 'cancelled') setMessage({ tone: 'info', text: 'Cancelled; nothing was saved.' });
      else if (job?.status === 'failed' || job?.status === 'interrupted') setMessage({ tone: 'err', text: job.error ?? 'The generator did not finish.' });
    }
    seen.current = now ?? '';
  }, [job, active, onGenerated]);
  const [busy, setBusy] = useState<'save' | 'generate' | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'info'; text: string }>();
  const problems = useMemo(() => enclosureProblems(draft), [draft]);
  const params: EnclosureParams = draft.params ?? {};
  // key order is not kept by every store (a job request travels as jsonb): compare canonically
  const stale = run !== null && canonical(run.inputs.spec) !== canonical(draft);

  const set = (next: EnclosureSpec): void => setDraft(next);
  const setParam = <K extends keyof EnclosureParams>(key: K, value: EnclosureParams[K] | undefined): void => {
    const nextParams: EnclosureParams = { ...params };
    if (value === undefined || value === null) delete nextParams[key];
    else nextParams[key] = value;
    set({ ...draft, params: nextParams });
  };
  const setBoard = (pcba: string, next: EnclosureBoard): void => set({ ...draft, boards: draft.boards.map((b) => (b.pcba === pcba ? next : b)) });
  const withFact = (b: EnclosureBoard, key: 'widthMm' | 'lengthMm' | 'thicknessMm' | 'heightAboveMm' | 'heightBelowMm', f: EnclosureFact | undefined): EnclosureBoard => {
    const next = { ...b };
    if (f === undefined) delete next[key];
    else next[key] = f;
    return next;
  };

  const save = async (): Promise<boolean> => {
    if (definitions === undefined) return false;
    setBusy('save');
    setMessage(undefined);
    try {
      const out = await definitions.save('mechanicals', { ...record, enclosure: draft });
      if (!out.ok) { setMessage({ tone: 'err', text: `${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}` }); return false; }
      onSaved();
      setMessage({ tone: 'ok', text: 'Enclosure saved.' });
      return true;
    } finally {
      setBusy(undefined);
    }
  };
  const generate = async (): Promise<void> => {
    if (dirty && !(await save())) return;
    setBusy('generate');
    setMessage(undefined);
    try {
      const out = await generateEnclosure(id);
      if (!out.ok) { setMessage({ tone: 'err', text: `${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}` }); return; }
      client.setQueryData(enclosureKey(id), (prev: Awaited<ReturnType<typeof readEnclosure>> | undefined) => ({ id, boards: prev?.boards ?? {}, run: prev?.run ?? null, available: prev?.available, job: out.value.job }));
      await query.refetch();
    } finally {
      setBusy(undefined);
    }
  };
  const cancel = async (jobId: string): Promise<void> => {
    const out = await cancelEnclosureJob(jobId);
    if (!out.ok) setMessage({ tone: 'err', text: out.message });
    await query.refetch();
  };

  // an occurrence by its board's name, numbered when the board appears more than once (with stable occurrence numbering)
  const occurrenceName = (id: string): string => {
    const o = draft.occurrences.find((x) => x.id === id);
    if (o === undefined) return 'Removed placement';
    const same = draft.occurrences.filter((x) => x.pcba === o.pcba);
    const label = db.pcbas.find((p) => p.id === o.pcba)?.label ?? 'Unavailable board';
    return same.length > 1 ? `${label} #${same.indexOf(o) + 1}` : label;
  };
  const boardOptions = db.pcbas.filter((p) => !draft.boards.some((b) => b.pcba === p.id)).map((p) => ({ value: p.id, label: p.label, hint: p.partNumber }));
  const addBoard = (pcba: string): void => {
    const occ = `${pcba.split('-').slice(0, 2).join('-')}-${draft.occurrences.length + 1}`;
    set({ ...draft, boards: [...draft.boards, { pcba, geometry: 'native' }], occurrences: [...draft.occurrences, { id: occ, pcba }] });
  };
  const outputs = run?.outputs ?? [];
  const result = run?.result ?? null;

  return (
    <Section id="enclosure" title="Enclosure" testId="enclosure-panel"
      summary={<span className="inline-flex items-center gap-1">
        {run === null ? <Badge>Not generated</Badge> : run.status === 'failed' ? <Badge tone="err">Last run failed</Badge>
          : stale ? <Badge tone="warn">Inputs changed since generation</Badge> : <Badge tone="ok">Generated {localDate(run.generatedAt)}</Badge>}
        {dirty ? <Badge tone="info">Unsaved</Badge> : null}
      </span>}
      actions={<>
        <Button size="xs" disabled={disabled || !dirty || busy !== undefined} loading={busy === 'save'} onClick={() => void save()}>Save</Button>
        <Button size="xs" disabled={disabled || !dirty || busy !== undefined} onClick={() => setDraft(JSON.parse(savedKey) as EnclosureSpec)}>Revert</Button>
        <Button size="xs" variant="primary" disabled={disabled || busy !== undefined || active !== undefined || query.data?.available?.ok === false || draft.occurrences.length === 0 || problems.length > 0} loading={busy === 'generate' || active !== undefined} onClick={() => void generate()}>
          {dirty ? 'Save & generate' : 'Generate'}
        </Button>
        {active === undefined || readOnly ? null : <Button size="xs" variant="ghost" onClick={() => void cancel(active.id)}>Cancel</Button>}
        {run?.status === 'ok' ? <UseInDesign shell={id} /> : null}
      </>}>
      <div className="flex flex-col gap-3">
      {query.data?.available?.ok === false ? <p role="status" className="text-xs text-faint">{query.data.available.reason}</p> : null}
      {active === undefined ? null : (
        <p role="status" className="text-xs" data-testid="enclosure-job">
          <span className="font-medium">{active.status === 'queued' ? 'Waiting for the worker' : 'Generating'}</span>
          {active.steps.length === 0 ? null : <span className="text-faint"> · {active.steps.at(-1)!.text}</span>}
        </p>
      )}
      {problems.length === 0 ? null : <Callout tone="err">{problems[0]}</Callout>}
      {message === undefined ? null : <p role="status" className={message.tone === 'err' ? 'text-xs text-err' : 'text-xs'}>{message.text}</p>}
      {run === null ? null : (
        <div className="flex flex-col gap-2" data-testid="enclosure-result">
          {result?.outer === undefined ? null : (
            <KeyValues items={[
              ['Outside', `${result.outer.x} × ${result.outer.y} × ${result.outer.z} mm`],
              ['Interior', result.interior === undefined ? '—' : `${result.interior.x} × ${result.interior.y} × ${result.interior.z} mm`],
              ['Occurrences', (result.placements ?? []).map((p) => `${occurrenceName(p.occurrence)} at (${p.offset[0]}, ${p.offset[1]}) ${p.rotation}°`).join(' · ')],
              ['Openings', String((result.openings ?? []).length)],
            ]} />
          )}
          {run.findings.length === 0 ? null : (
            <details className="text-xs" data-testid="enclosure-findings">
              <summary className="cursor-pointer text-faint">{findingsSummary(run.findings)}</summary>
              <FindingsList findings={run.findings} className="mt-1" />
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {outputs.filter((o) => o.asset !== undefined).map((o) => download(`${id}-${o.path.replace(/^enclosure-/, '')}`, o.asset!))}
          </div>
          <details className="text-xs text-faint">
            <summary className="cursor-pointer">Details</summary>
            <p>A generated solid is a proposal: check fit against the real board before printing.</p>
            <p>Made by {run.image} · {run.tool['name'] ?? ''} {run.tool['version'] ?? ''}{run.tool['openCascade'] === undefined ? '' : ` · OCP ${run.tool['openCascade']}`}</p>
          </details>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold" title="Facts are measured, declared, from KiCad source, estimated or unknown; unknown is never treated as zero.">Boards</h4>
        {draft.boards.map((b) => {
          const label = db.pcbas.find((p) => p.id === b.pcba)?.label ?? b.pcba;
          const source = query.data?.boards[b.pcba];
          const native = source !== undefined && 'geometry' in source ? source.geometry : undefined;
          const ports: EnclosurePort[] = b.ports ?? native?.suggestedPorts ?? [];
          const setPort = (i: number, patch: Partial<EnclosurePort>): void => setBoard(b.pcba, { ...b, ports: ports.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
          return (
            <div key={b.pcba} className="flex flex-col gap-2 border border-line p-2" data-testid={`enclosure-board-${b.pcba}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">{label}</span>
                <SegmentedControl aria-label={`${label} geometry`} size="xs" value={b.geometry}
                  options={[{ value: 'native', label: 'Native outline' }, { value: 'declared', label: 'Declared size' }]}
                  onValueChange={(g) => !disabled && setBoard(b.pcba, { ...b, geometry: g as EnclosureBoard['geometry'] })} />
                <span className="text-xs text-faint">
                  {b.geometry === 'native' ? (native !== undefined ? `KiCad outline ${native.widthMm} × ${native.lengthMm} mm, ${native.holes.length} holes, ${native.footprints.length} footprints`
                    : source !== undefined && 'missing' in source ? `No native outline: ${source.missing}` : 'Reading the board file…') : 'Black-box board: declare what you know.'}
                </span>
                <span className="flex-1" />
                <Button size="xs" disabled={disabled} onClick={() => set({ ...draft, boards: draft.boards.filter((x) => x.pcba !== b.pcba), occurrences: draft.occurrences.filter((o) => o.pcba !== b.pcba) })}>Remove board</Button>
              </div>
              <div className="flex flex-wrap gap-3">
                {b.geometry === 'declared' ? <>
                  <FactInput label="Width" fact={b.widthMm} disabled={disabled} onChange={(f) => setBoard(b.pcba, withFact(b, 'widthMm', f))} />
                  <FactInput label="Length" fact={b.lengthMm} disabled={disabled} onChange={(f) => setBoard(b.pcba, withFact(b, 'lengthMm', f))} />
                </> : null}
                <FactInput label="Thickness" fact={b.thicknessMm} source={b.geometry === 'native' ? native?.facts?.thicknessMm : undefined} disabled={disabled} onChange={(f) => setBoard(b.pcba, withFact(b, 'thicknessMm', f))} />
                <FactInput label="Tallest part above" fact={b.heightAboveMm} source={b.geometry === 'native' ? native?.facts?.heightAboveMm : undefined} disabled={disabled} onChange={(f) => setBoard(b.pcba, withFact(b, 'heightAboveMm', f))} />
                <FactInput label="Tallest part below" fact={b.heightBelowMm} source={b.geometry === 'native' ? native?.facts?.heightBelowMm : undefined} disabled={disabled} onChange={(f) => setBoard(b.pcba, withFact(b, 'heightBelowMm', f))} />
              </div>
              {b.geometry === 'native' && native !== undefined && native.footprints.length > 0 ? <PartHeights board={b} native={native} disabled={disabled} onChange={(next) => setBoard(b.pcba, next)} /> : null}
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-faint">Port openings{b.ports === undefined && ports.length > 0 ? ` · suggested from edge connectors${ports.some((q) => q.basis === 'estimated') ? ' (some heights estimated)' : ', heights from KiCad source'}` : ''}</span>
                  <Button size="xs" disabled={disabled} onClick={() => setBoard(b.pcba, { ...b, ports: [...ports, { id: `port-${ports.length + 1}`, edge: 'front', atMm: 10, zMm: 2, widthMm: 8, heightMm: 4, basis: 'declared' }] })}>Add port</Button>
                  {b.ports !== undefined && native !== undefined ? <Button size="xs" disabled={disabled} onClick={() => { const next = { ...b }; delete next.ports; setBoard(b.pcba, next); }}>Use suggestions</Button> : null}
                </div>
                {ports.map((q, i) => (
                  <div key={`${q.id}-${i}`} className="flex flex-wrap items-center gap-1 text-xs" data-testid="enclosure-port">
                    <Input className="w-28" aria-label={`Port ${i + 1} name`} value={q.label ?? ''} placeholder={`Port ${i + 1}`} disabled={disabled} onChange={(e) => setPort(i, { label: e.target.value })} />
                    <Select className="w-24" aria-label="Edge" size="xs" value={q.edge} options={EDGE_OPTIONS} disabled={disabled} onValueChange={(e) => setPort(i, { edge: e as EnclosurePort['edge'] })} />
                    <NumberInput className="w-28" aria-label="Along edge" value={q.atMm} unit="mm" step={0.5} disabled={disabled} onChange={(v) => v !== null && setPort(i, { atMm: v })} />
                    <NumberInput className="w-28" aria-label="Centre above board" value={q.zMm} unit="mm z" step={0.5} disabled={disabled} onChange={(v) => v !== null && setPort(i, { zMm: v })} />
                    <NumberInput className="w-28" aria-label="Width" value={q.widthMm} unit="mm w" step={0.5} min={0.5} disabled={disabled} onChange={(v) => v !== null && setPort(i, { widthMm: v })} />
                    <NumberInput className="w-28" aria-label="Height" value={q.heightMm} unit="mm h" step={0.5} min={0.5} disabled={disabled} onChange={(v) => v !== null && setPort(i, { heightMm: v, basis: 'declared' })} />
                    <Select className="w-24" aria-label="Shape" size="xs" value={q.shape ?? 'rect'} options={[{ value: 'rect', label: 'rect' }, { value: 'round', label: 'round' }]} disabled={disabled} onValueChange={(s) => setPort(i, { shape: s as 'rect' | 'round' })} />
                    {q.basis === 'estimated' ? <Badge tone="warn">estimated</Badge> : q.basis === 'native' ? <Badge tone="info">from KiCad source</Badge> : null}
                    <Button size="xs" disabled={disabled} onClick={() => setBoard(b.pcba, { ...b, ports: ports.filter((_, j) => j !== i) })}>Remove</Button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {disabled ? null : <Combobox aria-label="Add a board" size="xs" value={null} options={boardOptions} placeholder="Add a board…" onValueChange={addBoard} emptyText="No other boards" />}
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold" title="The same board may appear more than once; leave x/y blank to lay them out automatically.">Occurrences</h4>
        {draft.occurrences.map((o, i) => (
          <div key={o.id} className="flex flex-wrap items-center gap-1 text-xs" data-testid="enclosure-occurrence">
            <span className="w-48 truncate" title={occurrenceName(o.id)}>{occurrenceName(o.id)}</span>
            <Select className="w-24" aria-label="Rotation" size="xs" value={String(o.rotationDeg ?? 0)} options={ROTATIONS} disabled={disabled}
              onValueChange={(r) => set({ ...draft, occurrences: draft.occurrences.map((x, j) => (j === i ? { ...x, rotationDeg: Number(r) } : x)) })} />
            {(['xMm', 'yMm'] as const).map((k) => (
              <NumberInput className="w-28" key={k} aria-label={k === 'xMm' ? 'x' : 'y'} value={o[k] ?? null} unit={k === 'xMm' ? 'mm x' : 'mm y'} placeholder="auto" disabled={disabled}
                onChange={(v) => set({ ...draft, occurrences: draft.occurrences.map((x, j) => { if (j !== i) return x; const n = { ...x }; if (v === null) delete n[k]; else n[k] = v; return n; }) })} />
            ))}
            <Button size="xs" disabled={disabled} onClick={() => {
              let n = draft.occurrences.length + 1;
              const base = o.id.replace(/-\d+$/, '');
              while (draft.occurrences.some((x) => x.id === `${base}-${n}`)) n += 1;
              set({ ...draft, occurrences: [...draft.occurrences, { id: `${base}-${n}`, pcba: o.pcba }] });
            }}>Add another</Button>
            <Button size="xs" disabled={disabled} onClick={() => set({ ...draft, occurrences: draft.occurrences.filter((_, j) => j !== i) })}>Remove</Button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold" title="Defaults are choices; change them freely.">Design parameters</h4>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PARAMS.map(({ key, label, hint }) => (
            <label key={key} className="flex flex-col gap-1 text-xs" title={hint}>
              <span className="text-faint">{label}</span>
              <NumberInput aria-label={label} value={params[key] ?? ENCLOSURE_DEFAULTS[key]} unit="mm" min={0} step={0.1} disabled={disabled} onChange={(v) => setParam(key, v ?? undefined)} />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-xs" title="floor top to lid underside; blank = derived from the tallest board">
            <span className="text-faint">Interior height</span>
            <NumberInput aria-label="Interior height" value={params.interiorHeightMm ?? null} unit="mm" min={1} step={0.5} placeholder="auto" disabled={disabled} onChange={(v) => setParam('interiorHeightMm', v ?? undefined)} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <SegmentedControl aria-label="Lid" size="xs" value={params.lid ?? 'flat'} options={[{ value: 'flat', label: 'Flat lid' }, { value: 'split', label: 'Split shell' }]} onValueChange={(v) => !disabled && setParam('lid', v as 'flat' | 'split')} />
          {(params.lid ?? 'flat') === 'split' ? (
            <label className="flex items-center gap-1"><span className="text-faint">Split at</span>
              <NumberInput aria-label="Split height" value={params.splitHeightMm ?? null} unit="mm" placeholder="auto" disabled={disabled} onChange={(v) => setParam('splitHeightMm', v ?? undefined)} />
            </label>
          ) : <Switch label="Lid screws" checked={params.lidScrews ?? ENCLOSURE_DEFAULTS.lidScrews} disabled={disabled} onCheckedChange={(v) => setParam('lidScrews', v)} />}
          <Switch label="Lid vents" checked={params.ventsLid ?? ENCLOSURE_DEFAULTS.ventsLid} disabled={disabled} onCheckedChange={(v) => setParam('ventsLid', v)} />
          <Switch label="Side vents" checked={params.ventsSides ?? ENCLOSURE_DEFAULTS.ventsSides} disabled={disabled} onCheckedChange={(v) => setParam('ventsSides', v)} />
        </div>
      </div>

      </div>
    </Section>
  );
}
