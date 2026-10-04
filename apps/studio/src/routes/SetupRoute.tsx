/**
 * `/setup` — first-run setup: pick the domain modules this hub works with.
 *
 * Each bundled domain module (`modules.config.ts`) is a checkbox with what it
 * adds; suggestions are pre-ticked, nothing is forced, and an empty choice is
 * a fine answer — the base works on its own. Enabling installs the module's
 * catalog pack into the catalog (`server/setup.ts`); a module already
 * enabled stays enabled. Domains the build has no module for yet are listed
 * underneath, so a person can see where they stand.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';

import { loadSetup, saveSetup, type SetupView } from '../setup.browser.ts';
import { StudioMark } from '../shell/Wordmark.tsx';

export function SetupRoute(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<SetupView | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadSetup().then((out) => {
      if (!live) return;
      if (!out.ok) {
        setProblem(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
        return;
      }
      setView(out.value);
      setPicked(new Set(out.value.domains.filter((d) => d.enabled || d.suggested).map((d) => d.id)));
    });
    return () => {
      live = false;
    };
  }, []);

  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    const out = await saveSetup([...picked]);
    setBusy(false);
    if (!out.ok) {
      setProblem(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
      return;
    }
    // the catalog changed underneath every cached query: refetch, then the cable list
    await queryClient.invalidateQueries();
    void navigate({ to: '/cables' });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 py-8">
        <header className="flex items-center gap-3">
          <StudioMark size={32} />
          <div>
            <h1 className="m-0 text-[18px] font-semibold text-ink">Set up WireHub</h1>
            <p className="m-0 text-[13px] text-dim">
              Pick the fields you build cables for. Each adds its signals, connectors and examples to the catalog. You can add
              more later from this page; nothing here is required.
            </p>
          </div>
        </header>

        {problem === undefined ? null : (
          <p role="alert" className="m-0 rounded border border-err px-3 py-2 text-[13px] text-err">
            {problem}
          </p>
        )}

        {view === undefined ? (
          problem === undefined ? <p className="text-[13px] text-dim">Loading…</p> : null
        ) : (
          <>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Domain modules</legend>
              {view.domains.length === 0 ? (
                <p className="text-[13px] text-dim">This build bundles no domain modules.</p>
              ) : (
                view.domains.map((domain) => (
                  <label
                    key={domain.id}
                    className="flex cursor-pointer items-start gap-3 rounded border border-line bg-panel px-3 py-2 hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={picked.has(domain.id)}
                      disabled={domain.enabled || busy}
                      onChange={() => toggle(domain.id)}
                      aria-describedby={`setup-${domain.id}`}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[13px] font-semibold text-ink">
                        {domain.label}
                        {domain.enabled ? <span className="ml-2 text-[11px] font-normal text-ok">enabled</span> : null}
                        {!domain.enabled && domain.suggested ? <span className="ml-2 text-[11px] font-normal text-faint">suggested</span> : null}
                      </span>
                      <span id={`setup-${domain.id}`} className="text-[12px] text-dim">
                        {domain.description}
                      </span>
                      <span className="text-[11px] text-faint">
                        {domain.packs.map((p) => `${p.label} pack ${p.version}${p.license === undefined ? '' : `, ${p.license}`}`).join(' · ')}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </fieldset>

            {view.suggestions.length === 0 ? null : (
              <section className="flex flex-col gap-1">
                <h2 className="m-0 text-[12px] font-semibold uppercase tracking-wide text-faint">Other domains</h2>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {view.suggestions.map((s) => (
                    <li key={s.label} className="text-[12px] text-dim">
                      <span className="font-semibold text-ink">{s.label}</span> — {s.description}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-ink disabled:opacity-60"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? 'Setting up…' : view.completed ? 'Add the selected modules' : 'Finish setup'}
              </button>
              <span className="text-[12px] text-faint">Selected: {picked.size === 0 ? 'none — the generic base only' : [...picked].join(', ')}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
