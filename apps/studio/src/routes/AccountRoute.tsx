/**
 * `/sign-in` (My account, once signed in) and `/account/tokens` (API tokens), drawn by the app
 * itself behind the same session gate: who you are, connecting a sign-in provider to this account
 * (`GET /api/account/providers`, Better Auth's `link-social`), signing out; and the tokens panel.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useMatches } from '@tanstack/react-router';
import { Button, Callout, KeyValues, Page } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import { request } from '../persistence.browser.ts';
import { useStudio } from '../studio-context.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { TokensPanel } from './TokensPanel.tsx';

const ROLE: Readonly<Record<string, string>> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

/** Better Auth's own routes: a sign-out or a provider link, from this same origin. */
async function auth(path: string, body: unknown): Promise<{ ok: boolean; url?: string; message?: string }> {
  try {
    const response = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const json = (await response.json().catch(() => ({}))) as { url?: string; message?: string };
    return { ok: response.ok, ...(json.url === undefined ? {} : { url: json.url }), ...(json.message === undefined ? {} : { message: json.message }) };
  } catch {
    return { ok: false, message: 'Could not reach WireHub.' };
  }
}

function Gate({ children }: { children: JSX.Element }): JSX.Element {
  const { me } = useStudio();
  if (me?.source !== 'session') return <div className="p-4 text-dim">Sign-in is off on this server. <Link to="/cables" className="underline">Designs</Link></div>;
  if (me.instance?.accounts !== true) return <div className="p-4 text-dim">This server keeps no accounts.</div>;
  return children;
}

function MyAccount({ error }: { error?: string }): JSX.Element {
  const { me } = useStudio();
  const [busy, setBusy] = useState<string>();
  const providers = useQuery({
    queryKey: ['account', 'providers'],
    queryFn: async () => {
      const out = await request<{ connect: { providerId: string; name: string }[] }>('/api/account/providers');
      return out.ok ? out.value.connect : [];
    },
    retry: false,
  });
  const connect = async (providerId: string): Promise<void> => {
    setBusy(providerId);
    const out = await auth('/link-social', { provider: providerId, callbackURL: '/sign-in', errorCallbackURL: '/sign-in' });
    if (out.ok && out.url !== undefined) {
      window.location.href = out.url;
      return;
    }
    setBusy(undefined);
    toast.error(out.message ?? 'Could not connect that account.');
  };
  const signOut = async (): Promise<void> => {
    setBusy('sign-out');
    await auth('/sign-out', {});
    window.location.href = '/sign-in';
  };
  return (
    <div className="flex max-w-xl flex-col gap-4 p-4" data-testid="my-account">
      {error === undefined ? null : <Callout tone="err">That sign-in provider could not be connected ({error.slice(0, 60)}). Use the same verified email as this account.</Callout>}
      <KeyValues items={[['Name', me?.name ?? ''], ['Email', me?.email ?? ''], ...(me?.role === undefined ? [] : [['Role', ROLE[me.role] ?? me.role] as const])]} />
      {(providers.data ?? []).length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2" title="Connect a provider that uses the same verified email as this account.">
          {(providers.data ?? []).map((p) => (
            <Button key={p.providerId} disabled={busy !== undefined} loading={busy === p.providerId} onClick={() => void connect(p.providerId)} data-provider={p.providerId}>
              Connect {p.name}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Link to="/account/tokens" className="cs-ui-btn no-underline" data-variant="secondary">
          API tokens
        </Link>
        <Button disabled={busy !== undefined} loading={busy === 'sign-out'} onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** `/sign-in` (My account) and `/account/tokens` (API tokens) */
export function AccountRoute(): JSX.Element {
  const matches = useMatches();
  const match = matches[matches.length - 1];
  const tokens = match?.pathname === '/account/tokens';
  const error = (match?.search as { error?: string } | undefined)?.error;
  return (
    <Page testId="account">
      <RouteHeader title={tokens ? 'API tokens' : 'My account'} help={false} />
      <div className="flex min-h-0 flex-1 flex-col">
        <Gate>{tokens ? <TokensPanel /> : <MyAccount {...(error === undefined || error === '' ? {} : { error })} />}</Gate>
      </div>
    </Page>
  );
}
