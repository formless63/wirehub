import { useEffect, useRef, useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Combobox, Select, Textarea } from '@wirehub/editor-react';
import { parseSettings, settingsText, type SettingValue } from './settings-text.ts';
import { request } from '../definitions.browser.ts';

/**
 * OrcaSlicer's presets for the print panel (`server/print/orca.ts`): a printer preset of the listed
 * makers, then a filament and a process preset OrcaSlicer offers for that printer. The list comes
 * from the pack itself; the first time OrcaSlicer is chosen on a hub, the panel asks for it (a job).
 */

export interface OrcaPrinterView {
  name: string; vendor: string; model?: string; nozzle?: number; bed?: [number, number]; height?: number;
  output: 'gcode' | 'gcode+3mf'; defaultProcess: string; defaultMaterial: string; processes: number[]; materials: number[];
}
export interface OrcaCatalogView {
  orcaVersion: string;
  vendors: { id: string; name: string }[];
  printers: OrcaPrinterView[];
  processes: { name: string; layerHeight?: number }[];
  materials: { name: string; type?: string }[];
}
interface CatalogState {
  status: 'ready' | 'reading' | 'missing' | 'failed';
  catalog?: OrcaCatalogView;
  job?: { status: string; error?: string };
  vendors: string[];
}
export interface OrcaPick { printer?: string; material?: string; process?: string }

const SAVED = 'wirehub.print.orca';
/** this browser's last OrcaSlicer pick and slicer (a convenience; storage may be off) */
export function savedPrintChoice(): { slicer?: 'prusaslicer' | 'orcaslicer'; pick: OrcaPick } {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(SAVED) ?? '{}') as { slicer?: unknown; pick?: OrcaPick };
    return { ...(raw.slicer === 'orcaslicer' || raw.slicer === 'prusaslicer' ? { slicer: raw.slicer } : {}), pick: typeof raw.pick === 'object' && raw.pick !== null ? raw.pick : {} };
  } catch {
    return { pick: {} };
  }
}
export function savePrintChoice(slicer: 'prusaslicer' | 'orcaslicer', pick: OrcaPick): void {
  try {
    globalThis.localStorage?.setItem(SAVED, JSON.stringify({ slicer, pick }));
  } catch {
    // storage off: the choice just is not remembered
  }
}

const PATH = '/api/print/slicers/orcaslicer/profiles';
/** OrcaSlicer's profile folder names, as people know the makers */
const MAKER: Record<string, string> = { BBL: 'Bambu Lab', Qidi: 'QIDI' };
/** "0.20mm Standard @BBL X1C" → "0.20mm Standard": the printer is already chosen */
const short = (name: string): string => name.replace(/\s+@.*$/, '') || name;

/** The pick with the printer's defaults filled in (a printer change resets the other two). */
export function resolvePick(catalog: OrcaCatalogView | undefined, pick: OrcaPick): { printer?: OrcaPrinterView; material?: string; process?: string } {
  if (catalog === undefined) return {};
  const printer = catalog.printers.find((p) => p.name === pick.printer)
    ?? catalog.printers.find((p) => p.nozzle === 0.4) ?? catalog.printers[0];
  if (printer === undefined) return {};
  const materials = printer.materials.map((i) => catalog.materials[i]!.name);
  const processes = printer.processes.map((i) => catalog.processes[i]!.name);
  return {
    printer,
    material: pick.material !== undefined && materials.includes(pick.material) ? pick.material : printer.defaultMaterial,
    process: pick.process !== undefined && processes.includes(pick.process) ? pick.process : printer.defaultProcess,
  };
}

export function useOrcaCatalog(enabled: boolean): { state?: CatalogState; refetch: () => Promise<unknown> } {
  const query = useQuery({
    queryKey: ['print-orca-presets'], enabled, retry: false, staleTime: 60_000,
    queryFn: async (): Promise<CatalogState> => {
      const out = await request<CatalogState>(PATH, { method: 'GET' });
      if (!out.ok) throw new Error(out.message);
      return out.value;
    },
    refetchInterval: (q) => (q.state.data?.status === 'reading' ? 1500 : false),
  });
  return { ...(query.data === undefined ? {} : { state: query.data }), refetch: query.refetch };
}

const TWEAKS = '/api/print/slicers/orcaslicer/tweaks';
type Tweaks = Record<string, Record<string, SettingValue>>;

