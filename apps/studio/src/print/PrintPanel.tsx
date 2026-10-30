import { ProfileSettings } from './ProfileSettings.tsx';
import { useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, FileDrop, Input, SegmentedControl, Select, Textarea, useEditLocked, Section, FindingsList } from '@wirehub/editor-react';
import { request } from '../definitions.browser.ts';
import { localDate } from '../when.ts';
import { presetName, variantLabel } from './variant-label.ts';
import { PrintBatches } from '../inventory/PrintBatches.tsx';
import { parseSettings, settingsText } from './settings-text.ts';
import { OrcaPresets, resolvePick, savedPrintChoice, savePrintChoice, useOrcaCatalog, type OrcaPick } from './OrcaPresets.tsx';

/**
 * Prepare print (`server/print/api.ts`): slice a shell's parts — its generated enclosure STLs, its
 * 3D model when that is an STL, or an uploaded STL/3MF print file — with a pinned slicer pack, a
 * printer/material/process profile and the panel's support and brim choices. Two slicers: PrusaSlicer with
 * the hub's own profiles, or OrcaSlicer with the presets it ships per printer maker (`OrcaPresets.tsx`). Output is files and provenance — G-code,
 * estimates, slicer version, profile hashes — never a printer operation.
 */

type Kind = 'printer' | 'material' | 'process';
type Slicer = 'prusaslicer' | 'orcaslicer';
const SLICER_LABEL: Record<Slicer, string> = { prusaslicer: 'PrusaSlicer', orcaslicer: 'OrcaSlicer' };
type SettingValue = string | number | boolean;
interface ProfileView { id: string; kind: Kind; label: string; src: string; settings: Record<string, SettingValue>; sha256: string }
interface PartView { path: string; role: string; asset: string; sha256: string; bytes: number; origin?: 'enclosure' | 'model' | 'file'; format?: 'stl' | '3mf'; source?: string; size?: [number, number, number] }
interface Adjustments { supports?: 'off' | 'auto' | 'buildplate'; brimMm?: number }
interface OutputFile { path: string; role: string; mediaType: string; size: number; sha256: string; href: string }
interface RunView {
  id: string; jobId?: string; status: 'ok' | 'failed'; pack: string; packVersion: string; image: string; createdAt: string; durationMs?: number;
  tool: { name: string; version: string }; sources: { role: string; path: string; sha256: string }[];
  params: { orientation?: string; profile?: { sha256: string; parts: Record<Kind, { id: string; label: string; sha256: string }>; adjustments?: Adjustments; tweaks?: Record<string, SettingValue> } };
  findings: { level: 'info' | 'warn' | 'error'; message: string }[]; outputs: OutputFile[]; logHref: string;
}
interface JobView { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; steps: { at: string; text: string }[]; error?: string; result?: { runId?: string } }
interface VariantView {
  id: string; savedAt: string; by?: string; runId: string; orientation: string; parts: { path: string; sha256: string }[];
  profile: { sha256: string; printer: string; material: string; process: string; labels?: { printer: string; material: string; process: string }; effectiveSha256?: string; adjustments?: Adjustments };
  slicer: { name: string; version: string }; estimates: { printTimeText?: string; printTimeSeconds?: number; filamentG?: number; layers?: number; resinMl?: number }; note?: string;
}
interface PrintView {
  available: { ok: boolean; reason?: string };
  pack: { version: string; tool: string };
  resinPack?: { version: string; tool: string };
  slicers?: { id: Slicer; pack: string; version: string; tool: string }[];
  parts: PartView[];
  modelNote?: string;
  profiles: ProfileView[];
  runs: RunView[];
  jobs: JobView[];
  variants: VariantView[];
}
interface Summary { resinMl?: number; exposureS?: number; bottomExposureS?: number; bottomLayers?: number; machineName?: string; printTimeText?: string; filamentG?: number; filamentMm?: number; filamentCm3?: number; layers?: number; heightMm?: number; effectiveProfileSha256?: string }

