/**
 * The code-module half of `/settings` (`specs/runtime-modules.md`): the code
 * modules installed here and what became of each (loaded, off, failed with its
 * error), turning one on or off, the kill switch, the publisher keys owners
 * pinned for uploads, and **Restart WireHub** — an owner's way to finish a
 * change only a fresh process applies, from the UI and nowhere else. Owners
 * change things; everyone else reads. Installing is Library → Modules
 * (Install pack…, Browse store).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import { codeModulesKey, fetchBoot, fetchCodeModules, pinKey, requestRestart, setCodeAllowed, setModuleEnabled, unpinKey, waitForRestart, type CodeModuleStatusView } from '../code-modules.browser.ts';
import { useStudio } from '../studio-context.tsx';

const STATE_TEXT: Record<CodeModuleStatusView['state'], string> = {
  loaded: 'running',
  disabled: 'off',
  off: 'not running: code modules are turned off',
  failed: 'disabled automatically: it failed to load',
  refused: 'not running: refused',
};

export function CodeModulesSettings(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const owner = me !== undefined && (me.role === undefined || me.role === 'owner');
  const query = useQuery({
    queryKey: codeModulesKey,
    queryFn: async () => {
      const out = await fetchCodeModules();
      // a host without code modules (a development server, a test): said quietly, not as an error
      if (!out.ok && out.status === 501) return null;
      if (!out.ok) throw new Error(out.message);
      return out.value;
    },
  });
  const view = query.data ?? undefined;
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [restarting, setRestarting] = useState<'draining' | 'waiting' | 'gone' | undefined>(undefined);

  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: codeModulesKey });
  const act = async (work: () => Promise<{ ok: boolean; message?: string; hint?: string }>, done: string): Promise<void> => {
    setBusy(true);
    const out = await work();
    setBusy(false);
    if (!out.ok) toast.error(out.message ?? 'That failed.', { description: out.hint });
    else toast.success(done);
    await refresh();
  };
  const toggle = (m: CodeModuleStatusView, enabled: boolean): Promise<void> =>
    act(async () => {
      const out = await setModuleEnabled(m.id, enabled);
      if (out.ok && enabled && out.value.apply === 'restart') toast.message(`${m.id} runs now; its job queues start after Restart WireHub.`);
      return out;
    }, `${m.id} is ${enabled ? 'on' : 'off'}. It applied at once.`);
  const restart = async (): Promise<void> => {
    const boot = await fetchBoot();
    const before = boot.ok ? boot.value.bootId : '';
    const out = await requestRestart();
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setRestarting('draining');
    if (!out.value.supervised) toast.message('No supervisor is declared for this server: it stops, and comes back only if something restarts it.');
    setRestarting('waiting');
    const back = await waitForRestart(before);
    if (back) {
      // the new process may run another set of modules: start the page afresh
      window.location.reload();
    } else setRestarting('gone');
  };

  return (
    <section className="mt-6 max-w-2xl border-t border-line pt-4" data-testid="code-modules-settings">
      <h2 className="mb-1 text-[13px] font-semibold">Code modules</h2>
      <p className="mb-2 text-faint">
        Modules that run code in this hub, installed from a store or a signed upload (Library, Modules). The modules built into this image always run. Only owners install, turn on or off, or restart.
      </p>
      {query.isError ? <div role="alert">{query.error instanceof Error ? query.error.message : 'The code modules could not be read.'}</div> : null}
      {query.data === null ? <div className="text-faint">This server does not run code modules.</div> : null}
      {view === undefined ? (
        query.isError || query.data === null ? null : <div className="text-faint">Loading…</div>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Allow code modules"
              checked={view.allowed.settings}
              disabled={!owner || busy || !view.allowed.env}
              onChange={(e) => void act(() => setCodeAllowed(e.target.checked), e.target.checked ? 'Code modules are allowed.' : 'Code modules are turned off; the built-in modules still run.')}
            />
            <span className="font-medium">Allow code modules</span>
          </label>
          {view.allowed.env ? null : <div className="text-warn">Turned off by the server (WIREHUB_ALLOW_CODE_MODULES=false): no code module runs, whatever is set here.</div>}
          <div className="mt-1 text-faint">Built in: {view.builtins.join(', ') || 'none'} · module API {view.apiVersion}</div>

          <h3 className="mt-3 font-medium">Installed</h3>
          {view.modules.length === 0 ? <div className="text-faint">No code module is installed.</div> : null}
          <ul>
            {view.modules.map((m) => (
              <li key={m.id} className="my-2" data-code-module={m.id}>
                <div>
                  <b>{m.label}</b> ({m.id} {m.version}) · <span data-state={m.state}>{STATE_TEXT[m.state]}</span>
                  {m.restartPending ? <span className="ml-2 text-warn">restart required for {m.restartPoints.join(', ')}</span> : null}
                </div>
                {m.error === undefined ? null : <div className="text-err" role="alert">{m.error}</div>}
                <div className="text-faint">
                  Uses {m.extensionPoints.join(', ')}. May: {m.permissions.join(', ')}. {m.trust === undefined ? '' : `Signed by ${m.trust.keys.length} key(s), trusted ${m.trust.via === 'store' ? 'through its store' : 'by a pinned key'}.`}
                  {m.enabledBy === undefined ? '' : ` Last changed by ${m.enabledBy}.`}
                </div>
                {!owner ? null : (
                  <button type="button" className="underline" disabled={busy} onClick={() => void toggle(m, !m.enabled || m.state === 'failed')}>
                    {m.enabled && m.state !== 'failed' ? 'Turn off' : m.state === 'failed' ? 'Try again' : 'Turn on'}
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3 className="mt-3 font-medium">Trusted publisher keys (uploads)</h3>
          <p className="text-faint">A code module uploaded from a file must be signed by one of these. Compare the fingerprint with the publisher another way before you add a key.</p>
          <ul>
            {view.keys.map((k) => (
              <li key={k.key} data-pinned-key={k.keyId}>
                {k.label ?? 'Key'} · id {k.keyId} · fingerprint <code>{k.fingerprint}</code>
                {!owner ? null : (
                  <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void act(() => unpinKey(k.keyId), 'The key is no longer trusted for uploads.')}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!owner ? null : (
            <div className="mt-1 flex flex-wrap gap-2">
              <input className="w-96 rounded border border-line bg-panel px-2 py-1" aria-label="Publisher public key" placeholder="RW…" value={key} onChange={(e) => setKey(e.target.value)} />
              <input className="w-40 rounded border border-line bg-panel px-2 py-1" aria-label="Key label" placeholder="Publisher name" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button
                type="button"
                className="underline"
                disabled={busy || key.trim() === ''}
                onClick={() =>
                  void act(async () => {
                    const out = await pinKey(key.trim(), label);
                    if (out.ok) {
                      setKey('');
                      setLabel('');
                    }
                    return out;
                  }, 'The key is trusted for uploads.')
                }
              >
                Trust key
              </button>
            </div>
          )}

          <h3 className="mt-3 font-medium">Restart WireHub</h3>
          <p className="text-faint">
            Finishes changes only a fresh start applies (a module's job queues). WireHub stops taking requests, lets the ones in flight finish, closes cleanly and exits; the
            container's restart policy starts it again, and this page reconnects by itself.
            {view.supervised ? '' : ' This server does not declare a supervisor (WIREHUB_RESTART_SUPERVISED): it may not come back on its own.'}
          </p>
          {!owner ? null : (
            <button type="button" className="mt-1 rounded border border-line px-3 py-1" disabled={restarting !== undefined} onClick={() => void restart()}>
              Restart WireHub
            </button>
          )}
        </>
      )}
      {restarting === undefined ? null : (
        <div role="alertdialog" aria-label="Restarting WireHub" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="restart-overlay">
          <div className="rounded border border-line bg-panel p-4">
            {restarting === 'gone' ? 'WireHub has not come back yet. Check the server, then reload this page.' : 'Restarting WireHub… this page reconnects by itself.'}
          </div>
        </div>
      )}
    </section>
  );
}
