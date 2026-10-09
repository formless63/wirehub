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
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';

import { loadSetup, partNumbersChanged, pnExample, saveSetup, signInAdmin, slugOf, type SetupView } from '../setup.browser.ts';
import { StudioMark } from '../shell/Wordmark.tsx';
import { Button, Input } from '@wirehub/editor-react';

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
  const [copied, setCopied] = useState(false);

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

  const LEGEND = 'mb-2 text-xs font-semibold uppercase tracking-wide text-dim';
  const FIELD = 'rounded border border-line-field bg-panel px-2 py-1 text-sm text-ink';
  const create = view?.create;
  const SETUP_COMMAND = 'docker compose logs wirehub | grep -A2 "setup code"';
  const copyCommand = (): void => {
    void navigator.clipboard?.writeText(SETUP_COMMAND).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 py-6">
        <header className="flex items-center gap-3">
          <StudioMark size={28} />
          <h1 className="m-0 text-xl font-semibold text-ink">Set up WireHub</h1>
          {view?.completed ? (
            <Link to="/cables" className="ml-auto text-xs text-dim underline hover:text-ink">
              Back to designs
            </Link>
          ) : null}
        </header>

        {problem === undefined ? null : (
          <p role="alert" className="m-0 rounded border border-err px-3 py-2 text-sm text-err">
            {problem}
          </p>
        )}

        {view === undefined ? (
          problem === undefined ? <p className="text-sm text-dim">Loading…</p> : null
        ) : (
          <>
            {create === undefined ? null : (
              <>
                {create.claim === true ? (
                  <p className="m-0 text-sm text-dim">This hub's catalog came over from its file storage. Make its first admin to finish.</p>
                ) : (
                  <fieldset className="m-0 border-0 p-0">
                    <legend className={LEGEND}>Organisation</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs text-dim">
                        Name
                        <Input
                          className={FIELD}
                          value={orgName}
                          disabled={busy}
                          placeholder="Example Shop"
                          onChange={(event) => {
                            setOrgName(event.target.value);
                            if (!slugEdited) setSlug(slugOf(event.target.value));
                          }}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-dim">
                        Short name (lowercase, used in addresses)
                        <Input
                          className={`${FIELD} font-mono`}
                          value={slug}
                          disabled={busy}
                          placeholder="example-shop"
                          onChange={(event) => {
                            setSlug(event.target.value);
                            setSlugEdited(true);
                          }}
                        />
                      </label>
                    </div>
                  </fieldset>
                )}
                <fieldset className="m-0 border-0 p-0">
                  <legend className={LEGEND}>Admin</legend>
                  {create.admin === 'none' ? (
                    <p className="m-0 mb-2 text-xs text-dim">
                      Sign-in is off (AUTH_ENABLED), so anyone who can reach this hub can edit. A name and email here only label your changes.
                    </p>
                  ) : null}
                  {create.admin === 'oidc' ? <p className="m-0 mb-2 text-xs text-dim">You sign in with the identity provider; give the email it knows you by.</p> : null}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs text-dim">
                      Your name
                      <Input className={FIELD} value={adminName} disabled={busy} autoComplete="name" onChange={(event) => setAdminName(event.target.value)} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-dim">
                      Email
                      <Input type="email" className={FIELD} value={adminEmail} disabled={busy} autoComplete="username" onChange={(event) => setAdminEmail(event.target.value)} />
                    </label>
                    {create.admin === 'password' ? (
                      <label className="flex flex-col gap-1 text-xs text-dim sm:col-span-2">
                        Password ({create.minPassword} characters or more)
                        <Input type="password" className={FIELD} value={password} disabled={busy} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
                      </label>
                    ) : null}
                  </div>
                </fieldset>
              </>
            )}

            {view.codeRequired === true ? (
              <fieldset className="m-0 border-0 p-0">
                <legend className={LEGEND}>Setup code</legend>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Setup code"
                    className={`w-[220px] ${FIELD} font-mono text-md tracking-wider`}
                    placeholder="XXXX-XXXX-XXXX"
                    value={code}
                    disabled={busy}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <span className="text-xs text-dim">Printed in the server log at start.</span>
                  <Button
                    type="button"
                    title="Copy the command that prints the setup code"
                    onClick={copyCommand} className="flex items-center gap-1"
                  >
                    {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    {copied ? 'Copied' : 'Copy the command'}
                  </Button>
                </div>
              </fieldset>
            ) : null}

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className={LEGEND}>Domains</legend>
              {view.domains.length === 0 ? (
                <p className="text-sm text-dim">This build bundles no domain modules.</p>
              ) : (
                view.domains.map((domain) => (
                  <label key={domain.id} className="flex cursor-pointer items-start gap-3 rounded border border-line bg-panel px-3 py-2 hover:bg-hover">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={picked.has(domain.id)}
                      disabled={domain.enabled || busy}
                      onChange={() => toggle(domain.id)}
                      aria-describedby={`setup-${domain.id}`}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-ink">
                        {domain.label}
                        {domain.enabled ? <span className="ml-2 text-2xs font-normal text-ok">enabled</span> : null}
                        {!domain.enabled && domain.suggested ? <span className="ml-2 text-2xs font-normal text-faint">suggested</span> : null}
                      </span>
                      <span id={`setup-${domain.id}`} className="text-xs text-dim">
                        {domain.description}
                      </span>
                      <span className="text-2xs text-faint">
                        {domain.packs.map((p) => `${p.label} pack ${p.version}${p.license === undefined ? '' : `, ${p.license}`}`).join(' · ')}
                      </span>
                    </span>
                  </label>
                ))
              )}
              {view.suggestions.length === 0 ? null : (
                <p className="m-0 text-xs text-dim">
                  Not yet available: {view.suggestions.map((s) => s.label).join(', ')}.
                </p>
              )}
            </fieldset>

            {create === undefined || create.claim === true ? null : (
              <details className="rounded border border-line bg-panel px-3 py-2">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-dim">Advanced</summary>
                <div className="mt-3 flex flex-col gap-4">
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className={LEGEND}>Catalog</legend>
                    <label className="flex items-start gap-2 text-sm text-ink">
                      <input type="radio" name="catalog" className="mt-1" checked={catalog === 'starter'} disabled={busy} onChange={() => setCatalog('starter')} />
                      <span>
                        Starter catalog <span className="text-xs text-dim">— example designs and the parts they use, to learn from</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-ink">
                      <input type="radio" name="catalog" className="mt-1" checked={catalog === 'empty'} disabled={busy} onChange={() => setCatalog('empty')} />
                      <span>
                        Empty catalog <span className="text-xs text-dim">— the base vocabulary only</span>
                      </span>
                    </label>
                  </fieldset>
                  {create.partNumbers === undefined ? null : create.partNumbers.scheme === 'module' ? (
                    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                      <legend className={LEGEND}>Part numbers</legend>
                      <p className="m-0 text-xs text-dim">This build numbers parts with its own scheme, {create.partNumbers.label}. It is fixed.</p>
                    </fieldset>
                  ) : (
                    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                      <legend className={LEGEND}>Part numbers</legend>
                      <p className="m-0 text-xs text-dim">
                        A prefix and a running number per kind, like {pnExample(pnPrefixes.connector ?? 'CON', pnDigits)}. A kind with no prefix is not numbered.
                      </p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                        {create.partNumbers.kinds.map((kind) => (
                          <label key={kind} className="flex flex-col gap-0.5 text-xs text-dim">
                            {kind}
                            <Input
                              className={`${FIELD} font-mono uppercase`}
                              value={pnPrefixes[kind] ?? ''}
                              disabled={busy}
                              maxLength={8}
                              aria-label={`Prefix for ${kind}`}
                              onChange={(event) => setPnPrefixes({ ...pnPrefixes, [kind]: event.target.value.toUpperCase() })}
                            />
                          </label>
                        ))}
                      </div>
                      <label className="flex flex-col gap-1 text-xs text-dim">
                        Digits
                        <Input type="number" min={1} max={12} className={`w-[80px] ${FIELD} font-mono`} value={pnDigits} disabled={busy} onChange={(event) => setPnDigits(Number(event.target.value))} />
                      </label>
                    </fieldset>
                  )}
                </div>
              </details>
            )}

            <div className="flex items-center gap-3">
              <Button
                type="button"
                disabled={
                  busy ||
                  (view.codeRequired === true && code.trim() === '') ||
                  (create !== undefined &&
                    ((create.claim !== true && (orgName.trim() === '' || slug.trim() === '')) || (create.admin !== 'none' && (adminName.trim() === '' || adminEmail.trim() === '')) || (create.admin === 'password' && password.length < create.minPassword)))
                }
                onClick={() => void submit()} variant="primary"
              >
                {busy ? 'Setting up…' : view.completed ? 'Add the selected modules' : 'Finish setup'}
              </Button>
              <span className="text-xs text-dim">Selected: {picked.size === 0 ? 'none — the generic base only' : [...picked].join(', ')}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
