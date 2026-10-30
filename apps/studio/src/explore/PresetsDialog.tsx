/**
 * The hub's enclosure presets for /explore: the built-in four plus the hub's own, one list on the
 * left and the chosen preset's values on the right. Changing a built-in keeps the hub's copy under
 * the same id (Reset drops it); Save writes the whole list (`PUT /api/explore/presets`).
 */

import { BUILT_IN_PRESETS, ENCLOSURE_DEFAULTS, type EnclosureParams, type EnclosurePreset } from '@wirehub/model';
import { Button, Checkbox, Dialog, Field, Input, NumberInput, SegmentedControl } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';

import { savePresets, type ExploreView } from '../explore.browser.ts';

const SRC = 'Hub settings (entered in the app)';
const NUMBERS: { key: keyof EnclosureParams & `${string}Mm`; label: string }[] = [
  { key: 'wallMm', label: 'Wall' },
  { key: 'floorMm', label: 'Floor' },
  { key: 'lidMm', label: 'Lid' },
  { key: 'clearanceMm', label: 'Side clearance' },
  { key: 'topClearanceMm', label: 'Top clearance' },
  { key: 'standoffMm', label: 'Standoff' },
  { key: 'cornerRadiusMm', label: 'Corner radius' },
];
const FLAGS: { key: 'lidScrews' | 'ventsLid' | 'ventsSides'; label: string }[] = [
  { key: 'lidScrews', label: 'Lid screws' },
  { key: 'ventsLid', label: 'Vents in lid' },
  { key: 'ventsSides', label: 'Vents in sides' },
];

const builtIn = (id: string): EnclosurePreset | undefined => BUILT_IN_PRESETS.find((p) => p.id === id);
const same = (a: EnclosurePreset, b: EnclosurePreset): boolean => JSON.stringify({ ...a, src: '' }) === JSON.stringify({ ...b, src: '' });
const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';

