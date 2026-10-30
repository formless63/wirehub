/** Ordinary print settings stay editable without writing slicer configuration. Unknown settings survive. */
import { useState, type JSX } from 'react';
import { Button, Checkbox, Input, NumberInput, Select } from '@wirehub/editor-react';
import type { SettingValue } from './settings-text.ts';

const SETTINGS: Record<string, { label: string; initial: SettingValue }> = {
  printer_technology: { label: 'Print technology', initial: 'FFF' },
  nozzle_diameter: { label: 'Nozzle diameter (mm)', initial: 0.4 },
  max_print_height: { label: 'Maximum print height (mm)', initial: 250 },
  filament_type: { label: 'Material type', initial: 'PLA' },
  filament_diameter: { label: 'Filament diameter (mm)', initial: 1.75 },
  filament_density: { label: 'Material density (g/cm³)', initial: 1.24 },
  filament_cost: { label: 'Material cost per kg', initial: 20 },
  temperature: { label: 'Nozzle temperature (°C)', initial: 210 },
  first_layer_temperature: { label: 'First layer nozzle temperature (°C)', initial: 215 },
  bed_temperature: { label: 'Bed temperature (°C)', initial: 60 },
  first_layer_bed_temperature: { label: 'First layer bed temperature (°C)', initial: 60 },
  layer_height: { label: 'Layer height (mm)', initial: 0.2 },
  first_layer_height: { label: 'First layer height (mm)', initial: 0.2 },
  perimeters: { label: 'Wall count', initial: 2 },
  top_solid_layers: { label: 'Top solid layers', initial: 5 },
  bottom_solid_layers: { label: 'Bottom solid layers', initial: 4 },
  fill_density: { label: 'Infill percentage', initial: '20%' },
  fill_pattern: { label: 'Infill pattern', initial: 'gyroid' },
  support_material: { label: 'Generate supports', initial: false },
  brim_width: { label: 'Brim width (mm)', initial: 0 },
  cooling: { label: 'Automatic cooling', initial: true },
  exposure_time: { label: 'Exposure time (seconds)', initial: 2.5 },
  initial_exposure_time: { label: 'Bottom exposure time (seconds)', initial: 25 },
};
const title = (key: string): string => SETTINGS[key]?.label ?? key.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export function ProfileSettings({ value, onChange, disabled }: { value: Record<string, SettingValue>; onChange: (next: Record<string, SettingValue>) => void; disabled?: boolean }): JSX.Element {
  const [add, setAdd] = useState<string>();
  const set = (key: string, item: SettingValue): void => onChange({ ...value, [key]: item });
  const points = typeof value.bed_shape === 'string' ? value.bed_shape.split(',').map((p) => p.split('x').map(Number)) : [];
  const rectangle = points.length === 4 && points.every((p) => p.length === 2 && p.every(Number.isFinite)) && points[0]?.[0] === 0 && points[0]?.[1] === 0 && points[1]?.[1] === 0 && points[3]?.[0] === 0 && points[1]?.[0] === points[2]?.[0] && points[2]?.[1] === points[3]?.[1];
  return <fieldset disabled={disabled} className="flex flex-col gap-3">
    {rectangle ? <div className="grid grid-cols-2 gap-2">{['Width', 'Depth'].map((name, i) => <label key={name} className="flex flex-col gap-1">Bed {name.toLowerCase()} (mm)<NumberInput aria-label={`Bed ${name.toLowerCase()} (mm)`} value={points[2]![i]!} min={1} onChange={(n) => { if (n !== null) { const width = i === 0 ? n : points[2]![0]!; const depth = i === 1 ? n : points[2]![1]!; set('bed_shape', `0x0,${width}x0,${width}x${depth},0x${depth}`); } }} /></label>)}</div> : null}
    <div className="grid grid-cols-2 gap-2">{Object.entries(value).filter(([key]) => !(key === 'bed_shape' && rectangle) && !key.includes('gcode')).map(([key, item]) => <div key={key} className="flex flex-col gap-1 text-xs">
      {typeof item === 'boolean' ? null : <span>{title(key)}</span>}{typeof item === 'boolean' ? <Checkbox label={title(key)} checked={item} onCheckedChange={(v) => set(key, v)} /> : typeof item === 'number' ? <NumberInput aria-label={title(key)} value={item} onChange={(v) => { if (v !== null) set(key, v); }} /> : <Input aria-label={title(key)} value={item} onChange={(e) => set(key, e.target.value)} />}
    </div>)}</div>
    <div className="flex gap-2"><Select aria-label="Setting to add" placeholder="Add a setting…" value={add} onValueChange={setAdd} options={Object.entries(SETTINGS).filter(([key]) => value[key] === undefined).map(([key, setting]) => ({ value: key, label: setting.label }))} /><Button size="xs" disabled={!add} onClick={() => { if (add) { set(add, SETTINGS[add]!.initial); setAdd(undefined); } }}>Add setting</Button></div>
  </fieldset>;
}
