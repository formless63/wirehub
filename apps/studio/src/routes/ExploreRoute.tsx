/**
 * `/explore` — solution exploration (`docs/explore.md`).
 *
 * State a requirement (connect two device ports carrying some signals, or put a board in an
 * enclosure with some ports reachable); the server enumerates combinations of what the library
 * has — resolver options, stocks, plugs, adapter boards, firmware, enclosure presets — and calls
 * each valid, invalid (why) or unknown (which facts are missing). Tick 2–4 to compare side by
 * side; Use turns one into a draft design or enclosure. Exclude / Prefer / Assume are manual
 * decisions kept with the requirement and applied on every re-run. Nothing is saved until a
 * decision or a pick is made; board proposals for gaps are offered only on request.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';
import {
  bindPort, boardFacts, devicePort, pickConnect, pickEnclose, requirementKey, resolveDevice,
  type BomLine, type Combo, type ExploreOverride, type OverrideKind, type Requirement, type Verdict,
} from '@wirehub/model';
import { Button, Checkbox, Chip, NumberInput, Page, SegmentedControl, Select, Callout, type Tone } from '@wirehub/editor-react';

import { RouteHeader } from '../shell/RouteHeader.tsx';
import { useStudio } from '../studio-context.tsx';
import { exploreKey, fetchExplore, forgetExploration, runExploration, saveExploration, type ExploreView } from '../explore.browser.ts';
import { decideProposal, fetchPairProposals, type ProposalRow } from '../resolver.browser.ts';
import { boardGeometryKey, readBoardGeometry } from '../enclosures/enclosures.browser.ts';
import { PresetsDialog } from '../explore/PresetsDialog.tsx';

const FIRST = '__first__';
const TONE: Record<Verdict, Tone> = { valid: 'ok', unknown: 'warn', invalid: 'err' };
type Filter = 'all' | Verdict | 'excluded';

export interface ExploreSearch { source?: string; destination?: string; board?: string }
export function validateExploreSearch(s: Record<string, unknown>): ExploreSearch {
  const id = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(v) ? v : undefined);
  const out: ExploreSearch = {};
  const source = id(s['source']); const destination = id(s['destination']); const board = id(s['board']);
  if (source !== undefined) out.source = source;
  if (destination !== undefined) out.destination = destination;
  if (board !== undefined) out.board = board;
  return out;
}

const unwrap = async <T,>(p: Promise<{ ok: true; value: T } | { ok: false; message: string; hint?: string }>): Promise<T> => {
  const out = await p;
  if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
  return out.value;
};

const qty = (l: BomLine): string => (l.unit === 'mm' ? `${Math.round(l.qty)} mm` : `${l.qty}`);
const avail = (l: BomLine): JSX.Element | null => (l.free === undefined ? null : <span className={l.free >= l.qty ? 'text-ok' : 'text-err'} title="In stock (inventory)">· {l.unit === 'mm' ? `${Math.round(l.free)} mm` : l.free} free</span>);

/** Compare row labels for a combination's facts (`packages/model/src/explore.ts`), with units. */
const FACT_LABEL: Record<string, string> = {
  wallMm: 'Wall', standoffMm: 'Standoff', lid: 'Lid', interiorHeightMm: 'Interior height', outerHeightMm: 'Outer height', outerMm: 'Outside',
  conductors: 'Conductors', parts: 'Parts', kind: 'Kind', lengthMm: 'Length',
};
const factLabel = (key: string): string => FACT_LABEL[key] ?? key.replace(/Mm$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const factValue = (key: string, v: string | number | undefined): string => (v === undefined ? '—' : /Mm$/.test(key) ? `${v} mm` : String(v));
const DIM_LABEL: Record<string, string> = { option: 'Option', stock: 'Stock', 'plug:source': 'Plug (from)', 'plug:destination': 'Plug (to)', firmware: 'Firmware', preset: 'Preset', printer: 'Printer', target: 'Target' };
const dimLabel = (d: string): string => DIM_LABEL[d] ?? d;
const SHORT_TITLE = 'Lines with less in stock than this combination needs';

export function ExploreRoute({ search = {} }: { search?: ExploreSearch }): JSX.Element {
  const studio = useStudio();
  const db = studio.db;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const readOnly = studio.me?.role === 'viewer';
  const view = useQuery({ queryKey: exploreKey, queryFn: () => unwrap(fetchExplore()), retry: false });

  const [kind, setKind] = useState<'connect' | 'enclose'>(search.board !== undefined ? 'enclose' : 'connect');
  const [src, setSrc] = useState({ device: search.source ?? '', port: '' });
  const [dst, setDst] = useState({ device: search.destination ?? '', port: '' });
  const [signals, setSignals] = useState<string[]>([]);
  const [length, setLength] = useState<number | null>(1000);
  const [board, setBoard] = useState(search.board ?? '');
  const [ports, setPorts] = useState<string[]>([]);
  const [firmware, setFirmware] = useState(false);
  const [overrides, setOverrides] = useState<ExploreOverride[]>([]);
  const [compare, setCompare] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);

  const ends = useMemo(() => (db.devices ?? []).filter((d) => resolveDevice(db.devices, d.id)?.board === undefined && d.status !== 'retired'), [db.devices]);
  const requirement: Requirement | undefined = kind === 'connect'
    ? (src.device === '' || dst.device === '' ? undefined : {
      kind: 'connect',
      source: { device: src.device, ...(src.port === '' ? {} : { port: src.port }) },
      destination: { device: dst.device, ...(dst.port === '' ? {} : { port: dst.port }) },
      ...(signals.length === 0 ? {} : { signals }),
      ...(length === null || length <= 0 ? {} : { lengthMm: length }),
    })
    : (board === '' ? undefined : { kind: 'enclose', board, ...(ports.length === 0 ? {} : { ports }), ...(firmware ? { firmware: true } : {}) });
  const key = requirement === undefined ? undefined : requirementKey(requirement);
  const saved = view.data?.saved.find((s) => s.key === key);

  // the decisions kept with this requirement come back when it is stated again
  useEffect(() => { setOverrides(saved?.overrides ?? []); setCompare([]); setOpen(undefined); }, [key, saved?.at]);

  const run = useQuery({
    queryKey: ['explore', 'run', JSON.stringify(requirement), JSON.stringify(overrides), db],
    queryFn: () => unwrap(runExploration(requirement!, overrides)),
    enabled: requirement !== undefined,
    retry: false,
  });
  const exploration = run.data?.exploration;

  const signalChoices = useMemo(() => {
    const out = new Set<string>();
    for (const [e, role] of [[src, 'source'], [dst, 'sink']] as const) {
      const d = e.device === '' ? undefined : resolveDevice(db.devices, e.device);
      const p = d === undefined ? undefined : devicePort(d, e.port === '' ? undefined : e.port, role);
      if (p !== undefined) for (const pin of bindPort(db, p)) if (pin.signal !== undefined) out.add(pin.signal);
    }
    return [...out].sort();
  }, [db, src, dst]);
  // the board's own KiCad source: its edge connectors are port choices too (the enclosure generator opens them)
  const geometry = useQuery({ queryKey: boardGeometryKey(board), queryFn: () => readBoardGeometry(board), enabled: board !== '', retry: false, staleTime: 60_000 });
  const nativePorts = geometry.data?.geometry?.suggestedPorts;
  const portChoices = useMemo(() => (board === '' ? [] : [...new Set((boardFacts(db, board, nativePorts === undefined ? undefined : { ports: nativePorts }).board.ports ?? []).map((p) => p.id))]), [db, board, nativePorts]);

  const persist = async (next: { overrides: ExploreOverride[]; picked?: NonNullable<ExploreView['saved'][number]['picked']> }): Promise<boolean> => {
    if (requirement === undefined || view.data === undefined) return false;
    const out = await saveExploration({ requirement, overrides: next.overrides, ...(next.picked === undefined ? {} : { picked: next.picked }) }, view.data.etags.saved);
    if (!out.ok) { toast.error(out.message, { description: out.hint }); return false; }
    qc.setQueryData(exploreKey, { ...view.data, saved: out.value.saved, etags: out.value.etags });
    return true;
  };
  const decide = async (k: OverrideKind, target: string, reason?: string): Promise<void> => {
    const rest = overrides.filter((o) => !(o.target === target && (o.kind === k || (k === 'prefer' && o.kind === 'exclude') || (k === 'exclude' && o.kind === 'prefer'))));
    const had = overrides.some((o) => o.kind === k && o.target === target);
    const next = had ? rest : [...rest, { kind: k, target, ...(reason === undefined ? {} : { reason }) }];
    setOverrides(next);
    await persist({ overrides: next });
  };
  const has = (k: OverrideKind, target: string): boolean => overrides.some((o) => o.kind === k && o.target === target);

  const use = async (combo: Combo): Promise<void> => {
    if (requirement === undefined) return;
    setBusy(true);
    try {
      if (requirement.kind === 'connect') {
        const out = pickConnect(db, requirement, combo);
        if (!out.ok) { toast.error(out.reason); return; }
        let design = out.design;
        for (let n = 2; studio.designs.some((d) => d.id === design.id); n += 1) design = { ...out.design, id: `${out.design.id}-${n}` };
        const made = await studio.persistence.create(design);
        if (!made.ok) { toast.error(made.message, { description: made.hint }); return; }
        await persist({ overrides, picked: { combo: combo.id, kind: 'designs', id: design.id } });
        toast.success(`Draft ${design.label} created.`);
        void navigate({ to: '/cables/$id', params: { id: design.id }, search: { view: 'build' } });
      } else {
        const out = pickEnclose(db, requirement, combo, { native: geometry.data?.geometry != null });
        if (!out.ok || studio.definitions === undefined) { toast.error(out.ok ? 'This hub cannot create records here.' : out.reason); return; }
        const made = await studio.definitions.create('mechanicals', out.record);
        if (!made.ok) { toast.error(made.message, { description: made.hint }); return; }
        studio.onDefinitionsChange();
        await persist({ overrides, picked: { combo: combo.id, kind: 'mechanicals', id: out.record.id } });
        toast.success(`Draft enclosure ${out.record.label} created.`);
        void navigate({ to: '/library/$kind/$id', params: { kind: 'mechanicals', id: out.record.id }, search: {} });
      }
    } finally {
      setBusy(false);
    }
  };

  const combos = exploration?.combos ?? [];
  const decisionNames = new Map<string, string>();
  for (const combo of combos) {
    decisionNames.set(`combo:${combo.id}`, combo.choices.map((choice) => choice.label).join(' + '));
    for (const choice of combo.choices) decisionNames.set(`${choice.dim}:${choice.id}`, choice.label);
  }
  const shown = combos.filter((c) => filter === 'all' || (filter === 'excluded' ? c.excluded !== undefined : c.excluded === undefined && c.verdict === filter));
  const compared = compare.map((id) => combos.find((c) => c.id === id)).filter((c): c is Combo => c !== undefined);
  // the Why column only when some shown combination has something to say
  const showWhy = shown.some((c) => c.reasons.length + c.unknowns.length + c.warnings.length > 0);

  return (
    <Page testId="explore">
      <RouteHeader title="Combinations" count={exploration === undefined ? undefined : `${exploration.counts.valid} valid · ${exploration.counts.unknown} unknown · ${exploration.counts.invalid} invalid${exploration.counts.excluded > 0 ? ` · ${exploration.counts.excluded} excluded` : ''}`} />
      <div className="flex min-h-0 flex-1 text-xs">
        <aside className="flex w-64 shrink-0 flex-col gap-2 overflow-auto border-r border-line p-2" aria-label="Requirement">
          <SegmentedControl aria-label="Requirement kind" value={kind} onValueChange={(v) => setKind(v as 'connect' | 'enclose')}
            options={[{ value: 'connect', label: 'Connect' }, { value: 'enclose', label: 'Enclose' }]} />
          {kind === 'connect' ? (
            <>
              <EndPick label="From" db={db} devices={ends} value={src} onChange={setSrc} role="source" />
              <EndPick label="To" db={db} devices={ends} value={dst} onChange={setDst} role="sink" />
              <span className="text-faint">Must carry</span>
              <div className="flex flex-wrap gap-1" data-testid="explore-signals">
                {signalChoices.length === 0 ? <span className="text-faint">pick both ends</span> : signalChoices.map((s) => (
                  <button key={s} type="button" className="cs-ui-chip" data-tone={signals.includes(s) ? 'selected' : 'neutral'} data-mono aria-pressed={signals.includes(s)}
                    onClick={() => setSignals((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))}>{s}</button>
                ))}
              </div>
              <label className="flex items-center gap-2"><span className="text-faint w-12">Length</span><NumberInput aria-label="Length" value={length} onChange={setLength} unit="mm" min={1} step={100} /></label>
            </>
          ) : (
            <>
              <Select aria-label="Board" value={board === '' ? undefined : board} placeholder="Board…" onValueChange={(v) => { setBoard(v); setPorts([]); }}
                options={db.pcbas.map((p) => ({ value: p.id, label: p.label }))} />
              <span className="text-faint">Reachable ports</span>
              <div className="flex flex-wrap gap-1">
                {portChoices.length === 0 ? <span className="text-faint">no ports stated for this board</span> : portChoices.map((p) => (
                  <button key={p} type="button" className="cs-ui-chip" data-tone={ports.includes(p) ? 'selected' : 'neutral'} data-mono aria-pressed={ports.includes(p)}
                    onClick={() => setPorts((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]))}>{p}</button>
                ))}
              </div>
              <Checkbox checked={firmware} onCheckedChange={setFirmware} label="Needs firmware" />
              {view.data === undefined ? null : (
                <div className="flex items-center gap-1 border-t border-line pt-2">
                  <span className="min-w-0 flex-1 truncate text-faint" title={view.data.presets.inForce.map((p) => p.label).join(', ')}>{view.data.presets.inForce.length} presets</span>
                  {readOnly ? null : <Button size="xs" variant="ghost" onClick={() => setPresetsOpen(true)}>Edit…</Button>}
                </div>
              )}
            </>
          )}
          {overrides.length === 0 ? null : (
            <section aria-label="Decisions" className="flex flex-col gap-1 border-t border-line pt-2">
              <span className="text-faint">Decisions ({overrides.length})</span>
              {overrides.map((o) => {
                const stale = exploration?.stale.some((s) => s.kind === o.kind && s.target === o.target) === true;
                const name = decisionNames.get(o.target) ?? 'Unavailable choice';
                return (
                  <Chip key={`${o.kind}:${o.target}`} className="max-w-full overflow-hidden" tone={stale ? 'warn' : 'neutral'} title={stale ? 'This choice is no longer available' : o.reason}
                    onRemove={readOnly ? undefined : () => void decide(o.kind, o.target)} removeLabel={`Remove ${o.kind} ${name}`}>
                    {o.kind} {name}{stale ? ' (unavailable)' : ''}
                  </Chip>
                );
              })}
            </section>
          )}
          {(view.data?.saved.length ?? 0) === 0 ? null : (
            <section aria-label="Saved" className="flex flex-col gap-1 border-t border-line pt-2">
              <span className="text-faint">Kept</span>
              {view.data!.saved.map((s) => (
                <div key={s.key} className="flex flex-wrap items-center gap-1">
                  <button type="button" className="min-w-0 flex-1 basis-3/4 truncate text-left font-mono" title={s.key} onClick={() => {
                    const r = s.requirement;
                    if (r.kind === 'connect') {
                      setKind('connect'); setSrc({ device: r.source.device, port: r.source.port ?? '' }); setDst({ device: r.destination.device, port: r.destination.port ?? '' });
                      setSignals(r.signals ?? []); setLength(r.lengthMm ?? null);
                    } else { setKind('enclose'); setBoard(r.board); setPorts(r.ports ?? []); setFirmware(r.firmware === true); }
                  }}>{s.label ?? s.key}</button>
                  {s.picked === undefined ? null : <Chip tone="ok" title="Selected design">{studio.designs.find((d) => d.id === s.picked?.id)?.label ?? 'Selected design'}</Chip>}
                  {readOnly ? null : <Button size="xs" variant="ghost" aria-label={`Forget ${s.key}`} onClick={() => void forgetExploration(s.key, view.data!.etags.saved).then(() => qc.invalidateQueries({ queryKey: exploreKey }))}>×</Button>}
                </div>
              ))}
            </section>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-auto">
          {requirement === undefined ? <div className="p-3 text-faint">{kind === 'connect' ? 'Pick both ends.' : 'Pick a board.'}</div> : null}
          {run.isError ? <Callout tone="err">{String((run.error as Error).message)}</Callout> : null}
          {exploration?.problems.map((p) => <Callout key={p} tone="warn">{p}</Callout>)}
          {exploration === undefined ? null : (
            <>
              <div className="flex items-center gap-2 border-b border-line px-2 py-1">
                <SegmentedControl aria-label="Show" value={filter} onValueChange={(v) => setFilter(v as Filter)} size="xs"
                  options={[{ value: 'all', label: `All ${combos.length}` }, { value: 'valid', label: 'Valid' }, { value: 'unknown', label: 'Unknown' }, { value: 'invalid', label: 'Invalid' }, { value: 'excluded', label: 'Excluded' }]} />
                <span className="flex-1" />
                {exploration.more > 0 ? <span className="text-faint">+{exploration.more} more not listed</span> : null}
                <span className="text-faint">{compare.length === 0 ? 'tick 2–4 to compare' : `${compare.length} ticked`}</span>
                {compare.length > 0 ? <Button size="xs" variant="ghost" onClick={() => setCompare([])}>Clear</Button> : null}
              </div>
              {compared.length >= 2 ? <Compare combos={compared} onUse={use} busy={busy} readOnly={readOnly} /> : null}
              <table className="w-full border-collapse [&_td]:px-1 [&_th]:px-1" data-testid="explore-combos">
                <thead className="text-faint">
                  <tr className="border-b border-line text-left">
                    <th className="w-6" /><th className="w-6">#</th><th>Verdict</th><th>Choices</th><th>Summary</th><th>Bill</th>{showWhy ? <th>Why</th> : null}<th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <ComboRow key={c.id} combo={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? undefined : c.id)}
                      ticked={compare.includes(c.id)} onTick={(on) => setCompare((x) => (on ? [...x, c.id].slice(-4) : x.filter((y) => y !== c.id)))}
                      has={has} decide={decide} onUse={use} busy={busy} readOnly={readOnly} requirement={requirement!} picked={saved?.picked?.combo === c.id} showWhy={showWhy} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
      {presetsOpen && view.data !== undefined ? (
        <PresetsDialog view={view.data} onClose={() => setPresetsOpen(false)}
          onSaved={(presets, etags) => { qc.setQueryData(exploreKey, { ...view.data!, presets, etags }); void qc.invalidateQueries({ queryKey: ['explore', 'run'] }); }} />
      ) : null}
    </Page>
  );
}

function EndPick({ label, db, devices, value, onChange, role }: {
  label: string; db: ReturnType<typeof useStudio>['db']; devices: { id: string; label: string }[]; value: { device: string; port: string };
  onChange: (v: { device: string; port: string }) => void; role: 'source' | 'sink';
}): JSX.Element {
  const d = value.device === '' ? undefined : resolveDevice(db.devices, value.device);
  const ports = d?.ports ?? [];
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-faint">{label}</legend>
      <Select aria-label={`${label} device`} value={value.device === '' ? undefined : value.device} placeholder="Device…"
        options={devices.map((x) => ({ value: x.id, label: x.label }))} onValueChange={(v) => onChange({ device: v, port: '' })} />
      {ports.length > 1 ? (
        <Select aria-label={`${label} port`} value={value.port === '' ? FIRST : value.port}
          options={[{ value: FIRST, label: `${(d && devicePort(d, undefined, role))?.label ?? 'first'} (default)` }, ...ports.map((p) => ({ value: p.id, label: p.label ?? p.id }))]}
          onValueChange={(v) => onChange({ device: value.device, port: v === FIRST ? '' : v })} />
      ) : null}
    </fieldset>
  );
}

function summary(c: Combo): string {
  const f = c.facts;
  if (f['outerMm'] !== undefined) return `${f['outerMm']} mm`;
  if (f['outerHeightMm'] !== undefined) return `h ${f['outerHeightMm']} mm · wall ${f['wallMm']}`;
  return `${f['kind'] ?? ''} · ${f['conductors'] ?? '?'} cond · ${f['parts'] ?? 0} parts`;
}

/** Use: primary on a valid combination; on an invalid one a quiet secondary action that says what it makes. */
function UseButton({ combo: c, busy, onUse, className }: { combo: Combo; busy: boolean; onUse: (c: Combo) => Promise<void>; className?: string }): JSX.Element {
  const invalid = c.verdict === 'invalid';
  return (
    <Button size="xs" className={className} variant={c.verdict === 'valid' ? 'primary' : invalid ? 'ghost' : 'secondary'} disabled={busy}
      title={invalid ? `This combination is invalid (${c.reasons[0] ?? 'see why'}). It becomes a draft design you will have to fix.` : undefined} onClick={() => void onUse(c)}>
      {invalid ? 'Use anyway (draft)' : 'Use'}
    </Button>
  );
}

function ComboRow({ combo: c, open, onToggle, ticked, onTick, has, decide, onUse, busy, readOnly, requirement, picked, showWhy }: {
  combo: Combo; open: boolean; onToggle: () => void; ticked: boolean; onTick: (on: boolean) => void;
  has: (k: OverrideKind, t: string) => boolean; decide: (k: OverrideKind, t: string, reason?: string) => Promise<void>;
  onUse: (c: Combo) => Promise<void>; busy: boolean; readOnly: boolean; requirement: Requirement; picked: boolean; showWhy: boolean;
}): JSX.Element {
  const why = c.reasons[0] ?? c.unknowns[0]?.text ?? c.warnings[0] ?? '';
  const more = c.reasons.length + c.unknowns.length + c.warnings.length - (why === '' ? 0 : 1);
  const canUse = !readOnly && (c.pick !== undefined || c.enclosure !== undefined);
  return (
    <>
      <tr className={`border-b border-line align-top ${c.excluded !== undefined ? 'opacity-60' : ''}`} data-combo={c.id} data-verdict={c.verdict}>
        <td><Checkbox aria-label={`Compare ${c.rank}`} checked={ticked} onCheckedChange={onTick} /></td>
        <td className="text-faint">{c.rank}</td>
        <td>
          <Chip tone={TONE[c.verdict]}>{c.verdict}</Chip>
          {c.preferred ? <Chip tone="selected">preferred</Chip> : null}
          {c.excluded !== undefined ? <Chip title={c.excluded.reason}>excluded</Chip> : null}
          {picked ? <Chip tone="ok">picked</Chip> : null}
        </td>
        <td>
          <button type="button" className="text-left" onClick={onToggle} aria-expanded={open}>
            {c.choices.map((ch) => <span key={ch.dim} className="mr-2"><span className="text-faint">{ch.dim.replace('plug:', '').replace('destination', 'dst').replace('source', 'src')} </span>{ch.label}</span>)}
          </button>
        </td>
        <td className="whitespace-nowrap">{summary(c)}</td>
        <td className="whitespace-nowrap">{c.bom.length === 0 ? '—' : `${c.bom.length} line${c.bom.length === 1 ? '' : 's'}`}{c.short > 0 ? <span className="ml-1 text-err" title={SHORT_TITLE}>{c.short} short</span> : null}</td>
        {showWhy ? <td className={c.verdict === 'invalid' ? 'text-err' : c.verdict === 'unknown' ? 'text-warn' : 'text-faint'}>{why}{more > 0 ? <span className="text-faint"> +{more}</span> : null}</td> : null}
        <td className="whitespace-nowrap text-right">
          {canUse ? <UseButton combo={c} busy={busy} onUse={onUse} /> : null}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-line bg-sunken">
          <td colSpan={showWhy ? 8 : 7} className="p-2">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-3">
              <section>
                <div className="text-faint">Choices</div>
                {c.choices.map((ch) => {
                  const t = `${ch.dim}:${ch.id}`;
                  return (
                    <div key={t} className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate"><span className="text-faint">{ch.dim} </span>{ch.label}</span>
                      {readOnly ? null : <>
                        <Button size="xs" variant={has('prefer', t) ? 'primary' : 'ghost'} onClick={() => void decide('prefer', t)}>Prefer</Button>
                        <Button size="xs" variant={has('exclude', t) ? 'primary' : 'ghost'} onClick={() => void decide('exclude', t, 'excluded when exploring')}>Exclude</Button>
                      </>}
                    </div>
                  );
                })}
                {readOnly ? null : (
                  <div className="mt-1 flex gap-1">
                    <Button size="xs" variant={has('exclude', `combo:${c.id}`) ? 'primary' : 'ghost'} onClick={() => void decide('exclude', `combo:${c.id}`, 'excluded when exploring')}>Exclude this combination</Button>
                  </div>
                )}
              </section>
              <section>
                <div className="text-faint">Findings</div>
                {c.reasons.map((r) => <div key={r} className="text-err">{r}</div>)}
                {c.unknowns.map((u) => (
                  <div key={u.key} className="flex items-center gap-1 text-warn">
                    <span className="flex-1">{u.text}</span>
                    {readOnly ? null : <Button size="xs" variant="ghost" title={`Assume fact:${u.key} holds`} onClick={() => void decide('assume', `fact:${u.key}`, 'accepted when exploring')}>Assume</Button>}
                  </div>
                ))}
                {c.assumed.map((u) => (
                  <div key={u.key} className="flex items-center gap-1 text-faint">
                    <span className="flex-1">assumed: {u.text}</span>
                    {readOnly ? null : <Button size="xs" variant="ghost" onClick={() => void decide('assume', `fact:${u.key}`)}>Undo</Button>}
                  </div>
                ))}
                {c.warnings.map((w) => <div key={w} className="text-warn">{w}</div>)}
                {c.notes.map((n) => <div key={n} className="text-faint">{n}</div>)}
                {c.gaps && requirement.kind === 'connect' ? <Proposals requirement={requirement} readOnly={readOnly} /> : null}
              </section>
              <section>
                <div className="text-faint">Bill</div>
                <Bill lines={c.bom} />
              </section>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Bill({ lines }: { lines: BomLine[] }): JSX.Element {
  if (lines.length === 0) return <div className="text-faint">not derived</div>;
  return (
    <table className="w-full">
      <tbody>
        {lines.map((l) => (
          <tr key={`${l.kind}:${l.id}`}>
            <td className="truncate" title={l.label}>{l.label}</td>
            <td className="text-right whitespace-nowrap">{qty(l)}</td>
            <td className="text-right whitespace-nowrap">{avail(l)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Board drafts for the gaps, only when asked; a decline is kept in the proposals log. */
function Proposals({ requirement, readOnly }: { requirement: Extract<Requirement, { kind: 'connect' }>; readOnly: boolean }): JSX.Element {
  const [rows, setRows] = useState<ProposalRow[]>();
  const load = async (): Promise<void> => {
    const out = await fetchPairProposals({ source: requirement.source, destination: requirement.destination });
    if (out.ok) setRows(out.value.proposals); else toast.error(out.message);
  };
  if (rows === undefined) return <Button size="xs" variant="ghost" onClick={() => void load()}>Board proposals for the gaps</Button>;
  if (rows.length === 0) return <div className="text-faint">no proposals</div>;
  return (
    <div className="mt-1 flex flex-col gap-1" aria-label="Proposals">
      {rows.map((r) => (
        <div key={r.proposal.key} className="flex items-center gap-1">
          <span className="flex-1">{r.proposal.title}</span>
          <Chip tone={r.state === 'declined' ? 'neutral' : r.state === 'accepted' ? 'ok' : 'info'}>{r.state}</Chip>
          {readOnly || r.state !== 'open' ? null : (
            <Button size="xs" variant="ghost" onClick={() => void decideProposal('decline', { key: r.proposal.key, reason: 'declined when exploring', proposal: r.proposal }).then(load)}>Decline</Button>
          )}
        </div>
      ))}
      <Link to="/resolver" className="text-faint">Start a board from Find a design → Proposals</Link>
    </div>
  );
}

/** 2–4 combinations side by side: verdict, choices, summary, every bill line, findings. */
function Compare({ combos, onUse, busy, readOnly }: { combos: Combo[]; onUse: (c: Combo) => Promise<void>; busy: boolean; readOnly: boolean }): JSX.Element {
  const dims = [...new Set(combos.flatMap((c) => c.choices.map((ch) => ch.dim)))];
  const facts = [...new Set(combos.flatMap((c) => Object.keys(c.facts)))];
  const items = new Map<string, string>();
  for (const c of combos) for (const l of c.bom) items.set(`${l.kind}:${l.id}`, l.label);
  const differs = (vals: string[]): string => (new Set(vals).size > 1 ? 'font-semibold' : '');
  return (
    <section aria-label="Compare" className="border-b border-line bg-sunken p-2" data-testid="explore-compare">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left">
            <th className="w-40 text-faint">Compare</th>
            {combos.map((c) => (
              <th key={c.id} className="px-2">
                #{c.rank} <Chip tone={TONE[c.verdict]}>{c.verdict}</Chip>
                {!readOnly && (c.pick !== undefined || c.enclosure !== undefined) ? <UseButton combo={c} busy={busy} onUse={onUse} className="ml-1" /> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dims.map((d) => {
            const vals = combos.map((c) => c.choices.find((ch) => ch.dim === d)?.label ?? '—');
            return <tr key={d} className="border-t border-line"><td className="text-faint">{dimLabel(d)}</td>{vals.map((v, i) => <td key={i} className={`px-2 ${differs(vals)}`}>{v}</td>)}</tr>;
          })}
          {facts.map((f) => {
            const vals = combos.map((c) => factValue(f, c.facts[f]));
            return <tr key={f} className="border-t border-line"><td className="text-faint">{factLabel(f)}</td>{vals.map((v, i) => <td key={i} className={`px-2 ${differs(vals)}`}>{v}</td>)}</tr>;
          })}
          {[...items].map(([k, label]) => {
            const lines = combos.map((c) => c.bom.find((l) => `${l.kind}:${l.id}` === k));
            const vals = lines.map((l) => (l === undefined ? '—' : qty(l)));
            return (
              <tr key={k} className="border-t border-line">
                <td className="truncate text-faint" title={k}>{label}</td>
                {lines.map((l, i) => <td key={i} className={`px-2 ${differs(vals)}`}>{l === undefined ? '—' : <>{qty(l)} {avail(l)}</>}</td>)}
              </tr>
            );
          })}
          <tr className="border-t border-line align-top">
            <td className="text-faint">Findings</td>
            {combos.map((c) => (
              <td key={c.id} className="px-2">
                {c.reasons.map((r) => <div key={r} className="text-err">{r}</div>)}
                {c.unknowns.map((u) => <div key={u.key} className="text-warn">{u.text}</div>)}
                {c.warnings.map((w) => <div key={w} className="text-warn">{w}</div>)}
                {c.reasons.length + c.unknowns.length + c.warnings.length === 0 ? <span className="text-faint">none</span> : null}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}
