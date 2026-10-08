/**
 * `/setup` — first-run setup: pick the domain modules this hub works with.
 *
 * Each bundled domain module (`modules.config.ts`) is a checkbox with what it
 * adds, unticked unless the deployment suggested it (`WIREHUB_SUGGESTED_MODULES`);
 * nothing is forced, and an empty choice is a fine answer — the base works on
 * its own. Enabling installs the module's catalog pack beside the catalog
 * (`server/setup.ts`); a module already enabled stays enabled. While setup
 * has to run the server asks for the one-time setup code it printed to its log. Domains the build has no module for yet are listed
 * underneath, so a person can see where they stand.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';

import { loadSetup, partNumbersChanged, pnExample, saveSetup, signInAdmin, slugOf, type SetupView } from '../setup.browser.ts';
import { StudioMark } from '../shell/Wordmark.tsx';

export function SetupRoute(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<SetupView | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  // a hub with no organisation yet: the organisation, its catalog and the admin
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [catalog, setCatalog] = useState<'starter' | 'empty'>('starter');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [password, setPassword] = useState('');
  // part numbers: the offered prefixes, edited in place
  const [pnPrefixes, setPnPrefixes] = useState<Record<string, string>>({});
  const [pnDigits, setPnDigits] = useState(5);

  useEffect(() => {
    let live = true;
    void loadSetup().then((out) => {
      if (!live) return;
      if (!out.ok) {
        setProblem(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
        return;
      }
      setView(out.value);
      const pn = out.value.create?.partNumbers;
      if (pn?.scheme === 'prefix') {
        setPnPrefixes({ ...pn.prefixes });
        setPnDigits(pn.digits);
      }
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
    const create = view?.create;
    const admin = create === undefined || (create.admin === 'none' && adminEmail.trim() === '') ? undefined : { name: adminName.trim(), email: adminEmail.trim(), ...(create.admin === 'password' ? { password } : {}) };
    const pn = create?.partNumbers;
    const partNumbers =
      create === undefined || create.claim === true || pn?.scheme !== 'prefix' || !partNumbersChanged(pn, pnPrefixes, pnDigits)
        ? undefined
        : { prefixes: Object.fromEntries(pn.kinds.map((kind) => [kind, (pnPrefixes[kind] ?? '').trim()])), digits: pnDigits };
    const out = await saveSetup(
      [...picked],
      '/api',
      view?.codeRequired === true ? code : undefined,
      create === undefined ? undefined : { ...(create.claim === true ? {} : { org: { name: orgName.trim(), slug: slug.trim() }, catalog }), ...(admin === undefined ? {} : { admin }), ...(partNumbers === undefined ? {} : { partNumbers }) },
    );
    if (!out.ok) {
      setBusy(false);
      setProblem(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
      return;
    }
    // the admin made here signs in now; with an identity provider, through the sign-in page
    if (create?.admin === 'password' && !(await signInAdmin(adminEmail.trim(), password))) {
      setBusy(false);
      window.location.assign('/sign-in');
      return;
    }
    if (create?.admin === 'oidc') {
      window.location.assign('/sign-in');
      return;
    }
    setBusy(false);
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
            {view.create === undefined ? null : (
              <>
                {view.create.claim === true ? (
                  <p className="m-0 text-[13px] text-dim">This hub's catalog came over from its file storage. Make its first admin to finish.</p>
                ) : (
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Organisation</legend>
                  <label className="flex flex-col gap-1 text-[12px] text-dim">
                    Name
                    <input
                      className="rounded border border-line bg-panel px-2 py-1 text-[13px] text-ink"
                      value={orgName}
                      disabled={busy}
                      placeholder="Example Shop"
                      onChange={(event) => {
                        setOrgName(event.target.value);
                        if (!slugEdited) setSlug(slugOf(event.target.value));
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-dim">
                    Short name (lowercase, used in addresses)
                    <input
                      className="w-[260px] rounded border border-line bg-panel px-2 py-1 font-mono text-[13px] text-ink"
                      value={slug}
                      disabled={busy}
                      placeholder="example-shop"
                      onChange={(event) => {
                        setSlug(event.target.value);
                        setSlugEdited(true);
                      }}
                    />
                  </label>
                </fieldset>
                )}
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Admin</legend>
                  {view.create.admin === 'none' ? (
                    <p className="m-0 text-[12px] text-dim">
                      Sign-in is off (AUTH_ENABLED), so anyone who can reach this hub can edit. A name and email here only label your changes.
                    </p>
                  ) : null}
                  {view.create.admin === 'oidc' ? (
                    <p className="m-0 text-[12px] text-dim">You sign in with the identity provider; give the email it knows you by.</p>
                  ) : null}
                  <label className="flex flex-col gap-1 text-[12px] text-dim">
                    Your name
                    <input className="rounded border border-line-field bg-panel px-2 py-1 text-[13px] text-ink" value={adminName} disabled={busy} autoComplete="name" onChange={(event) => setAdminName(event.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-dim">
                    Email
                    <input type="email" className="rounded border border-line-field bg-panel px-2 py-1 text-[13px] text-ink" value={adminEmail} disabled={busy} autoComplete="username" onChange={(event) => setAdminEmail(event.target.value)} />
                  </label>
                  {view.create.admin === 'password' ? (
                    <label className="flex flex-col gap-1 text-[12px] text-dim">
                      Password ({view.create.minPassword} characters or more)
                      <input type="password" className="rounded border border-line-field bg-panel px-2 py-1 text-[13px] text-ink" value={password} disabled={busy} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
                    </label>
                  ) : null}
                </fieldset>
                {view.create.claim === true ? null : (
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Catalog</legend>
                  <label className="flex items-start gap-2 text-[13px] text-ink">
                    <input type="radio" name="catalog" className="mt-1" checked={catalog === 'starter'} disabled={busy} onChange={() => setCatalog('starter')} />
                    <span>
                      Starter catalog <span className="text-[12px] text-dim">— example cables and the parts they use, to learn from</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-[13px] text-ink">
                    <input type="radio" name="catalog" className="mt-1" checked={catalog === 'empty'} disabled={busy} onChange={() => setCatalog('empty')} />
                    <span>
                      Empty catalog <span className="text-[12px] text-dim">— the base vocabulary only</span>
                    </span>
                  </label>
                </fieldset>
                )}
                {view.create.claim === true || view.create.partNumbers === undefined ? null : view.create.partNumbers.scheme === 'module' ? (
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Part numbers</legend>
                    <p className="m-0 text-[12px] text-dim">This build numbers parts with its own scheme, {view.create.partNumbers.label}. It is fixed.</p>
                  </fieldset>
                ) : (
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Part numbers</legend>
                    <p className="m-0 text-[12px] text-dim">
                      Each kind of part gets a prefix and a running number, like {pnExample(pnPrefixes.connector ?? 'CON', pnDigits)}. The defaults are fine; change them
                      to match numbers you already use. A kind with no prefix is not numbered.
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                      {view.create.partNumbers.kinds.map((kind) => (
                        <label key={kind} className="flex flex-col gap-0.5 text-[12px] text-dim">
                          {kind}
                          <input
                            className="rounded border border-line bg-panel px-2 py-1 font-mono text-[13px] uppercase text-ink"
                            value={pnPrefixes[kind] ?? ''}
                            disabled={busy}
                            maxLength={8}
                            aria-label={`Prefix for ${kind}`}
                            onChange={(event) => setPnPrefixes({ ...pnPrefixes, [kind]: event.target.value.toUpperCase() })}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="flex flex-col gap-1 text-[12px] text-dim">
                      Digits
                      <input
                        type="number"
                        min={1}
                        max={12}
                        className="w-[80px] rounded border border-line bg-panel px-2 py-1 font-mono text-[13px] text-ink"
                        value={pnDigits}
                        disabled={busy}
                        onChange={(event) => setPnDigits(Number(event.target.value))}
                      />
                    </label>
                  </fieldset>
                )}
              </>
            )}

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

            {view.codeRequired === true ? (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-faint">Setup code</span>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-[220px] rounded border border-line bg-panel px-2 py-1 font-mono text-[14px] tracking-wider text-ink"
                  placeholder="XXXX-XXXX-XXXX"
                  value={code}
                  disabled={busy}
                  onChange={(event) => setCode(event.target.value)}
                />
                <span className="text-[12px] text-dim">
                  The server printed it to its log when it started: <code>docker compose logs wirehub</code>, or the wirehub
                  container's logs in your Docker UI.
                </span>
              </label>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-ink disabled:opacity-60"
                disabled={
                  busy ||
                  (view.codeRequired === true && code.trim() === '') ||
                  (view.create !== undefined &&
                    ((view.create.claim !== true && (orgName.trim() === '' || slug.trim() === '')) || (view.create.admin !== 'none' && (adminName.trim() === '' || adminEmail.trim() === '')) || (view.create.admin === 'password' && password.length < view.create.minPassword)))
                }
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
