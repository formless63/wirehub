/** Session-gated account controls retain their server implementation inside the app shell. */
import { useEffect, useRef, type JSX } from 'react';
import { Link, useMatches } from '@tanstack/react-router';
import { Page } from '@wirehub/editor-react';
import { useStudio } from '../studio-context.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';

/** the server's account page, embedded and themed to match the app */
export function AccountFrame({ path, title, error }: { path: '/sign-in' | '/account/tokens' | '/settings/people'; title: string; error?: string }): JSX.Element {
  const { me, theme } = useStudio();
  const iframe = useRef<HTMLIFrameElement>(null);
  const src = `${path}?embed=1${path === '/sign-in' && error !== undefined ? `&error=${encodeURIComponent(error)}` : ''}`;
  const applyTheme = (): void => {
    const doc = iframe.current?.contentDocument;
    if (doc?.documentElement !== undefined) doc.documentElement.dataset['theme'] = theme;
  };
  useEffect(applyTheme, [theme]);
  if (me?.source !== 'session') return <div className="p-4"><p className="text-dim">Account controls require a signed-in session.</p><Link to="/cables" className="underline">Return to Designs</Link></div>;
  if (path !== '/sign-in' && me.instance?.accounts !== true) return <div className="p-4"><p className="text-dim">This server does not provide these account controls.</p></div>;
  return <iframe ref={iframe} title={title} src={src} onLoad={applyTheme} className="block h-full min-h-[480px] w-full border-0" data-testid="account-frame" />;
}

/** `/sign-in` (My account) and `/account/tokens` (API tokens) */
export function AccountRoute(): JSX.Element {
  const matches = useMatches();
  const match = matches[matches.length - 1];
  const path = match?.pathname === '/account/tokens' ? '/account/tokens' : '/sign-in';
  const title = path === '/account/tokens' ? 'API tokens' : 'My account';
  const error = (match?.search as { error?: string } | undefined)?.error;
  return (
    <Page testId="account">
      <RouteHeader title={title} help={false} />
      <div className="min-h-0 flex-1">
        <AccountFrame path={path} title={title} {...(error === undefined ? {} : { error })} />
      </div>
    </Page>
  );
}