const key = (id: string): readonly string[] => ['print', id];
const technology = (p: ProfileView | undefined): 'fdm' | 'resin' => (String(p?.settings['printer_technology'] ?? '').toUpperCase() === 'SLA' ? 'resin' : 'fdm');
const RESIN_NAME = /(^|[^a-z])(resin|m?sla)([^a-z]|$)/i;
/** A record that prints in resin: its last slice ran the resin pack, or (never sliced) a part or its model source is named as a resin print. */
const wantsResin = (data: PrintView | undefined): boolean => {
  const last = data?.runs[0];
  if (last !== undefined) return last.pack === 'slicer-resin';
  return (data?.parts ?? []).some((p) => RESIN_NAME.test(p.path) || (p.source !== undefined && RESIN_NAME.test(p.source)));
};
/** The printer's bed (x, y) and height in mm, from a PrusaSlicer profile's bed_shape / max_print_height. */
function bedOf(p: ProfileView | undefined): { bed: [number, number]; height?: number } | undefined {
  const points = String(p?.settings['bed_shape'] ?? '').split(',').map((xy) => xy.split('x').map(Number));
  if (points.length < 3 || points.some((xy) => xy.length !== 2 || xy.some((n) => !Number.isFinite(n)))) return undefined;
  const xs = points.map((xy) => xy[0]!);
  const ys = points.map((xy) => xy[1]!);
  const height = Number(p?.settings['max_print_height']);
  return { bed: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], ...(Number.isFinite(height) && height > 0 ? { height } : {}) };
}

/** A part's footprint and height as it will sit on the bed: as designed, or laid flat (largest face down). */
function footprint(size: [number, number, number], orientation: string): [number, number, number] {
  if (orientation !== 'flat') return size;
  const [a, b, c] = [...size].sort((x, y) => y - x) as [number, number, number];
  return [a, b, c];
}

/**
 * Do these parts fit the bed together? Shelf packing with a 5 mm gap, each part turned when that
 * fits better; deliberately simple — the slicer has the final word.
 */
function packs(sizes: readonly [number, number, number][], bed: { bed: [number, number]; height?: number }): boolean {
  const gap = 5;
  const [bw, bh] = bed.bed;
  const items = sizes.map(([x, y, z]) => ({ w: Math.max(x, y), d: Math.min(x, y), z })).sort((a, b) => b.d - a.d);
  if (items.some((i) => (bed.height !== undefined && i.z > bed.height) || i.w > Math.max(bw, bh) || i.d > Math.min(bw, bh))) return false;
  let rowY = 0;
  let rowDepth = 0;
  let x = 0;
  for (const i of items) {
    // lay the long side along the bed's long side when it fits there
    const [w, d] = i.w <= bw && i.d <= bh ? [i.w, i.d] : [i.d, i.w];
    if (x > 0 && x + w > bw) {
      rowY += rowDepth + gap;
      x = 0;
      rowDepth = 0;
    }
    if (w > bw || rowY + d > bh) return false;
    x += w + gap;
    rowDepth = Math.max(rowDepth, d);
  }
  return true;
}
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const KINDS: readonly Kind[] = ['printer', 'material', 'process'];
const ORIGIN: Record<string, string> = { enclosure: 'Enclosure', model: '3D model', file: 'File' };
const SUPPORTS = [{ value: 'profile', label: 'Supports: profile' }, { value: 'off', label: 'None' }, { value: 'auto', label: 'Auto' }, { value: 'buildplate', label: 'From bed only' }];
const BRIMS = [{ value: 'profile', label: 'Brim: as profile' }, { value: '0', label: 'No brim' }, { value: '3', label: 'Brim 3 mm' }, { value: '5', label: 'Brim 5 mm' }, { value: '8', label: 'Brim 8 mm' }];