/** The hub's saved OrcaSlicer setting tweaks for one printer preset (`server/print/orca.ts`), edited as key = value lines. */
function TweaksEditor({ printer, tweaks, onClose }: { printer: string; tweaks: Record<string, SettingValue>; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const [text, setText] = useState(settingsText(tweaks));
  const [message, setMessage] = useState<string>();
  const save = async (settings: Record<string, SettingValue> | string): Promise<void> => {
    if (typeof settings === 'string') return setMessage(settings);
    const out = await request<{ tweaks: Tweaks }>(TWEAKS, { method: 'PUT', body: { printer, settings } });
    if (!out.ok) return setMessage(out.message);
    client.setQueryData(['print-orca-tweaks'], out.value.tweaks);
    onClose();
  };
  return <div className="flex basis-full flex-col gap-1" data-testid="orca-tweaks">
    <Textarea mono rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label={`OrcaSlicer tweaks for ${printer}`}
      placeholder={'wall_loops = 3\nsparse_infill_density = 25%\nlayer_height = 0.16'} />
    <div className="flex items-center gap-2">
      <Button size="xs" onClick={() => void save(parseSettings(text))}>Save tweaks</Button>
      {Object.keys(tweaks).length === 0 ? null : <Button size="xs" variant="ghost" onClick={() => void save({})}>Clear</Button>}
      <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
      {message === undefined ? null : <span role="status" className="text-xs text-err">{message}</span>}
    </div>
  </div>;
}

export function OrcaPresets({ pick, onPick, canRead, canEdit, disabled }: { pick: OrcaPick; onPick: (next: OrcaPick) => void; canRead: boolean; canEdit: boolean; disabled: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const tweaksQuery = useQuery({
    queryKey: ['print-orca-tweaks'], retry: false, staleTime: 60_000,
    queryFn: async (): Promise<Tweaks> => {
      const out = await request<{ tweaks: Tweaks }>(TWEAKS, { method: 'GET' });
      if (!out.ok) throw new Error(out.message);
      return out.value.tweaks;
    },
  });
  const { state, refetch } = useOrcaCatalog(true);
  const asked = useRef(false);
  const read = async (): Promise<void> => {
    asked.current = true;
    await request(PATH, { method: 'POST', body: {} });
    await refetch();
  };
  // the first time on this hub (or after a pack update): read the presets once, without a click
  useEffect(() => {
    if (state?.status === 'missing' && canRead && !asked.current) void read();
  });
  if (state === undefined) return <span className="text-xs text-faint">Loading OrcaSlicer presets…</span>;
  if (state.status !== 'ready' || state.catalog === undefined) {
    return <span className="inline-flex items-center gap-2 text-xs" role="status">
      {state.status === 'failed' ? <span className="text-err">Reading OrcaSlicer's presets failed{state.job?.error === undefined ? '' : `: ${state.job.error}`}</span>
        : <span className="text-faint">{canRead ? `Reading OrcaSlicer's printer presets (${state.vendors.map((v) => MAKER[v] ?? v).join(', ')})…` : 'OrcaSlicer presets have not been read on this hub yet.'}</span>}
      {state.status === 'failed' && canRead ? <Button size="xs" variant="ghost" onClick={() => void read()}>Try again</Button> : null}
    </span>;
  }
  const catalog = state.catalog;
  const chosen = resolvePick(catalog, pick);
  const vendorName = (id: string): string => catalog.vendors.find((v) => v.id === id)?.name ?? id;
  const printer = chosen.printer;
  const printerTweaks = printer === undefined ? {} : tweaksQuery.data?.[printer.name] ?? {};
  return <>
    <div className="w-72"><Combobox size="xs" aria-label="OrcaSlicer printer preset" value={printer?.name ?? null} disabled={disabled} placeholder="Find a printer…"
      onValueChange={(v) => onPick({ printer: v })}
      options={catalog.printers.map((p) => ({ value: p.name, label: p.name, hint: vendorName(p.vendor) }))} /></div>
    <div className="w-72"><Combobox size="xs" aria-label="OrcaSlicer filament preset" value={chosen.material ?? null} disabled={disabled} placeholder="Find a filament…"
      onValueChange={(v) => onPick({ ...pick, printer: printer?.name, material: v })}
      options={(printer?.materials ?? []).map((i) => catalog.materials[i]!).map((m) => ({ value: m.name, label: short(m.name), ...(m.type === undefined ? {} : { hint: m.type }) }))} /></div>
    <div className="w-56"><Select size="xs" aria-label="OrcaSlicer process preset" value={chosen.process} disabled={disabled}
      onValueChange={(v) => onPick({ ...pick, printer: printer?.name, process: v })}
      options={(printer?.processes ?? []).map((i) => catalog.processes[i]!).map((p) => ({ value: p.name, label: short(p.name) }))} /></div>
    {printer === undefined ? null : <span className="text-xs text-faint" title={`OrcaSlicer ${catalog.orcaVersion} presets`}>
      {printer.bed === undefined ? '' : `${printer.bed[0]} × ${printer.bed[1]}${printer.height === undefined ? '' : ` × ${printer.height}`} mm · `}{printer.output === 'gcode+3mf' ? 'G-code + printer 3MF' : 'G-code'}
    </span>}
    {printer === undefined || (!canEdit && Object.keys(printerTweaks).length === 0) ? null
      : <Button size="xs" variant="ghost" disabled={!canEdit} aria-expanded={editing} onClick={() => setEditing(!editing)}
        title={Object.keys(printerTweaks).length === 0 ? `Hub-saved OrcaSlicer settings over the presets for ${printer.name} (walls, infill, layer height …)` : `Saved for ${printer.name}, over the presets:\n${settingsText(printerTweaks)}`}>
        Tweaks{Object.keys(printerTweaks).length === 0 ? '' : ` (${Object.keys(printerTweaks).length})`}</Button>}
    {editing && printer !== undefined ? <TweaksEditor key={printer.name} printer={printer.name} tweaks={printerTweaks} onClose={() => setEditing(false)} /> : null}
  </>;
}
