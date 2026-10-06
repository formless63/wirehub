import { createElement as h, useEffect, useRef, useState } from 'react';
import type { PanelProps } from '@wirehub/modules';
import { convertAmount, costReportCsv, settingsOf, snapshotProblems } from './logic.ts';
import type { FxSettings, FxSnapshot } from './types.ts';

function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function FxPanel(props: PanelProps) {
  const stored = props.design === undefined ? undefined : settingsOf(props.design);
  const [snapshot, setSnapshot] = useState<FxSnapshot | undefined>(stored?.snapshot);
  const [target, setTarget] = useState(stored?.target ?? props.db.rules?.costing?.currency ?? 'USD');
  const [builds, setBuilds] = useState(String(stored?.builds ?? 1));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const identity = props.design?.id;
  const saved = JSON.stringify(props.design?.extensions?.['fx-rates']);
  useEffect(() => {
    generation.current += 1; setBusy(false); setError('');
    const current = props.design === undefined ? undefined : settingsOf(props.design);
    setSnapshot(current?.snapshot); setTarget(current?.target ?? props.db.rules?.costing?.currency ?? 'USD'); setBuilds(String(current?.builds ?? 1));
    return () => { generation.current += 1; };
  }, [identity, saved, props.readOnly]);
  const editable = props.design !== undefined && !props.readOnly && props.onChange !== undefined;
  const count = Number(builds);
  const valid = snapshot !== undefined && snapshotProblems(snapshot).length === 0 && /^[A-Z]{3}$/.test(target) && Number.isSafeInteger(count) && count > 0 && count <= 1_000_000 && convertAmount(1, snapshot.base, target, snapshot) !== undefined;
  const settings = (): FxSettings => ({ schema: 1, snapshot: snapshot!, target, builds: count });
  const refresh = async () => {
    const ticket = ++generation.current; setBusy(true); setError('');
    try {
      const out = await props.api('GET', 'latest');
      if (ticket !== generation.current) return;
      if (out.status !== 200) throw new Error('Could not retrieve reference rates. The saved snapshot is retained.');
      const next = (out.body as { snapshot?: unknown }).snapshot;
      const problems = snapshotProblems(next);
      if (problems.length) throw new Error(problems.join(' '));
      setSnapshot(next as FxSnapshot);
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : 'Could not retrieve reference rates.'); }
    finally { if (ticket === generation.current) setBusy(false); }
  };
  return h('section', { 'aria-label': 'FX rates' },
    h('p', null, 'Reference-rate costing uses an explicit dated snapshot. Save the selected snapshot with the design; refreshing does not change saved costs or revisions.'),
    props.design?.extensions?.['fx-rates'] !== undefined && stored === undefined ? h('p', { role: 'alert' }, 'The saved FX settings are invalid. Replace them with a valid snapshot before reporting.') : null,
    error ? h('p', { role: 'alert' }, error) : null,
    h('label', null, 'Report currency', h('input', { value: target, maxLength: 3, onChange: (e: { target: { value: string } }) => setTarget(e.target.value.toUpperCase()), disabled: !editable })),
    h('label', null, 'FX build quantity', h('input', { value: builds, type: 'number', min: 1, step: 1, max: 1_000_000, onChange: (e: { target: { value: string } }) => setBuilds(e.target.value) })),
    h('button', { disabled: !editable || busy, onClick: () => { void refresh(); } }, busy ? 'Retrieving rates…' : 'Retrieve reference rates'),
    snapshot === undefined ? h('p', null, 'No rate snapshot selected.') : h('div', null,
      h('p', null, `Rate date ${snapshot.date}; base ${snapshot.base}; retrieved ${snapshot.retrievedAt}. Source: ${snapshot.source}`),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'Currency'), h('th', null, `Units per ${snapshot.base}`))), h('tbody', null, ...Object.entries(snapshot.rates).sort(([a], [b]) => a.localeCompare(b)).map(([currency, rate]) => h('tr', { key: currency }, h('td', null, currency), h('td', null, String(rate))))))),
    h('button', { disabled: !editable || !valid || busy, onClick: () => { if (editable && valid) props.onChange?.({ ...props.design!, extensions: { ...props.design!.extensions, 'fx-rates': settings() } }, 'Save FX rate snapshot'); } }, 'Save FX snapshot'),
    h('button', { disabled: props.design === undefined || !valid || busy, onClick: () => { try { download(`${props.design!.id}-fx-costing.csv`, costReportCsv(props.design!, props.db, settings(), count)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not derive the report.'); } } }, 'Download FX costing CSV'),
    h('p', null, 'Missing rates or unidentified currencies remain excluded and listed in the report. These are reference estimates; fees and settlement rates are not included.'),
  );
}
