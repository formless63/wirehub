/** Field editors patch the same JSON draft used by advanced editing; unshown fields survive. */
import { useState, type JSX } from 'react';
import { signalKinds, type ConditioningRecipe, type Db, type DevicePort, type DeviceProfile, type PinBinding, type PinOffer, type RecipePart, type RecipeSignal } from '@wirehub/model';
import { Button, DataTable, Input, Select } from '@wirehub/editor-react';

const inputClass = 'rounded border border-line bg-panel px-1 py-1';
const buttonClass = 'underline';
const vocab = (db: Db, list: string): { id: string; label: string }[] => db.vocab?.[list]?.entries ?? [];
const patch = <T extends object>(record: T, key: string, value: string): T => {
  const next = { ...record } as Record<string, unknown>;
  if (value === '') delete next[key];
  else next[key] = value;
  return next as T;
};
const nextId = (prefix: string, ids: string[]): string => {
  let n = 1;
  while (ids.includes(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
};

function Text({ label, value, onChange }: { label: string; value?: string; onChange: (value: string) => void }): JSX.Element {
  return <label className="flex flex-col gap-1"><span className="text-faint">{label}</span><Input className={inputClass} aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Choice({ label, value, options, empty = 'Not stated', onChange }: { label: string; value?: string; options: { id: string; label: string }[]; empty?: string; onChange: (value: string) => void }): JSX.Element {
  const NONE = '__none__';
  const all = [{ value: NONE, label: empty }, ...(value && !options.some((o) => o.id === value) ? [{ value, label: 'Unavailable choice' }] : []), ...options.map((o) => ({ value: o.id, label: o.label }))];
  return <label className="flex flex-col gap-1"><span className="text-faint">{label}</span><Select aria-label={label} value={value === undefined || value === '' ? NONE : value} options={all} onValueChange={(v) => onChange(v === NONE ? '' : v)} /></label>;
}
const words = (ids: readonly string[]) => ids.map((id) => ({ id, label: id }));

function PortForm({ port, index, db, onChange, onRemove }: { port: DevicePort; index: number; db: Db; onChange: (port: DevicePort) => void; onRemove: () => void }): JSX.Element {
  const prefix = `Port ${index + 1}`;
  const iface = db.interfaces?.find((i) => i.id === port.interface);
  const positions = [...new Set([...Object.keys(iface?.pins ?? {}), ...Object.keys(port.pins ?? {})])];
  const [newPosition, setNewPosition] = useState('');
  const setPin = (position: string, binding: PinBinding | undefined): void => {
    const pins = { ...port.pins };
    if (binding === undefined) delete pins[position];
    else pins[position] = binding;
    onChange({ ...port, pins });
  };
  return <fieldset className="my-2 rounded border border-line p-2">
    <legend>{prefix}</legend>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">

      <Text label={`${prefix} label`} value={port.label} onChange={(v) => onChange(patch(port, 'label', v))} />
      <Choice label={`${prefix} interface`} value={port.interface} options={db.interfaces ?? []} onChange={(v) => onChange(patch(port, 'interface', v))} />
      <Choice label={`${prefix} body`} value={port.body} options={db.bodies ?? []} onChange={(v) => onChange(patch(port, 'body', v))} />
      <Choice label={`${prefix} gender`} value={port.gender} options={vocab(db, 'genders')} onChange={(v) => onChange(patch(port, 'gender', v))} />
      <Choice label={`${prefix} role`} value={port.role} options={words(['source', 'sink', 'both'])} onChange={(v) => onChange(patch(port, 'role', v))} />
    </div>
    <p className="my-2 text-faint">Pins inherit the interface. Editing a cell adds an override; Reset restores inheritance. Add any cable requirements below.</p>
    <DataTable
      label={`${prefix} pins`}
      className="cs-ui-dt-inline"
      noColumnMenu
      rows={positions.map((position) => ({ position }))}
      getRowId={(r) => r.position}
      columns={[
        { id: 'position', header: 'Position', width: 70, cell: (r) => r.position },
        { id: 'signal', header: 'Signal', width: 170, cell: (r) => {
          const binding = port.pins?.[r.position];
          const declared = iface?.pins[r.position]?.signal;
          const inherited = typeof declared === 'string' ? declared : undefined;
          const offer = binding === 'nc' ? undefined : binding;
          const base: PinOffer = offer ?? { signal: inherited ?? '' };
          return <Choice label={`${prefix} pin ${r.position} signal`} value={binding === 'nc' ? '__nc__' : offer?.signal} empty={`Inherited${inherited ? ` (${vocab(db, 'signals').find((s) => s.id === inherited)?.label ?? 'signal'})` : ''}`} options={[{ id: '__nc__', label: 'Unconnected' }, ...vocab(db, 'signals')]} onChange={(signal) => setPin(r.position, signal === '' ? undefined : signal === '__nc__' ? 'nc' : { ...base, signal })} />;
        } },
        { id: 'dir', header: 'Direction', width: 130, cell: (r) => {
          const binding = port.pins?.[r.position];
          const offer = binding === 'nc' ? undefined : binding;
          const base: PinOffer = offer ?? { signal: (typeof iface?.pins[r.position]?.signal === 'string' ? iface.pins[r.position]!.signal as string : '') };
          return binding === 'nc' ? '—' : <Choice label={`${prefix} pin ${r.position} direction`} value={offer?.dir} options={words(['out', 'in', 'bidir', 'passive'])} onChange={(v) => setPin(r.position, patch(base, 'dir', v))} />;
        } },
        { id: 'level', header: 'Level', width: 130, cell: (r) => {
          const binding = port.pins?.[r.position];
          const offer = binding === 'nc' ? undefined : binding;
          const base: PinOffer = offer ?? { signal: (typeof iface?.pins[r.position]?.signal === 'string' ? iface.pins[r.position]!.signal as string : '') };
          return binding === 'nc' ? '—' : <Choice label={`${prefix} pin ${r.position} level`} value={offer?.level} options={vocab(db, 'levels')} onChange={(v) => setPin(r.position, patch(base, 'level', v))} />;
        } },
        { id: 'needs', header: 'Needs', width: 220, cell: (r) => {
          const binding = port.pins?.[r.position];
          const offer = binding === 'nc' ? undefined : binding;
          const base: PinOffer = offer ?? { signal: (typeof iface?.pins[r.position]?.signal === 'string' ? iface.pins[r.position]!.signal as string : '') };
          const name = `${prefix} pin ${r.position}`;
          return <>{binding === 'nc' ? '—' : <Choice label={`${name} add conditioning`} options={vocab(db, 'conditioning')} empty={offer?.needs?.map((n) => vocab(db, 'conditioning').find((v) => v.id === n)?.label ?? 'Unavailable requirement').join(', ') || 'None'} onChange={(v) => { if (v) setPin(r.position, { ...base, needs: [...new Set([...(base.needs ?? []), v])] }); }} />}{offer?.needs?.map((need) => <Button type="button" key={need} variant="ghost" size="xs" className="mr-1" aria-label={`${name} remove ${need}`} onClick={() => setPin(r.position, { ...base, needs: base.needs?.filter((n) => n !== need) })}>{vocab(db, 'conditioning').find((v) => v.id === need)?.label ?? 'Unavailable requirement'} ×</Button>)}</>;
        } },
        { id: 'details', header: 'Pin details', width: 240, cell: (r) => {
          const binding = port.pins?.[r.position];
          if (binding === 'nc') return '—';
          const base: PinOffer = binding ?? { signal: typeof iface?.pins[r.position]?.signal === 'string' ? iface.pins[r.position]!.signal as string : '' };
          const name = `${prefix} pin ${r.position}`;
          return <details><summary>Details</summary><Many label={`${name} accepted levels`} values={base.accepts ?? []} options={vocab(db, 'levels')} onChange={(accepts) => setPin(r.position, { ...base, accepts })} /><Choice label={`${name} confidence`} value={base.confidence} options={[{ id: 'net-verified', label: 'Verified against the netlist' }, { id: 'documented', label: 'Documented' }, { id: 'inferred', label: 'Inferred' }, { id: 'unknown', label: 'Unknown' }]} onChange={(v) => setPin(r.position, patch(base, 'confidence', v))} /><Text label={`${name} note`} value={base.note} onChange={(v) => setPin(r.position, patch(base, 'note', v))} /><Text label={`${name} source`} value={base.src} onChange={(v) => setPin(r.position, patch(base, 'src', v))} /></details>;
        } },
        { id: 'reset', header: 'Reset', hideHeader: true, fixed: true, width: 70, cell: (r) => <Button type="button" className={buttonClass} disabled={port.pins?.[r.position] === undefined} onClick={() => setPin(r.position, undefined)}>Reset</Button> },
      ]}
    />
    <div className="mt-2 grid grid-cols-2 gap-2"><Text label={`${prefix} board terminal prefix`} value={port.terminals} onChange={(v) => onChange(patch(port, 'terminals', v))} /><Text label={`${prefix} note`} value={port.note} onChange={(v) => onChange(patch(port, 'note', v))} /></div>
    <fieldset className="my-2 rounded border border-line p-2"><legend>Cable requirements</legend>
      {(port.requires ?? []).map((r, at) => {
        const change = (next: typeof r): void => onChange({ ...port, requires: port.requires!.map((x, i) => i === at ? next : x) });
        return <div key={r.id} className="my-2 grid grid-cols-2 gap-2"><Choice label={`${prefix} requirement ${at + 1}`} value={r.conditioning} options={vocab(db, 'conditioning')} onChange={(conditioning) => change({ ...r, conditioning })} /><Many label={`${prefix} requirement ${at + 1} pins`} values={r.positions} options={positions.map((p) => ({ id: p, label: `Pin ${p}` }))} onChange={(positions) => change({ ...r, positions })} /><Text label={`${prefix} requirement ${at + 1} explanation`} value={r.text} onChange={(v) => change(patch(r, 'text', v))} /><Text label={`${prefix} requirement ${at + 1} source`} value={r.src} onChange={(src) => change({ ...r, src })} /><Button size="xs" onClick={() => onChange({ ...port, requires: port.requires!.filter((_, i) => i !== at) })}>Remove requirement</Button></div>;
      })}
      <Button size="xs" onClick={() => onChange({ ...port, requires: [...(port.requires ?? []), { id: nextId('requirement', (port.requires ?? []).map((r) => r.id)), conditioning: '', positions: [], src: '' }] })}>Add requirement</Button>
    </fieldset>
    <div className="mt-2 flex items-end gap-2">
      <Text label={`${prefix} new position`} value={newPosition} onChange={setNewPosition} />
      <Button type="button" className={buttonClass} disabled={!newPosition.trim() || positions.includes(newPosition.trim())} onClick={() => { setPin(newPosition.trim(), { signal: '' }); setNewPosition(''); }}>Add pin</Button>
      <Button type="button" className={buttonClass} onClick={onRemove}>Remove {prefix.toLowerCase()}</Button>
    </div>
  </fieldset>;
}

export function DeviceForm({ record, db, onChange }: { record: DeviceProfile; db: Db; onChange: (record: DeviceProfile) => void }): JSX.Element {
  return <div data-testid="device-fields">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">

      <Text label="Device label" value={record.label} onChange={(label) => onChange({ ...record, label })} />
      <Text label="Manufacturer" value={record.manufacturer} onChange={(v) => onChange(patch(record, 'manufacturer', v))} />
      <Text label="Model" value={record.model} onChange={(v) => onChange(patch(record, 'model', v))} />
      <Text label="Device note" value={record.note} onChange={(v) => onChange(patch(record, 'note', v))} />
      <Choice label="Device status" value={record.status ?? 'active'} options={[{ id: 'active', label: 'Active' }, { id: 'development', label: 'In development' }, { id: 'legacy', label: 'Legacy' }, { id: 'retired', label: 'Retired' }]} onChange={(v) => onChange(patch(record, 'status', v))} />
      <Text label="Device kind" value={record.kind} onChange={(v) => onChange(patch(record, 'kind', v))} />
      <Choice label="Parent device" value={record.extends} options={(db.devices ?? []).filter((d) => d.id !== record.id)} onChange={(v) => onChange(patch(record, 'extends', v))} />
      <Choice label="Adapter board" value={record.board} options={db.pcbas} onChange={(v) => onChange(patch(record, 'board', v))} />
      <Text label="Device source" value={record.src} onChange={(src) => onChange({ ...record, src })} />
    </div>
    {record.ports.map((port, index) => <PortForm key={index} port={port} index={index} db={db} onChange={(p) => onChange({ ...record, ports: record.ports.map((old, i) => i === index ? p : old) })} onRemove={() => onChange({ ...record, ports: record.ports.filter((_, i) => i !== index) })} />)}
    <Button type="button" className={buttonClass} onClick={() => onChange({ ...record, ports: [...record.ports, { id: nextId('port', record.ports.map((p) => p.id)), pins: {} }] })}>Add port</Button>
  </div>;
}

function RecipeSignalForm({ label, value, db, onChange }: { label: string; value?: RecipeSignal; db: Db; onChange: (value: RecipeSignal) => void }): JSX.Element {
  return <fieldset className="rounded border border-line p-2"><legend>{label}</legend><div className="grid grid-cols-3 gap-2">
    <Choice label={`${label} signal`} value={value?.signal} options={vocab(db, 'signals')} onChange={(v) => onChange(patch(value ?? {}, 'signal', v))} />
    <Choice label={`${label} signal kind`} value={value?.kind} options={words(signalKinds(db.vocab))} onChange={(v) => onChange(patch(value ?? {}, 'kind', v))} />
    <Choice label={`${label} level`} value={value?.level} options={vocab(db, 'levels')} onChange={(v) => onChange(patch(value ?? {}, 'level', v))} />
  </div></fieldset>;
}

export function RecipeForm({ record, db, onChange }: { record: ConditioningRecipe; db: Db; onChange: (record: ConditioningRecipe) => void }): JSX.Element {
  const setPart = (index: number, part: RecipePart): void => onChange({ ...record, parts: record.parts.map((p, i) => i === index ? part : p) });
  return <div className="flex flex-col gap-2" data-testid="recipe-fields">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">

      <Text label="Recipe label" value={record.label} onChange={(label) => onChange({ ...record, label })} />
      <Choice label="Conditioning" value={record.conditioning} options={vocab(db, 'conditioning')} onChange={(conditioning) => onChange({ ...record, conditioning })} />
      <Choice label="Recipe location" value={record.location} options={vocab(db, 'locations')} onChange={(v) => onChange(patch(record, 'location', v))} />
      <Text label="Recipe source" value={record.src} onChange={(src) => onChange({ ...record, src })} />
      <label className="flex items-center gap-1"><input type="checkbox" checked={record.bidirectional === true} onChange={(e) => onChange({ ...record, bidirectional: e.target.checked })} />Bidirectional</label>
    </div>
    {(['from', 'to'] as const).map((side) => <RecipeSignalForm key={side} label={side === 'from' ? 'Input' : 'Output'} value={record[side]} db={db} onChange={(value) => { const next = { ...record }; if (Object.keys(value).length === 0) delete next[side]; else next[side] = value; onChange(next); }} />)}
    {record.parts.map((part, index) => <fieldset key={index} className="rounded border border-line p-2"><legend>Part {index + 1}</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Choice label={`Part ${index + 1} component`} value={part.component} options={db.components} empty="Match kind and value" onChange={(v) => setPart(index, patch(part, 'component', v))} />
      <Choice label={`Part ${index + 1} kind`} value={part.kind} options={vocab(db, 'component-kinds')} onChange={(v) => setPart(index, patch(part, 'kind', v))} />
      <Text label={`Part ${index + 1} value`} value={part.value} onChange={(v) => setPart(index, patch(part, 'value', v))} />
      <Text label={`Part ${index + 1} note`} value={part.note} onChange={(v) => setPart(index, patch(part, 'note', v))} />
      <Choice label={`Part ${index + 1} placement`} value={part.placement} options={words(['series', 'shunt', 'across'])} onChange={(v) => setPart(index, patch(part, 'placement', v))} />
    </div><Button type="button" className={buttonClass} onClick={() => onChange({ ...record, parts: record.parts.filter((_, i) => i !== index) })}>Remove part {index + 1}</Button></fieldset>)}
    <Button type="button" className={buttonClass} onClick={() => onChange({ ...record, parts: [...record.parts, { placement: 'series' }] })}>Add part</Button>
  </div>;
}

/** Malformed advanced drafts remain editable as JSON rather than crashing the forms. */
export function canEditFields(list: string, record: Record<string, unknown>): boolean {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const strings = (v: Record<string, unknown>, keys: string[]): boolean => keys.every((key) => v[key] === undefined || typeof v[key] === 'string');
  if (!strings(record, ['id', 'label', 'src', 'kind', 'extends', 'board', 'conditioning', 'location', 'manufacturer', 'model', 'note', 'status'])) return false;
  if (list === 'devices') return Array.isArray(record.ports) && record.ports.every((p) => object(p) && strings(p, ['id', 'label', 'interface', 'body', 'gender', 'role', 'terminals', 'note']) && (p.requires === undefined || (Array.isArray(p.requires) && p.requires.every((r) => object(r) && strings(r, ['id', 'conditioning', 'text', 'src']) && Array.isArray(r.positions) && r.positions.every((v) => typeof v === 'string')))) && (p.pins === undefined || (object(p.pins) && Object.values(p.pins).every((v) => v === 'nc' || (object(v) && strings(v, ['signal', 'dir', 'level', 'confidence', 'note', 'src']) && (v.accepts === undefined || (Array.isArray(v.accepts) && v.accepts.every((a) => typeof a === 'string'))) && (v.needs === undefined || (Array.isArray(v.needs) && v.needs.every((n) => typeof n === 'string'))))))));
  if (list === 'hazards') return object(record.a) && object(record.b) && [record.a, record.b].every((pattern) => Object.values(pattern).every((v) => Array.isArray(v) && v.every((entry) => typeof entry === 'string'))) && strings(record, ['id', 'label', 'src', 'text', 'severity']);
  if (list === 'recipes') return Array.isArray(record.parts) && record.parts.every((p) => object(p) && strings(p, ['component', 'kind', 'value', 'placement'])) && (record.from === undefined || (object(record.from) && strings(record.from, ['signal', 'kind', 'level']))) && (record.to === undefined || (object(record.to) && strings(record.to, ['signal', 'kind', 'level'])));
  return false;
}

export const RANK_LABELS: Record<string, string> = { missing: 'Fewest missing pieces', hazards: 'Fewest warnings', unverified: 'Most confirmed facts', boards: 'Fewest adapter boards', 'prefer-boards': 'Prefer adapter boards', parts: 'Fewest components', conductors: 'Fewest conductors', straight: 'Prefer straight connections' };
function Many({ label, values, options, onChange }: { label: string; values: string[]; options: { id: string; label: string }[]; onChange: (values: string[]) => void }): JSX.Element {
  return <div className="flex flex-col gap-1"><Choice label={label} options={options.filter((o) => !values.includes(o.id))} empty="Add…" onChange={(v) => v && onChange([...values, v])} /><div className="flex flex-wrap gap-1">{values.map((v) => <Button key={v} size="xs" variant="ghost" onClick={() => onChange(values.filter((x) => x !== v))}>{options.find((o) => o.id === v)?.label ?? 'Unavailable choice'} ×</Button>)}</div></div>;
}
export function HazardForm({ record, db, onChange }: { record: import('@wirehub/model').HazardRule; db: Db; onChange: (record: import('@wirehub/model').HazardRule) => void }): JSX.Element {
  return <div className="flex flex-col gap-2" data-testid="hazard-fields"><div className="grid grid-cols-2 gap-2">
    <Text label="Hazard name" value={record.label} onChange={(label) => onChange({ ...record, label })} />
    <Choice label="Hazard response" value={record.severity} options={[{ id: 'reject', label: 'Reject the connection' }, { id: 'warning', label: 'Warn and allow' }]} onChange={(v) => onChange({ ...record, severity: v === 'reject' ? 'reject' : 'warning' })} />
    <Text label="Explanation" value={record.text} onChange={(text) => onChange({ ...record, text })} />
    <Text label="Hazard source" value={record.src} onChange={(src) => onChange({ ...record, src })} />
    <Choice label="Relationship" value={record.relation} options={[{ id: 'same-signal', label: 'Same signal' }, { id: 'different-signal', label: 'Different signals' }, { id: 'different-level', label: 'Different levels' }]} empty="Any relationship" onChange={(v) => onChange(patch(record, 'relation', v))} />
    <label><input type="checkbox" checked={record.enabled !== false} onChange={(e) => onChange({ ...record, enabled: e.target.checked })} /> Enabled</label>
  </div>{(['a', 'b'] as const).map((side, i) => <fieldset key={side} className="grid grid-cols-2 gap-2 rounded border border-line p-2"><legend>Connection side {i + 1}</legend>
    {(['kinds', 'notKinds', 'signals', 'notSignals', 'dirs', 'levels'] as const).map((key) => <Many key={key} label={`Side ${i + 1} ${{ kinds: 'signal types', notKinds: 'excluded types', signals: 'signals', notSignals: 'excluded signals', dirs: 'directions', levels: 'levels' }[key]}`} values={record[side][key] ?? []} options={key === 'kinds' || key === 'notKinds' ? words(signalKinds(db.vocab)) : key === 'dirs' ? [{ id: 'in', label: 'Input' }, { id: 'out', label: 'Output' }, { id: 'bidir', label: 'Bidirectional' }, { id: 'passive', label: 'Passive' }] : vocab(db, key === 'levels' ? 'levels' : 'signals')} onChange={(values) => { const pattern = { ...record[side] }; if (values.length === 0) delete pattern[key]; else Object.assign(pattern, { [key]: values }); onChange({ ...record, [side]: pattern }); }} />)}
  </fieldset>)}</div>;
}
export function RankingForm({ record, onChange }: { record: import('@wirehub/model').ResolverPolicy; onChange: (record: import('@wirehub/model').ResolverPolicy) => void }): JSX.Element {
  const order = record.order;
  const move = (index: number, by: number): void => { const next = [...order]; [next[index], next[index + by]] = [next[index + by]!, next[index]!]; onChange({ ...record, order: next }); };
  return <div className="flex flex-col gap-2" data-testid="ranking-fields"><p>First priority at the top.</p>
    {order.map((item, i) => <div key={`${item}-${i}`} className="flex items-center gap-2"><span className="grow">{RANK_LABELS[item]}</span><Button size="xs" disabled={i === 0} aria-label={`Move ${RANK_LABELS[item]} up`} onClick={() => move(i, -1)}>Up</Button><Button size="xs" disabled={i === order.length - 1} aria-label={`Move ${RANK_LABELS[item]} down`} onClick={() => move(i, 1)}>Down</Button><Button size="xs" aria-label={`Remove ${RANK_LABELS[item]}`} onClick={() => onChange({ ...record, order: order.filter((_, n) => n !== i) })}>Remove</Button></div>)}
    <Choice label="Add priority" options={Object.entries(RANK_LABELS).filter(([id]) => !order.includes(id as typeof order[number])).map(([id, label]) => ({ id, label }))} onChange={(v) => { if (v) onChange({ ...record, order: [...order, v as typeof order[number]] }); }} />
    <Text label="Maximum suggestions" value={String(record.maxOptions ?? 12)} onChange={(v) => { if (/^\d+$/.test(v)) onChange({ ...record, maxOptions: Number(v) }); }} />
    <Choice label="Screen connection" value={record.screens ?? 'both'} options={[{ id: 'both', label: 'Both ends' }, { id: 'source', label: 'Source end only' }]} onChange={(v) => onChange({ ...record, screens: v === 'source' ? 'source' : 'both' })} />
    <Text label="Ranking source" value={record.src} onChange={(src) => onChange({ ...record, src })} />
  </div>;
}
