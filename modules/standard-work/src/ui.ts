import { createElement as h, useEffect, useState } from 'react';
import type { PanelProps } from '@wirehub/modules';
import { adoptLabour, estimateWork, settingsOf, workCsv, workProblems } from './logic.ts';
import type { WorkOperation, WorkSettings } from './logic.ts';

function read(props: PanelProps): { settings: WorkSettings; error: string } {
  try { return { settings: props.design ? settingsOf(props.design) : { schema: 1, operations: [] }, error: '' }; }
  catch (cause) { return { settings: { schema: 1, operations: [] }, error: cause instanceof Error ? cause.message : 'Invalid saved operation times.' }; }
}
export function StandardWorkPanel(props: PanelProps) {
  const initial = read(props);
  const [settings, setSettings] = useState<WorkSettings>(initial.settings);
  const [builds, setBuilds] = useState(String(initial.settings.adoption?.builds ?? 1));
  const [error, setError] = useState(initial.error);
  const saved = JSON.stringify(props.design?.extensions?.['standard-work']);
  useEffect(() => { const value = read(props); setSettings(value.settings); setError(value.error); }, [props.design?.id, saved, props.readOnly]);
  useEffect(() => { setBuilds(String(read(props).settings.adoption?.builds ?? 1)); }, [props.design?.id, initial.settings.adoption?.builds]);
  const editable = props.design !== undefined && !props.readOnly && props.onChange !== undefined;
  const count = Number(builds);
  const problems = workProblems(settings);
  let estimate: ReturnType<typeof estimateWork> | undefined;
  let estimateError = '';
  try { estimate = estimateWork(settings, count); } catch (cause) { estimateError = cause instanceof Error ? cause.message : 'No valid estimate.'; }
  const update = (index: number, field: keyof WorkOperation, value: string | number) => setSettings(old => ({ ...old, operations: old.operations.map((row, i) => i === index ? { ...row, [field]: value } : row) }));
  const add = () => {
    let number = settings.operations.length + 1;
    while (settings.operations.some(row => row.id === `operation-${number}`)) number += 1;
    setSettings(old => ({ ...old, operations: [...old.operations, { id: `operation-${number}`, label: '', minutes: NaN, quantity: 1, basis: 'per-cable', src: '' }] }));
  };
  const download = () => {
    try {
      const body = workCsv(props.design!, props.db, settings, count);
      const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `${props.design!.id}-standard-work.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not derive the report.'); }
  };
  return h('section', { 'aria-label': 'Standard work' },
    h('p', null, 'Record measured or estimated times for explicit operations. Batch setup is allocated across the chosen build quantity; operation-table edits do not automatically replace saved labour.'),
    error ? h('p', { role: 'alert' }, error) : null,
    h('label', null, 'Labour build quantity', h('input', { value: builds, type: 'number', min: 1, step: 1, max: 1_000_000, onChange: (e: { target: { value: string } }) => setBuilds(e.target.value) })),
    ...settings.operations.map((row, index) => h('fieldset', { key: row.id, disabled: !editable },
      h('legend', null, `Operation ${index + 1}`),
      h('label', null, 'Operation name', h('input', { value: row.label, onChange: (e: { target: { value: string } }) => update(index, 'label', e.target.value) })),
      h('label', null, 'Minutes per operation', h('input', { value: Number.isFinite(row.minutes) ? row.minutes : '', type: 'number', min: 0, step: 'any', onChange: (e: { target: { value: string } }) => update(index, 'minutes', e.target.value === '' ? NaN : Number(e.target.value)) })),
      h('label', null, 'Operation count', h('input', { value: Number.isFinite(row.quantity) ? row.quantity : '', type: 'number', min: 0, step: 'any', onChange: (e: { target: { value: string } }) => update(index, 'quantity', e.target.value === '' ? NaN : Number(e.target.value)) })),
      h('label', null, 'Timing basis', h('select', { value: row.basis, onChange: (e: { target: { value: string } }) => update(index, 'basis', e.target.value) }, h('option', { value: 'per-cable' }, 'Per cable'), h('option', { value: 'per-batch' }, 'Per batch'))),
      h('label', null, 'Timing source', h('input', { value: row.src, onChange: (e: { target: { value: string } }) => update(index, 'src', e.target.value) })),
      h('button', { onClick: () => setSettings(old => ({ ...old, operations: old.operations.filter((_, i) => i !== index) })) }, 'Remove operation'),
    )),
    h('button', { disabled: !editable || settings.operations.length >= 500, onClick: add }, 'Add operation'),
    problems.length ? h('p', { role: 'alert' }, problems.join(' ')) : null,
    estimate === undefined ? h('p', null, estimateError) : h('p', null, `${estimate.perCableMinutes} min per cable + ${estimate.batchMinutes} min per batch; ${estimate.runMinutes} min for ${estimate.builds} cables; allocated ${estimate.allocatedPerCableMinutes} min per cable.`),
    h('p', null, `Saved labour: ${props.design?.labourMinutes === undefined ? 'not recorded' : `${props.design.labourMinutes} min per cable`}.`),
    h('button', { disabled: !editable || problems.length > 0, onClick: () => { if (editable && !problems.length) props.onChange?.({ ...props.design!, extensions: { ...props.design!.extensions, 'standard-work': settings } }, 'Save operation times'); } }, 'Save operation table'),
    h('button', { disabled: !editable || estimate === undefined, onClick: () => { if (editable && estimate) props.onChange?.(adoptLabour(props.design!, settings, count), 'Adopt operation labour estimate'); } }, 'Adopt labour estimate'),
    h('button', { disabled: props.design === undefined || estimate === undefined, onClick: download }, 'Download labour CSV'),
    h('p', null, 'Adoption updates the working design through normal undo and save. Re-adopt when batch quantity or timings change. Missing hourly rates leave labour unpriced.'),
  );
}
