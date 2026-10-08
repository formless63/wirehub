/**
 * Restart WireHub: a ConfirmDialog first, then a progress state ("Restarting… 7 s") that
 * polls `GET /api/system/boot` until another boot id answers, says "Reconnected in N s"
 * for a moment and reloads (the new process may run another set of modules).
 */

import { ConfirmDialog } from '@wirehub/editor-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { fetchBoot, requestRestart, waitForRestart } from '../code-modules.browser.ts';

type Phase = { name: 'idle' } | { name: 'confirm' } | { name: 'working'; startedAt: number } | { name: 'back'; seconds: number } | { name: 'gone' };

const seconds = (since: number): number => Math.max(0, Math.round((Date.now() - since) / 1000));

export function RestartWireHub({ supervised, disabled }: { supervised: boolean; disabled?: boolean }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const startedAt = phase.name === 'working' ? phase.startedAt : undefined;
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = setInterval(() => setElapsed(seconds(startedAt)), 500);
    return () => clearInterval(tick);
  }, [startedAt]);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  const restart = async (): Promise<void> => {
    const boot = await fetchBoot();
    const before = boot.ok ? boot.value.bootId : '';
    const out = await requestRestart();
    if (!out.ok) {
      setPhase({ name: 'idle' });
      toast.error(out.message, { description: out.hint });
      return;
    }
    const begun = Date.now();
    setElapsed(0);
    setPhase({ name: 'working', startedAt: begun });
    if (!out.value.supervised) toast.message('No supervisor is declared for this server: it stops, and comes back only if something restarts it.');
    const back = await waitForRestart(before);
    if (back) {
      setPhase({ name: 'back', seconds: seconds(begun) });
      reloadTimer.current = setTimeout(() => window.location.reload(), 1200);
    } else {
      setPhase({ name: 'gone' });
      toast.error('WireHub has not come back yet.', { description: 'Check the server, then reload this page.' });
    }
  };

  return (
    <>
      <button type="button" className="rounded border border-line px-3 py-1" disabled={disabled === true || phase.name !== 'idle'} onClick={() => setPhase({ name: 'confirm' })}>
        Restart WireHub
      </button>
      <ConfirmDialog
        open={phase.name === 'confirm'}
        title="Restart WireHub?"
        confirmLabel="Restart"
        onCancel={() => setPhase({ name: 'idle' })}
        onConfirm={() => void restart()}
      >
        It stops taking requests, finishes the ones in flight and starts again. This page reconnects by itself.
        {supervised ? '' : ' No supervisor is declared: it may not come back on its own.'}
      </ConfirmDialog>
      {phase.name === 'working' || phase.name === 'back' || phase.name === 'gone' ? (
        <div role="alertdialog" aria-label="Restarting WireHub" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="restart-overlay" data-phase={phase.name}>
          <div className="rounded border border-line bg-panel px-4 py-3 text-[12.5px]">
            {phase.name === 'working' ? `Restarting WireHub… ${elapsed} s` : null}
            {phase.name === 'back' ? `Restarting WireHub… reconnected in ${phase.seconds} s` : null}
            {phase.name === 'gone' ? (
              <>
                WireHub has not come back yet. Check the server, then{' '}
                <button type="button" className="underline" onClick={() => window.location.reload()}>reload this page</button>.
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
