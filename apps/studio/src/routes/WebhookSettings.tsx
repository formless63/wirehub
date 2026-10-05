/**
 * Outbound event webhooks (`server/webhooks/`), owners only: where each event goes (URL, the
 * events, a signing secret kept encrypted and shown once), a test button, and the delivery
 * log with redelivery. An external system subscribes to "version released", then pulls the
 * BOM through the API with a token (`docs/webhooks.md`).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import {
  clearWebhookSecret,
  redeliverWebhook,
  saveWebhooks,
  setWebhookSecret,
  testWebhook,
  webhookDeliveriesKey,
  webhookDeliveriesQuery,
  webhooksKey,
  webhooksQuery,
  type WebhookSubscriptionView,
} from '../settings.browser.ts';
import { useStudio } from '../studio-context.tsx';

type Draft = { id?: string; label: string; url: string; events: string[]; enabled: boolean };

const blank = (): Draft => ({ label: '', url: '', events: ['version.released'], enabled: true });
const draftOf = (s: WebhookSubscriptionView): Draft => ({ id: s.id, label: s.label ?? '', url: s.url, events: s.events, enabled: s.enabled });

export function WebhookSettings(): JSX.Element | null {
  const client = useQueryClient();
  const { me } = useStudio();
  const isOwner = me?.role === undefined || me.role === 'owner';
  const query = useQuery({ ...webhooksQuery, enabled: isOwner });
  const log = useQuery({ ...webhookDeliveriesQuery, enabled: isOwner });
  const view = query.data;
  const [editing, setEditing] = useState<Draft | undefined>(undefined);
  const [shown, setShown] = useState<{ id: string; secret: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (!isOwner) return null;

  const say = (out: { message: string; hint?: string }): void => {
    toast.error(out.message, { description: out.hint });
  };

  const persist = async (next: Draft[], done: string): Promise<boolean> => {
    if (view === undefined) return false;
    setBusy(true);
    const out = await saveWebhooks(
      next.map((d) => ({ ...(d.id === undefined ? {} : { id: d.id }), ...(d.label.trim() === '' ? {} : { label: d.label.trim() }), url: d.url.trim(), events: d.events, enabled: d.enabled })) as never,
      view.etag,
    );
    setBusy(false);
    if (!out.ok) {
      say(out);
      return false;
    }
    client.setQueryData(webhooksKey, out.value);
    toast.success(done);
    return true;
  };

  const save = async (): Promise<void> => {
    if (editing === undefined || view === undefined) return;
    const others = view.subscriptions.filter((s) => s.id !== editing.id).map(draftOf);
    const same = view.subscriptions.find((s) => s.id === editing.id);
    const list = same === undefined ? [...others, editing] : view.subscriptions.map((s) => (s.id === editing.id ? editing : draftOf(s)));
    if (await persist(list, same === undefined ? 'Webhook added. Set its signing secret to start sending.' : 'Webhook saved.')) setEditing(undefined);
  };

  const makeSecret = async (id: string): Promise<void> => {
    setBusy(true);
    const out = await setWebhookSecret(id);
    setBusy(false);
    if (!out.ok) return say(out);
    if (out.value.generated !== undefined) setShown({ id, secret: out.value.generated });
    await client.invalidateQueries({ queryKey: webhooksKey });
  };

  const send = async (id: string): Promise<void> => {
    const out = await testWebhook(id);
    if (!out.ok) return say(out);
    toast.success('A test event is on its way; see the log below.');
    void client.invalidateQueries({ queryKey: webhookDeliveriesKey });
  };

  const toggleEvent = (type: string): void => {
    if (editing === undefined) return;
    setEditing({ ...editing, events: editing.events.includes(type) ? editing.events.filter((e) => e !== type) : [...editing.events, type] });
  };

  return (
    <section className="mt-6 max-w-2xl border-t border-line pt-3" data-testid="webhook-settings">
      <h2 className="mb-1 text-[13px] font-semibold">Webhooks</h2>
      <p className="mb-2 max-w-xl text-faint">
        Tell an outside system (an ERP, a chat channel, a script) when something happens: a signed JSON event with ids, links, the actor and a short diff. The receiver then fetches what it needs through the API with a token. Failed deliveries are retried with a growing wait.
        These are separate from the alert webhook under Notifications, which reports the hub’s own problems.
      </p>
      {view === undefined ? (
        <div className="text-faint">{query.isError ? 'The webhooks could not be read.' : 'Loading…'}</div>
      ) : (
        <>
          {view.secrets.available ? null : <div role="alert" className="text-err">{view.secrets.note}</div>}
          {view.subscriptions.length === 0 ? <div className="text-faint">No webhooks yet.</div> : null}
          <ul>
            {view.subscriptions.map((s) => (
              <li key={s.id} className="my-1 border border-line p-2" data-webhook={s.id}>
                <b>{s.label ?? s.url}</b>
                {s.enabled ? '' : ' · off'} · secret {s.secret === 'set' ? 'set' : s.secret === 'unreadable' ? 'cannot be read with this key' : 'not set'}
                <div className="text-faint break-all">{s.url}</div>
                <div className="text-faint">{s.events.join(', ')}</div>
                <div className="mt-1 flex flex-wrap gap-3">
                  <button type="button" className="underline" onClick={() => setEditing(draftOf(s))}>
                    Edit…
                  </button>
                  <button type="button" className="underline" disabled={busy || !view.secrets.available} onClick={() => void makeSecret(s.id)}>
                    {s.secret === 'set' ? 'New secret…' : 'Make a secret'}
                  </button>
                  {s.secret === 'unset' ? null : (
                    <button type="button" className="underline" disabled={busy} onClick={() => void clearWebhookSecret(s.id).then(() => client.invalidateQueries({ queryKey: webhooksKey }))}>
                      Clear secret
                    </button>
                  )}
                  <button type="button" className="underline" disabled={busy || s.secret !== 'set'} onClick={() => void send(s.id)}>
                    Send a test
                  </button>
                  <button type="button" className="underline" disabled={busy} onClick={() => void persist(view.subscriptions.filter((x) => x.id !== s.id).map(draftOf), 'Webhook removed.')}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {shown === undefined ? null : (
            <div className="my-2 border border-warn p-2" data-testid="webhook-secret-once">
              Signing secret for the receiver, shown once: <code className="break-all">{shown.secret}</code>
              <div className="text-faint">
                Each delivery carries <code>{view.signature.header}: {view.signature.scheme}</code>. It is kept encrypted here and cannot be shown again.
              </div>
              <button type="button" className="underline" onClick={() => setShown(undefined)}>
                I have copied it
              </button>
            </div>
          )}
          <button type="button" className="mt-2 rounded border border-line px-3 py-1" disabled={view.subscriptions.length >= view.limits.subscriptions} onClick={() => setEditing(blank())}>
            Add a webhook…
          </button>
          {editing === undefined ? null : (
            <div className="mt-2 border border-line p-2" data-testid="webhook-editor">
              <label className="flex flex-col gap-0.5">
                <span className="font-medium">Name (optional)</span>
                <input className="rounded border border-line bg-panel px-2 py-1" aria-label="Webhook name" value={editing.label} maxLength={80} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
              </label>
              <label className="mt-1 flex flex-col gap-0.5">
                <span className="font-medium">URL</span>
                <input className="rounded border border-line bg-panel px-2 py-1" aria-label="Webhook URL" placeholder="https://erp.example.com/hooks/wirehub" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
              </label>
              <fieldset className="mt-1 border-0 p-0">
                <legend className="font-medium">Events</legend>
                {view.events.map((e) => (
                  <label key={e.type} className="flex items-start gap-2" title={e.description}>
                    <input type="checkbox" aria-label={e.label} checked={editing.events.includes(e.type)} onChange={() => toggleEvent(e.type)} />
                    <span>
                      {e.label} <span className="text-faint">({e.type})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="mt-1 flex items-center gap-2">
                <input type="checkbox" aria-label="Webhook on" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                On
              </label>
              <div className="mt-2 flex gap-2">
                <button type="button" className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50" disabled={busy} onClick={() => void save()}>
                  Save webhook
                </button>
                <button type="button" className="underline" onClick={() => setEditing(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <h3 className="mt-3 font-medium">Delivery log</h3>
          {(log.data ?? []).length === 0 ? <div className="text-faint">Nothing has been sent yet.</div> : null}
          <ul data-testid="webhook-log">
            {(log.data ?? []).slice(0, 30).map((d) => (
              <li key={d.id} className="my-0.5" data-delivery={d.deliveryId}>
                <b>{d.type}</b> · attempt {d.attempt} · {d.state}
                {d.status === undefined ? '' : ` (${d.status})`}
                {d.retryAt !== undefined && d.state === 'retrying' ? `, next ${new Date(d.retryAt).toLocaleTimeString()}` : ''}
                {d.redeliveredFrom === undefined ? '' : ' · redelivery'}
                {d.error === undefined ? null : <span className="text-faint"> — {d.error}</span>}
                {d.state === 'delivered' || d.state === 'failed' ? (
                  <button type="button" className="ml-2 underline" onClick={() => void redeliverWebhook(d.id).then((out) => (out.ok ? (toast.success('Queued again.'), client.invalidateQueries({ queryKey: webhookDeliveriesKey })) : say(out)))}>
                    Redeliver
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
