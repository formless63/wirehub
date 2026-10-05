/**
 * The numbering scheme, as a setting (`server/pn-settings.ts`): the definition in force
 * as editable JSON, a "Check" that shows how it reads sample numbers and what it would
 * propose, a Save (owner or editor), and the schemes installed packs offer. Switching to
 * a pack's scheme is an owner's confirmation. Saving never rewrites an existing number.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { previewPnScheme, pnSettingsKey, pnSettingsQuery, savePnSettings, type PnPreview, type PnSchemeOffer } from '../settings.browser.ts';
import { useStudio } from '../studio-context.tsx';

/** the generic example (docs/part-numbers.md): <Level><Type>-NNNNNN-VV */
export const EXAMPLE_SCHEME = {
  type: 'declarative',
  id: 'level-type-seq',
  label: 'Level and type, sequence, variant',
  template: '{level}{type}-{seq}-{variant}',
  segments: [
    { id: 'level', type: 'choice', label: 'Level', values: [{ value: '1', label: 'Part', kinds: ['connector', 'wire', 'component', 'shell', 'fastener', 'mechanical-other'] }, { value: '2', label: 'Assembly', kinds: ['pcba', 'design', 'kit'] }] },
    { id: 'type', type: 'choice', label: 'Type', values: [{ value: 'C', label: 'Connector', kinds: ['connector', 'shell'] }, { value: 'W', label: 'Wire', kinds: ['wire'] }, { value: 'E', label: 'Component', kinds: ['component'] }, { value: 'H', label: 'Hardware', kinds: ['fastener', 'mechanical-other'] }, { value: 'B', label: 'Board', kinds: ['pcba'] }, { value: 'A', label: 'Cable assembly', kinds: ['design', 'kit'] }] },
    { id: 'seq', type: 'counter', label: 'Sequence', width: 6, per: ['level', 'type'], ranges: [{ from: 1, to: 999999 }] },
    { id: 'variant', type: 'variant', label: 'Variant', style: 'numeric', width: 2, first: '00', max: '99' },
  ],
  validation: { regex: '^[12][A-Z]-\\d{6}-\\d{2}$', message: 'must look like 1C-000001-00' },
  immutable: true,
  src: 'synthetic example',
} as const;

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

function shapeOf(scheme: unknown): string {
  const s = scheme as { template?: unknown; prefixes?: unknown };
  if (typeof s?.template === 'string') return s.template;
  return s?.prefixes === undefined ? 'unknown' : 'prefix + digits';
}

