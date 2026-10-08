/**
 * The engineering half of `/settings` (`server/settings.ts`): the continuity
 * test defaults (a hub-wide fallback under each design's own; a parameter the
 * `WIREHUB_TEST_DEFAULTS` variable sets wins, shown "set by the server"), the thresholds of the electrical rules, and
 * release approvals. One form, one save; an empty field means "not set".
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TEST_PARAMETER_KEYS, TEST_PARAMETER_LABELS, DEFAULT_TEST_PARAMETERS } from '@wirehub/docs';
import { useEffect, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { engineeringKey, engineeringQuery, saveEngineering, type EngineeringView } from '../settings.browser.ts';
import { useStudio } from '../studio-context.tsx';

interface Draft {
  test: Record<string, string>;
  rules: { enabled: boolean; ampacityDerate: string; contactDerate: string; maxDropV: string; maxDropPct: string };
  approvals: { enabled: boolean; editors: boolean };
  costing: { currency: string; labourRatePerHour: string };
}

const text = (n: number | undefined): string => (n === undefined ? '' : String(n));

const draftOf = (view: EngineeringView | undefined): Draft => ({
  test: Object.fromEntries(TEST_PARAMETER_KEYS.map((k) => [k, text(view?.testDefaults?.[k])])),
  rules: {
    enabled: view?.electrical?.enabled !== false,
    ampacityDerate: text(view?.electrical?.ampacityDerate),
    contactDerate: text(view?.electrical?.contactDerate),
    maxDropV: text(view?.electrical?.maxDropV),
    maxDropPct: text(view?.electrical?.maxDropPct),
  },
  approvals: { enabled: view?.approvals?.enabled === true, editors: view?.approvals?.approverRoles?.includes('editor') === true },
  costing: { currency: view?.costing?.currency ?? '', labourRatePerHour: text(view?.costing?.labourRatePerHour) },
});

function numbers(fields: Record<string, string>): { value: Record<string, number>; bad?: string } {
  const value: Record<string, number> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (raw.trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { value, bad: key };
    value[key] = n;
  }
  return { value };
}

export function EngineeringSettings(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(engineeringQuery);
  const [draft, setDraft] = useState<Draft>(draftOf(undefined));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data !== undefined) setDraft(draftOf(query.data));
  }, [query.data]);

  const save = async (): Promise<void> => {
    if (query.data === undefined) return;
    // a parameter the server sets is left out: the server keeps what was saved for it
    const test = numbers(Object.fromEntries(Object.entries(draft.test).filter(([k]) => query.data?.env?.testDefaults?.[k] === undefined)));
    const rules = numbers({ ampacityDerate: draft.rules.ampacityDerate, contactDerate: draft.rules.contactDerate, maxDropV: draft.rules.maxDropV, maxDropPct: draft.rules.maxDropPct });
    const bad = test.bad ?? rules.bad;
    if (bad !== undefined) {
      toast.error(`${bad} must be a positive number or empty.`);
      return;
    }
    const currency = draft.costing.currency.trim().toUpperCase();
    if (currency !== '' && !/^[A-Z]{3}$/.test(currency)) {
      toast.error('The currency is a three-letter code such as USD or EUR.');
      return;
    }
    const rateText = draft.costing.labourRatePerHour.trim();
    if (rateText !== '' && !(Number.isFinite(Number(rateText)) && Number(rateText) >= 0)) {
      toast.error('The labour rate must be a number, zero or more.');
      return;
    }
    setBusy(true);
    const out = await saveEngineering(
      {
        ...(currency === '' && rateText === '' ? {} : { costing: { ...(currency === '' ? {} : { currency }), ...(rateText === '' ? {} : { labourRatePerHour: Number(rateText) }) } }),
        ...(Object.keys(test.value).length === 0 ? {} : { testDefaults: test.value }),
        electrical: { ...(draft.rules.enabled ? {} : { enabled: false }), ...rules.value },
        approvals: { enabled: draft.approvals.enabled, ...(draft.approvals.editors ? { approverRoles: ['owner', 'editor'] as const } : {}) } as never,
      },
      query.data.etag,
    );
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    client.setQueryData(engineeringKey, out.value);
    toast.success('Saved.');
  };

  const built = query.data?.builtIn?.electrical;
  const fromEnv = query.data?.env?.testDefaults ?? undefined;
  const input = (label: string, value: string, set: (v: string) => void, placeholder?: string, locked = false): JSX.Element => (
    <label key={label} className="flex items-center justify-between gap-3">
      <span className="flex flex-wrap items-center gap-2">
        {label}
        {locked ? (
          <span className="rounded border border-line px-1 text-[11px] text-faint" title="The server sets this; it wins over Settings.">
            set by the server
          </span>
        ) : null}
      </span>
      <input className="w-28 shrink-0 rounded border border-line-field bg-panel px-2 py-1" aria-label={label} value={value} disabled={readOnly || locked} inputMode="decimal" placeholder={placeholder} onChange={(e) => set(e.target.value)} />
    </label>
  );

  if (query.data === undefined) return <div className="mt-6 text-faint">{query.isError ? '' : 'Loading…'}</div>;
  return (
    <form
      className="mt-8 flex max-w-xl flex-col gap-4 border-t border-line pt-4"
      data-testid="engineering-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-semibold">Testing</h2>
        <p className="text-faint">
          Default continuity test parameters for every design; a design's own values still win. Empty keeps the built-in value
          {fromEnv === undefined ? '' : '. A parameter the server sets wins and is read-only here'}.
        </p>
        {TEST_PARAMETER_KEYS.map((k) =>
          input(
            `${TEST_PARAMETER_LABELS[k].label} (${TEST_PARAMETER_LABELS[k].unit})`,
            fromEnv?.[k] === undefined ? (draft.test[k] ?? '') : String(fromEnv[k]),
            (v) => setDraft({ ...draft, test: { ...draft.test, [k]: v } }),
            String((DEFAULT_TEST_PARAMETERS as Record<string, number | undefined>)[k] ?? ''),
            fromEnv?.[k] !== undefined,
          ),
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-semibold">Electrical rules</h2>
        <p className="text-faint">Warnings on a design that declares currents: conductor gauge, contact rating, voltage drop. Nothing is checked where the current, area, length or rating is not declared.</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label="Electrical rules on" checked={draft.rules.enabled} disabled={readOnly} onChange={(e) => setDraft({ ...draft, rules: { ...draft.rules, enabled: e.target.checked } })} />
          <span>Check electrical rules</span>
        </label>
        {input('Largest voltage drop (V)', draft.rules.maxDropV, (v) => setDraft({ ...draft, rules: { ...draft.rules, maxDropV: v } }), String(built?.maxDropV ?? 0.5))}
        {input('Largest drop of a declared voltage (%)', draft.rules.maxDropPct, (v) => setDraft({ ...draft, rules: { ...draft.rules, maxDropPct: v } }), String(built?.maxDropPct ?? 5))}
        {input('Conductor ampacity derating (0 to 1)', draft.rules.ampacityDerate, (v) => setDraft({ ...draft, rules: { ...draft.rules, ampacityDerate: v } }), '1')}
        {input('Contact rating derating (0 to 1)', draft.rules.contactDerate, (v) => setDraft({ ...draft, rules: { ...draft.rules, contactDerate: v } }), '1')}
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-semibold">Costing</h2>
        <p className="text-faint">
          The currency prices are read in when a part's price names none, and the BOM total is printed in. The labour rate prices each design's labour minutes. A BOM shows cost only where parts are priced.
        </p>
        {input('Currency (ISO code)', draft.costing.currency, (v) => setDraft({ ...draft, costing: { ...draft.costing, currency: v } }), 'USD')}
        {input('Labour rate (per hour)', draft.costing.labourRatePerHour, (v) => setDraft({ ...draft, costing: { ...draft.costing, labourRatePerHour: v } }), '')}
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-semibold">Release approvals</h2>
        <p className="text-faint">When on, a saved version is submitted for approval and approved or rejected with a comment; the approved version is the released one, and documents say who approved it.</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label="Approvals on" checked={draft.approvals.enabled} disabled={readOnly} onChange={(e) => setDraft({ ...draft, approvals: { ...draft.approvals, enabled: e.target.checked } })} />
          <span>Require approval for releases</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label="Editors may approve" checked={draft.approvals.editors} disabled={readOnly || !draft.approvals.enabled} onChange={(e) => setDraft({ ...draft, approvals: { ...draft.approvals, editors: e.target.checked } })} />
          <span>Editors may approve (owners always can)</span>
        </label>
      </section>

      <div>
        <button type="submit" disabled={readOnly || busy} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
          {busy ? 'Saving…' : 'Save engineering settings'}
        </button>
      </div>
    </form>
  );
}