/** "supports auto · brim 5 mm", or nothing when the process profile decided both. */
function adjustmentsText(a: Adjustments | undefined): string {
  if (a === undefined) return '';
  const out: string[] = [];
  if (a.supports !== undefined) out.push(a.supports === 'off' ? 'no supports' : a.supports === 'auto' ? 'supports auto' : 'supports from bed');
  if (a.brimMm !== undefined) out.push(a.brimMm === 0 ? 'no brim' : `brim ${a.brimMm} mm`);
  return out.join(' · ');
}

/** The file as base64, for the JSON upload. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function readPrint(id: string): Promise<PrintView> {
  const out = await request<PrintView>(`/api/print/mechanicals/${encodeURIComponent(id)}`, { method: 'GET' });
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

function RunSummary({ run }: { run: RunView }): JSX.Element {
  const summaryOut = run.outputs.find((o) => o.role === 'summary');
  const summary = useQuery({
    queryKey: ['print-summary', summaryOut?.sha256], enabled: summaryOut !== undefined, staleTime: Infinity,
    queryFn: async (): Promise<Summary> => (await fetch(summaryOut!.href, { credentials: 'same-origin' })).json() as Promise<Summary>,
  });
  const s = summary.data;
  if (s === undefined) return <span className="text-faint">…</span>;
  const preview = run.outputs.find((o) => o.role === 'preview');
  if (s.resinMl !== undefined) {
    return <span className="flex items-center gap-2">
      {preview === undefined ? null : <img src={preview.href} alt="Print file preview" className="h-12 w-12 border border-line bg-black" />}
      <span>
        {s.printTimeText ?? '?'} · {s.resinMl} ml resin · {s.layers ?? '?'} layers · {s.heightMm ?? '?'} mm tall · exposure {s.exposureS ?? '?'} s, bottom {s.bottomExposureS ?? '?'} s × {s.bottomLayers ?? '?'}
        <span className="text-faint"> ({s.machineName ?? 'no machine name'}; estimates)</span>
      </span>
    </span>;
  }
  return <span className="flex items-center gap-2">
    {preview === undefined ? null : <img src={preview.href} alt="Plate preview" title="Plate preview (also in the printer file)" className="h-12 w-12 border border-line bg-sunken" />}
    <span>
    {s.printTimeText ?? '?'} · {s.filamentG ?? '?'} g · {s.filamentMm === undefined ? '?' : `${(s.filamentMm / 1000).toFixed(2)} m`} · {s.layers ?? '?'} layers · {s.heightMm ?? '?'} mm tall
    <span className="text-faint"> (slicer estimates)</span>
    </span>
  </span>;
}

/** Edit the hub's print profiles: one at a time, as `key = value` lines (PrusaSlicer setting names). */
function ProfileEditor({ profiles, onSaved, disabled }: { profiles: ProfileView[]; onSaved: () => void; disabled: boolean }): JSX.Element {
  const [id, setId] = useState(profiles[0]?.id ?? '');
  const current = profiles.find((p) => p.id === id);
  const [label, setLabel] = useState(current?.label ?? '');
  const [text, setText] = useState(current === undefined ? '' : settingsText(current.settings));
  const [message, setMessage] = useState<string>();
  const choose = (next: string): void => {
    const p = profiles.find((q) => q.id === next);
    setId(next);
    setLabel(p?.label ?? '');
    setText(p === undefined ? '' : settingsText(p.settings));
    setMessage(undefined);
  };
  const save = async (copy: boolean): Promise<void> => {
    if (current === undefined || !label.trim()) return;
    const settings = parseSettings(text);
    if (typeof settings === 'string') return setMessage(settings);
    let newId = current.id;
    if (copy) {
      let n = 2;
      while (profiles.some((p) => p.id === `${current.id}-${n}`)) n += 1;
      newId = `${current.id}-${n}`;
    }
    const edited: Omit<ProfileView, 'sha256'> = { id: newId, kind: current.kind, label: copy ? `${label} (copy)` : label, src: copy || current.src.startsWith('synthetic') ? 'entered by a user' : current.src, settings };
    const list = profiles.map(({ sha256: _s, ...p }) => p);
    const next = copy ? [...list, edited] : list.map((p) => (p.id === current.id ? edited : p));
    const out = await request<{ profiles: ProfileView[] }>('/api/print/profiles', { method: 'PUT', body: { profiles: next } });
    if (!out.ok) return setMessage(out.message);
    setMessage(`Saved ${edited.label}.`);
    if (copy) { setId(newId); setLabel(edited.label); setText(settingsText(edited.settings)); }
    onSaved();
  };
  return <div className="flex flex-col gap-2 border border-line p-2">
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-80"><Select size="xs" value={id} onValueChange={choose} aria-label="Profile to edit" options={profiles.map((p) => ({ value: p.id, label: `${p.kind}: ${p.label}` }))} /></div>
    </div>
    <Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Profile label" disabled={disabled} />
    {typeof parseSettings(text) === 'string' ? <p role="alert">Correct the advanced settings to return to the form.</p> : <ProfileSettings value={parseSettings(text) as Record<string, SettingValue>} onChange={(settings) => setText(settingsText(settings))} disabled={disabled} />}
    <details><summary>Advanced slicer configuration</summary><Textarea mono rows={10} value={text} onChange={(e) => setText(e.target.value)} aria-label="Profile settings" disabled={disabled} /><p className="text-xs text-faint">PrusaSlicer setting names, one per line. Start and end commands are kept here.</p></details>
    <div className="flex items-center gap-2">
      <Button size="xs" disabled={disabled || !label.trim()} onClick={() => void save(false)}>Save profile</Button>
      <Button size="xs" variant="ghost" disabled={disabled || !label.trim()} onClick={() => void save(true)}>Save as copy</Button>
      {message === undefined ? null : <span role="status" className="text-xs">{message}</span>}
    </div>
  </div>;
}