export function PartNumberSettings(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const isOwner = me?.role === undefined || me.role === 'owner';
  const query = useQuery(pnSettingsQuery);
  const view = query.data;
  const [text, setText] = useState('');
  const [samples, setSamples] = useState('');
  const [result, setResult] = useState<PnPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<{ offer: PnSchemeOffer; preview: PnPreview } | undefined>(undefined);
  useEffect(() => {
    if (view !== undefined) setText(pretty(view.config ?? view.defaults));
  }, [view]);

  const parse = (): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
      return undefined;
    }
  };

  const check = async (): Promise<void> => {
    const scheme = parse();
    if (scheme === undefined) return;
    setBusy(true);
    const out = await previewPnScheme({ scheme, samples: samples.split(/\s+/).filter((s) => s !== ''), suggest: ['connector', 'wire', 'design'].map((kind) => ({ kind })) });
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setResult(out.value);
  };

  const save = async (scheme: unknown): Promise<void> => {
    if (view === undefined) return;
    setBusy(true);
    const out = await savePnSettings({ scheme }, view.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    client.setQueryData(pnSettingsKey, out.value);
    void client.invalidateQueries({ queryKey: ['studio', 'partNumbers'] });
    toast.success('Saved. Existing numbers are untouched; new proposals follow this scheme.');
  };

  const review = async (offer: PnSchemeOffer): Promise<void> => {
    setBusy(true);
    const out = await previewPnScheme({ scheme: offer.scheme });
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setReviewing({ offer, preview: out.value });
  };

  const adopt = async (offer: PnSchemeOffer): Promise<void> => {
    if (view === undefined) return;
    setBusy(true);
    const out = await savePnSettings({ adoptFrom: offer.pack }, view.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    client.setQueryData(pnSettingsKey, out.value);
    void client.invalidateQueries({ queryKey: ['studio', 'partNumbers'] });
    setReviewing(undefined);
    toast.success(`Now numbering with the scheme from ${offer.pack}. Existing numbers are untouched.`);
  };

  return (
    <section className="mt-6 max-w-xl border-t border-line pt-3" data-testid="pn-settings">
      <h2 className="mb-1 text-[13px] font-semibold">Part numbers</h2>
      <p className="mb-2 text-faint">
        How this hub numbers parts and cables. A definition in plain JSON: fields with allowed values per record kind, zero-padded counters with ranges, a variant suffix, separators, a validation regex.
        Saving never rewrites an existing number. Exotic cases stay a code scheme in a module.
      </p>
      {view === undefined ? (
        <div className="text-faint">{query.isError ? 'The scheme could not be read.' : 'Loading…'}</div>
      ) : (
        <>
          <div data-testid="pn-in-force" className="mb-2">
            In force: <b>{view.effective.label}</b> ({view.effective.kind}
            {view.effective.shape === undefined ? '' : `, ${view.effective.shape}`}
            {view.effective.immutable ? ', existing numbers never change' : ''}).
            {view.overriddenByModule === true ? ' A module sets the scheme in code; this definition is ignored while it does.' : ''}
          </div>
          <label className="flex flex-col gap-0.5">
            <span className="font-medium">Definition</span>
            <textarea className="h-64 rounded border border-line bg-panel px-2 py-1 font-mono text-[11.5px]" aria-label="Scheme definition" value={text} disabled={readOnly} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          </label>
          <label className="mt-2 flex flex-col gap-0.5">
            <span className="font-medium">Sample numbers to check</span>
            <input className="rounded border border-line bg-panel px-2 py-1" aria-label="Sample numbers" placeholder="1C-000001-00  CON-00001" value={samples} onChange={(e) => setSamples(e.target.value)} />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="rounded border border-line px-3 py-1" disabled={busy} onClick={() => void check()}>
              Check
            </button>
            {readOnly ? null : (
              <>
                <button type="button" className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50" disabled={busy} onClick={() => { const s = parse(); if (s !== undefined) void save(s); }}>
                  Save
                </button>
                <button type="button" className="rounded border border-line px-3 py-1" disabled={busy} onClick={() => setText(pretty(EXAMPLE_SCHEME))}>
                  Insert the generic example
                </button>
                <button type="button" className="rounded border border-line px-3 py-1" disabled={busy || view.config === null} onClick={() => void save(null)}>
                  Back to the default
                </button>
              </>
            )}
          </div>
          {result === undefined ? null : (
            <div className="mt-2" data-testid="pn-check">
              {result.ok ? (
                <>
                  <div>
                    Reads as <code>{result.shape ?? '(no shape)'}</code>.
                  </div>
                  {(result.samples ?? []).map((s) => (
                    <div key={s.pn}>
                      <code>{s.pn}</code>: {s.canonical === null ? 'not one of this scheme’s numbers' : `ok (${s.canonical})`}
                      {s.issues.length > 0 ? ` — ${s.issues.map((i) => i.message).join('; ')}` : ''}
                    </div>
                  ))}
                  {(result.suggestions ?? []).map((s) => (
                    <div key={s.kind}>
                      A new {s.kind} would get <code>{s.suggestion?.pn ?? '(not numbered by this scheme)'}</code>
                    </div>
                  ))}
                  {result.impact === undefined ? null : (
                    <div className="text-faint">
                      Of {result.impact.numbered} numbers in use, {result.impact.notInScheme} do not fit this scheme (kept as they are), {result.impact.duplicates} are duplicates, {result.impact.unnumbered} parts have none.
                    </div>
                  )}
                </>
              ) : (
                <ul role="alert" className="text-err">
                  {(result.problems ?? []).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {view.offers.length === 0 ? null : (
            <div className="mt-3" data-testid="pn-offers">
              <h3 className="font-medium">Offered by installed packs</h3>
              {view.offers.map((o) => (
                <div key={o.pack} data-pack-offer={o.pack} className="my-1 border border-line p-2">
                  <b>{o.pack}</b> {o.version} offers <code>{shapeOf(o.scheme)}</code>. Installing a pack never switches the scheme.
                  {o.problems.length > 0 ? <div role="alert" className="text-err">It cannot be used: {o.problems[0]}</div> : null}
                  {readOnly || o.problems.length > 0 ? null : (
                    <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void review(o)}>
                      Review…
                    </button>
                  )}
                </div>
              ))}
              {reviewing === undefined ? null : (
                <div className="border border-warn p-2" data-testid="pn-adopt">
                  <div>
                    Switch to the scheme from <b>{reviewing.offer.pack}</b>? Of {reviewing.preview.impact?.numbered ?? 0} numbers in use, {reviewing.preview.impact?.notInScheme ?? 0} do not fit it; they are kept as they are, and the health page lists them.
                  </div>
                  {isOwner ? (
                    <button type="button" className="mt-1 rounded border border-line bg-accent px-3 py-1 text-accent-ink" disabled={busy} onClick={() => void adopt(reviewing.offer)}>
                      Confirm: switch the numbering scheme
                    </button>
                  ) : (
                    <div className="text-faint">An owner confirms this switch.</div>
                  )}
                  <button type="button" className="ml-2 underline" onClick={() => setReviewing(undefined)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