export function PresetsDialog({ view, onClose, onSaved }: { view: ExploreView; onClose: () => void; onSaved: (presets: ExploreView['presets'], etags: ExploreView['etags']) => void }): JSX.Element {
  const [list, setList] = useState<EnclosurePreset[]>(view.presets.inForce);
  const [at, setAt] = useState(list[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const preset = list.find((p) => p.id === at);

  const edit = (next: EnclosurePreset): void => setList((l) => l.map((p) => (p.id === next.id ? next : p)));
  const param = <K extends keyof EnclosureParams>(key: K, value: EnclosureParams[K] | undefined): void => {
    if (preset === undefined) return;
    const params = { ...preset.params };
    if (value === undefined) delete params[key];
    else params[key] = value;
    edit({ ...preset, params });
  };
  const outer = (axis: 'x' | 'y' | 'z', value: number | null): void => {
    if (preset === undefined) return;
    const max = { ...preset.maxOuterMm };
    if (value === null || value <= 0) delete max[axis];
    else max[axis] = value;
    const { maxOuterMm: _old, ...rest } = preset;
    edit(Object.keys(max).length === 0 ? rest : { ...rest, maxOuterMm: max });
  };
  const add = (): void => {
    let id = 'my-preset';
    for (let n = 2; list.some((p) => p.id === id); n += 1) id = `my-preset-${n}`;
    setList((l) => [...l, { id, label: 'My preset', params: {}, src: SRC }]);
    setAt(id);
  };
  const remove = (): void => {
    if (preset === undefined) return;
    const original = builtIn(preset.id);
    if (original !== undefined) edit(original);
    else {
      setList((l) => l.filter((p) => p.id !== preset.id));
      setAt(list.find((p) => p.id !== preset.id)?.id);
    }
  };
  const save = async (): Promise<void> => {
    // only what differs from a built-in is the hub's own; a new preset's id follows its label
    const taken = new Set(list.map((p) => p.id));
    const local = list
      .filter((p) => { const b = builtIn(p.id); return b === undefined || !same(b, p); })
      .map((p) => {
        let id = p.id;
        if (builtIn(p.id) === undefined && /^my-preset(-\d+)?$/.test(p.id) && slug(p.label) !== p.id) {
          id = slug(p.label);
          for (let n = 2; taken.has(id); n += 1) id = `${slug(p.label)}-${n}`;
          taken.add(id);
        }
        // a changed built-in is the hub's own values now
        return { ...p, id, label: p.label.trim(), src: p.src === builtIn(p.id)?.src ? SRC : p.src };
      });
    setBusy(true);
    const out = await savePresets(local, view.etags.presets);
    setBusy(false);
    if (!out.ok) return setError(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    onSaved(out.value.presets, out.value.etags);
    onClose();
  };

  const changed = preset !== undefined && builtIn(preset.id) !== undefined && !same(builtIn(preset.id)!, preset);
  const num = (key: keyof EnclosureParams): number | null => (typeof preset?.params[key] === 'number' ? (preset.params[key] as number) : null);
  const fallback = (key: keyof typeof ENCLOSURE_DEFAULTS): string => String(ENCLOSURE_DEFAULTS[key]);

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())} title="Enclosure presets" size="lg" testId="explore-presets"
      footer={<>{error === undefined ? null : <span role="alert" className="mr-auto text-xs text-err">{error}</span>}<Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="flex min-h-[22rem] gap-3 text-xs">
        <div className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line pr-2" role="listbox" aria-label="Presets">
          {list.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === at} onClick={() => setAt(p.id)}
              className={`truncate rounded px-1.5 py-1 text-left ${p.id === at ? 'bg-selected text-ink' : 'text-dim hover:bg-hover'}`}>
              {p.label}{builtIn(p.id) === undefined ? '' : <span className="text-faint">{same(builtIn(p.id)!, p) ? '' : ' •'}</span>}
            </button>
          ))}
          <Button size="xs" variant="ghost" className="mt-1 self-start" onClick={add}>+ New</Button>
        </div>
        {preset === undefined ? null : (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-end gap-2">
              <Field label="Name" className="flex-1"><Input value={preset.label} onChange={(e) => edit({ ...preset, label: e.target.value })} /></Field>
              {builtIn(preset.id) === undefined ? <Button size="xs" variant="ghost" onClick={remove}>Remove</Button> : changed ? <Button size="xs" variant="ghost" title="Back to the built-in values" onClick={remove}>Reset</Button> : null}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {NUMBERS.map((n) => (
                <Field key={n.key} label={n.label}>
                  <NumberInput aria-label={n.label} value={num(n.key)} placeholder={fallback(n.key as keyof typeof ENCLOSURE_DEFAULTS)} unit="mm" min={0} step={0.1} precision={2} onChange={(v) => param(n.key, v ?? undefined)} />
                </Field>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl aria-label="Lid" size="xs" value={preset.params.lid ?? 'flat'} onValueChange={(v) => param('lid', v === 'flat' ? undefined : (v as 'split'))}
                options={[{ value: 'flat', label: 'Flat lid' }, { value: 'split', label: 'Split shell' }]} />
              {FLAGS.map((f) => (
                <Checkbox key={f.key} label={f.label} checked={preset.params[f.key] ?? ENCLOSURE_DEFAULTS[f.key]} onCheckedChange={(on) => param(f.key, on === ENCLOSURE_DEFAULTS[f.key] ? undefined : on)} />
              ))}
            </div>
            <Field label="Must fit within" help="Outside limits, such as a printer bed or a box it goes in. A combination over one is invalid.">
              <div className="flex gap-2">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <NumberInput key={axis} aria-label={`Max ${axis.toUpperCase()}`} className="w-28" value={preset.maxOuterMm?.[axis] ?? null} placeholder={axis.toUpperCase()} unit="mm" min={0} step={1} onChange={(v) => outer(axis, v)} />
                ))}
              </div>
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