export function PrintPanel({ id, readOnly }: { id: string; readOnly: boolean }): JSX.Element | null {
  const client = useQueryClient();
  const locked = useEditLocked();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [chosen, setChosen] = useState<string[]>();
  const [orientation, setOrientation] = useState('as-designed');
  const [pick, setPick] = useState<Partial<Record<Kind, string>>>({});
  const [editing, setEditing] = useState(false);
  const [supports, setSupports] = useState('profile');
  const [brim, setBrim] = useState('profile');
  const [saved] = useState(savedPrintChoice);
  // chosen here, this session; else what the record needs, else the slicer this browser used last
  const [slicerChoice, setSlicer] = useState<Slicer | undefined>(undefined);
  // the OrcaSlicer presets chosen here, this session (else the record's last ones, else this browser's)
  const [orcaChoice, setOrcaPick] = useState<OrcaPick>();
  const query = useQuery({
    queryKey: key(id), queryFn: () => readPrint(id), retry: false, staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : false),
  });
  const data = query.data;
  // a resin record takes the resin (PrusaSlicer-family) pack; else the slicer this browser used last, else the one of the record's newest run
  const resinRecord = wantsResin(data);
  const slicer: Slicer = slicerChoice ?? (resinRecord ? 'prusaslicer' : saved.slicer ?? (data?.runs[0]?.pack === 'slicer-orcaslicer' ? 'orcaslicer' : 'prusaslicer'));
  const orca = useOrcaCatalog(slicer === 'orcaslicer');
  if (query.error !== null) return <section aria-label="Prepare print" className="border-t border-line p-2 text-xs text-err">{query.error.message}</section>;
  if (data === undefined) return null;
  // the hub's own profiles default to what this record was last sliced with there, else its newest variant's
  const lastPrusa = data.runs.find((r) => r.pack !== 'slicer-orcaslicer' && r.params.profile !== undefined)?.params.profile?.parts;
  const remembered = (kind: Kind): string | undefined => {
    const want = lastPrusa?.[kind].id ?? data.variants[0]?.profile[kind];
    return data.profiles.some((p) => p.id === want && p.kind === kind) ? want : undefined;
  };
  // a resin printer (printer_technology SLA) takes resin material and process profiles, an FDM one FDM ones
  const printers = data.profiles.filter((p) => p.kind === 'printer');
  const rememberedPrinter = remembered('printer');
  // a resin record defaults to a resin printer: the remembered one when it is resin, else the first resin printer
  const resinDefault = resinRecord && technology(printers.find((p) => p.id === rememberedPrinter)) !== 'resin' ? printers.find((p) => technology(p) === 'resin')?.id : undefined;
  const printerId = pick.printer ?? resinDefault ?? rememberedPrinter ?? printers[0]?.id;
  const printerProfile = data.profiles.find((p) => p.id === printerId);
  // resin goes through the PrusaSlicer-family pack only: with OrcaSlicer chosen the panel is FDM
  const resin = slicer === 'prusaslicer' && technology(printerProfile) === 'resin';
  const fits = (p: ProfileView): boolean => p.kind === 'printer' || (technology(p) === 'resin') === resin;
  const choice = (kind: Kind): string | undefined => {
    if (kind === 'printer') return printerId;
    const ok = (want: string | undefined): string | undefined => data.profiles.find((p) => p.id === want && p.kind === kind && fits(p))?.id;
    return ok(pick[kind]) ?? ok(remembered(kind)) ?? data.profiles.find((p) => p.kind === kind && fits(p))?.id;
  };
  // like the hub's profiles: what this record was last sliced with in OrcaSlicer, else its newest OrcaSlicer variant's
  const lastOrca = data.runs.find((r) => r.pack === 'slicer-orcaslicer' && r.params.profile !== undefined)?.params.profile?.parts;
  const orcaVariant = data.variants.find((v) => /orca/i.test(v.slicer.name))?.profile;
  const recordOrca: OrcaPick | undefined = lastOrca !== undefined ? { printer: lastOrca.printer.id, material: lastOrca.material.id, process: lastOrca.process.id }
    : orcaVariant !== undefined ? { printer: orcaVariant.printer, material: orcaVariant.material, process: orcaVariant.process } : undefined;
  const orcaPick: OrcaPick = orcaChoice ?? recordOrca ?? saved.pick;
  const orcaPrinter = slicer === 'orcaslicer' ? resolvePick(orca.state?.catalog, orcaPick).printer : undefined;
  const bed = slicer === 'orcaslicer'
    ? (orcaPrinter?.bed === undefined ? undefined : { bed: orcaPrinter.bed, ...(orcaPrinter.height === undefined ? {} : { height: orcaPrinter.height }) })
    : bedOf(printerProfile);
  const sized = (path: string): [number, number, number] | undefined => {
    const size = data.parts.find((q) => q.path === path)?.size;
    return size === undefined ? undefined : footprint(size, orientation);
  };
  // until a part is ticked or unticked: the STL parts that fit the bed together, in order
  const fitting = (): string[] => {
    const out: string[] = [];
    for (const p of data.parts.filter((q) => q.format !== '3mf')) {
      const size = sized(p.path);
      const next = [...out, p.path];
      if (bed === undefined || size === undefined || packs(next.map(sized).filter((s) => s !== undefined), bed)) out.push(p.path);
    }
    return out.length > 0 ? out : data.parts.filter((q) => q.format !== '3mf').map((q) => q.path).slice(0, 1);
  };
  const parts = (chosen ?? fitting()).filter((p) => data.parts.some((q) => q.path === p));
  const chosenSizes = parts.map(sized).filter((s) => s !== undefined);
  const tooBig = bed !== undefined && chosenSizes.length > 0 && !packs(chosenSizes, bed);
  const adjustments: Adjustments = { ...(supports === 'profile' ? {} : { supports: supports as Adjustments['supports'] }), ...(brim === 'profile' || resin ? {} : { brimMm: Number(brim) }) };
  // a 3MF is its own plate: choosing it clears the others, choosing an STL clears a 3MF
  const toggle = (part: PartView, on: boolean): void => {
    if (!on) return setChosen(parts.filter((q) => q !== part.path));
    const is3mf = (path: string): boolean => data.parts.find((q) => q.path === path)?.format === '3mf';
    setChosen(part.format === '3mf' ? [part.path] : [...parts.filter((q) => !is3mf(q)), part.path]);
  };
  const active = data.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const last = data.jobs[0];
  const latest = data.runs[0];
  // a failed job that left no run (the part was gone, the pack crashed): its error is the only place it shows
  const lostFailure = last?.status === 'failed' && last.error !== undefined && latest?.jobId !== last.id ? last.error : undefined;
  const disabled = readOnly || locked || busy;
  const printerFile = latest?.outputs.find((o) => o.role === 'gcode' || o.role === 'printer-file');
  const otherFiles = latest?.outputs.filter((o) => o !== printerFile) ?? [];
  const profileTitle = latest?.params.profile === undefined ? '' : KINDS.map((k) => `${k}: ${latest.params.profile!.parts[k].label}`).join(' · ');

  const start = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const orcaChosen = resolvePick(orca.state?.catalog, orcaPick);
      const profile = slicer === 'orcaslicer'
        ? { slicer, printer: orcaChosen.printer?.name, material: orcaChosen.material, process: orcaChosen.process }
        : { printer: choice('printer'), material: choice('material'), process: choice('process') };
      if (slicer === 'orcaslicer') savePrintChoice(slicer, { printer: orcaChosen.printer?.name, material: orcaChosen.material, process: orcaChosen.process });
      const out = await request(`/api/print/mechanicals/${encodeURIComponent(id)}`, { method: 'POST', body: { parts, orientation, ...profile, adjustments } });
      if (!out.ok) setMessage(out.message);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const out = await request(`/api/print/mechanicals/${encodeURIComponent(id)}/files`, { method: 'POST', body: { name: file.name, data: await base64Of(file) } });
      if (!out.ok) setMessage(out.message);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  };
  const removeFile = async (part: PartView): Promise<void> => {
    const out = await request(`/api/print/mechanicals/${encodeURIComponent(id)}/files/${part.asset}`, { method: 'DELETE' });
    if (!out.ok) setMessage(out.message);
    setChosen(parts.filter((q) => q !== part.path));
    await query.refetch();
  };
  const saveVariant = async (runId: string): Promise<void> => {
    const out = await request(`/api/print/mechanicals/${encodeURIComponent(id)}/variants`, { method: 'POST', body: { runId } });
    setMessage(out.ok ? undefined : out.message);
    await query.refetch();
  };

  return <Section id="print" title="Prepare print" testId="print-panel" defaultOpen={false}
    summary={<span title="Files only: no printer is operated">{resin ? data.resinPack?.tool ?? data.pack.tool : data.slicers?.find((s) => s.id === slicer)?.tool ?? data.pack.tool}{latest === undefined ? '' : latest.status === 'ok' ? ' · sliced' : ' · failed'}</span>}>
    <div className="flex flex-col gap-2">
    {data.parts.length === 0 ? null : <>
      {data.available.ok ? null : <p role="status" className="text-xs text-faint">{data.available.reason}</p>}
      <div className="flex flex-wrap gap-3" data-testid="print-parts">
        {data.parts.map((p) => <span key={p.path} className="inline-flex items-center gap-1">
          <Checkbox label={<span className="text-xs" title={p.source}><span className="text-faint">{ORIGIN[p.origin ?? 'enclosure']}:</span> {p.path.replace(/^(model|files)\//, '')} <span className="text-faint">({p.size === undefined ? size(p.bytes) : `${p.size.map((n) => Math.round(n)).join(' × ')} mm`}{p.format === '3mf' ? ', own plate' : ''})</span></span>}
            checked={parts.includes(p.path)} disabled={disabled} onCheckedChange={(on) => toggle(p, on)} />
          {p.origin === 'file' && !readOnly ? <Button size="xs" variant="ghost" disabled={disabled} aria-label={`Remove print file ${p.path}`} onClick={() => void removeFile(p)}>Remove</Button> : null}
        </span>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl size="xs" aria-label="Orientation" value={orientation} onValueChange={setOrientation}
          options={[{ value: 'as-designed', label: 'As designed' }, { value: 'flat', label: 'Lay flat' }]} />
        <SegmentedControl size="xs" aria-label="Slicer" value={slicer} onValueChange={(v) => { setSlicer(v as Slicer); savePrintChoice(v as Slicer, orcaPick); }}
          options={(data.slicers ?? [{ id: 'prusaslicer' as Slicer }]).map((s) => ({ value: s.id, label: SLICER_LABEL[s.id] }))} />
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="print-profile">
        {slicer === 'orcaslicer'
          ? <OrcaPresets pick={orcaPick} onPick={setOrcaPick} canRead={!readOnly && data.available.ok} canEdit={!readOnly && !locked} disabled={disabled} />
          : KINDS.map((kind) => <div key={kind} className="w-72"><Select size="xs" aria-label={`${kind} profile`} value={choice(kind)} onValueChange={(v) => setPick({ ...pick, [kind]: v })}
            options={data.profiles.filter((p) => p.kind === kind && fits(p)).map((p) => ({ value: p.id, label: p.label }))} /></div>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44"><Select size="xs" aria-label="Supports" value={supports} onValueChange={setSupports} options={SUPPORTS} /></div>
        {resin ? null : <div className="w-44"><Select size="xs" aria-label="Brim" value={brim} onValueChange={setBrim} options={BRIMS} /></div>}
      </div>
      {resin ? <p className="text-xs text-faint" data-testid="print-resin-note">Untested on a real printer: print a small test part first.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={disabled || !data.available.ok || active !== undefined || parts.length === 0 || (slicer === 'orcaslicer' && orca.state?.status !== 'ready')} onClick={() => void start()}>Slice</Button>
        {active === undefined ? null : <Button size="xs" variant="ghost" onClick={() => void request(`/api/jobs/${encodeURIComponent(active.id)}/cancel`, { method: 'POST', body: {} }).then(() => query.refetch())}>Cancel</Button>}
        {slicer === 'orcaslicer' ? null : <Button size="xs" variant="ghost" onClick={() => setEditing(!editing)}>{editing ? 'Close profiles' : 'Edit profiles'}</Button>}
        {tooBig && bed !== undefined ? <span className="text-xs text-warn" data-testid="print-fit-warning">{chosenSizes.length > 1 ? `Won't fit the ${Math.round(bed.bed[0])} × ${Math.round(bed.bed[1])} mm bed together: untick a part.` : `Larger than the ${Math.round(bed.bed[0])} × ${Math.round(bed.bed[1])} mm bed.`}</span> : null}
        {active === undefined ? null : <span className="text-xs text-faint" role="status">{active.status === 'queued' ? 'Waiting for the worker' : 'Slicing'}{active.steps.length === 0 ? '' : ` · ${active.steps.at(-1)!.text}`}</span>}
      </div>
    </>}
    {readOnly ? null : <span title="A 3MF is sliced as its own plate with the chosen profile; its own slicer settings are set aside.">
      <FileDrop accept=".stl,.3mf" onFiles={([f]) => { if (f !== undefined) void upload(f); }} onReject={() => setMessage('Print files are STL or 3MF.')} disabled={disabled}
        aria-label="Add a print file" {...(data.modelNote === undefined ? {} : { hint: data.modelNote })}>Add an STL or 3MF print file</FileDrop></span>}
    {readOnly && data.modelNote !== undefined ? <p className="text-xs text-faint">{data.modelNote}</p> : null}
    {editing && slicer !== 'orcaslicer' ? <ProfileEditor profiles={data.profiles} disabled={readOnly || locked} onSaved={() => void client.invalidateQueries({ queryKey: key(id) })} /> : null}
    {lostFailure === undefined || active !== undefined ? null : <p className="text-xs text-err" role="status">Slice failed: {lostFailure}</p>}
    {latest === undefined ? null : <div className="flex flex-col gap-1 text-xs" data-testid="print-latest">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={latest.status === 'ok' ? 'ok' : 'err'}>{latest.status === 'ok' ? 'sliced' : 'failed'}</Badge>
        <span className="text-faint" title={`${latest.tool.name} ${latest.tool.version}\n${latest.pack} ${latest.packVersion}\n${latest.image}\n${new Date(latest.createdAt).toLocaleString()}`}>
          {latest.durationMs === undefined ? '' : `${Math.max(1, Math.round(latest.durationMs / 1000))} s · `}{localDate(latest.createdAt)}
        </span>
        <a className="text-faint underline" href={latest.logHref} target="_blank" rel="noreferrer">log</a>
        {printerFile === undefined ? null : <a href={printerFile.href} download={printerFile.path} className="cs-ui-btn no-underline" data-variant="primary" data-size="xs" title="Prepared printer file">
          Download .{printerFile.path.split('.').pop()} <span className="opacity-70">({size(printerFile.size)})</span></a>}
        {otherFiles.length === 0 ? null : <details className="inline-block">
          <summary className="cursor-pointer text-faint">files ({otherFiles.length})</summary>
          <div className="flex flex-col gap-0.5 pt-1">
            {otherFiles.map((o) => <a key={o.path} href={o.href} download={o.path} className="underline" title={o.role}>{o.path} <span className="text-faint">({size(o.size)})</span></a>)}
          </div>
        </details>}
        {latest.status !== 'ok' || readOnly || data.variants.some((v) => v.runId === latest.id) ? null
          : <Button size="xs" variant="ghost" disabled={locked} onClick={() => void saveVariant(latest.id)}>Save as variant</Button>}
      </div>
      {latest.status === 'ok' ? <RunSummary run={latest} /> : null}
      {latest.params.profile === undefined ? null : <span className="text-faint" title={profileTitle}>
        {KINDS.map((k) => presetName(latest.params.profile!.parts[k].label)).join(' · ')}{latest.params.profile.adjustments === undefined ? '' : ` · ${adjustmentsText(latest.params.profile.adjustments)}`}{latest.params.profile.tweaks === undefined ? '' : ` · ${Object.keys(latest.params.profile.tweaks).length} tweak${Object.keys(latest.params.profile.tweaks).length === 1 ? '' : 's'}`} · {latest.params.orientation}
      </span>}
      <FindingsList findings={latest.findings.filter((f) => f.level !== 'info')} />
    </div>}
    {data.variants.length === 0 ? null : <div className="flex flex-col gap-1 text-xs" data-testid="print-variants">
      <p className="text-faint">Variants</p>
      <ul className="flex flex-col gap-1">
        {data.variants.map((v) => <li key={v.id} title={`${v.slicer.name} ${v.slicer.version} · ${v.parts.map((p) => p.path).join(', ')}`}>
          <span className="font-medium">{variantLabel(v)}</span>
          <span className="text-faint"> · {v.parts.map((p) => p.path.replace(/^(model|files)\//, '')).join(', ')}{v.profile.adjustments === undefined ? '' : ` · ${adjustmentsText(v.profile.adjustments)}`} · {v.orientation} · {v.estimates.printTimeText ?? '?'}, {v.estimates.resinMl === undefined ? `${v.estimates.filamentG ?? '?'} g` : `${v.estimates.resinMl} ml`}</span>
        </li>)}
      </ul>
    </div>}
    <PrintBatches id={id} variants={data.variants} readOnly={readOnly} />
    {message === undefined ? null : <p role="status" className="text-xs">{message}</p>}
    </div>
  </Section>;
}
