/** Session-gated account controls retain their server implementation inside the app shell. */
import { useEffect, useRef, type JSX } from 'react';
import { Link, useMatches } from '@tanstack/react-router';
import { useStudio } from '../studio-context.tsx';

export function AccountRoute(): JSX.Element {
  const { me, theme } = useStudio();
  const matches = useMatches();
  const match = matches[matches.length - 1];
  const path = match?.pathname === '/settings/people' ? '/settings/people' : match?.pathname === '/account/tokens' ? '/account/tokens' : '/sign-in';
  const title = path === '/settings/people' ? 'People of this hub' : path === '/account/tokens' ? 'My API tokens' : 'My account';
  const iframe = useRef<HTMLIFrameElement>(null);
  const error = (match?.search as { error?: string } | undefined)?.error;
  const src = `${path}?embed=1${path === '/sign-in' && error !== undefined ? `&error=${encodeURIComponent(error)}` : ''}`;
  const applyTheme = (): void => {
    const doc = iframe.current?.contentDocument;
    if (doc?.documentElement !== undefined) doc.documentElement.dataset['theme'] = theme;
  };
  useEffect(applyTheme, [theme]);
  if (me?.source !== 'session') return <div className="p-4"><h1>{title}</h1><p className="text-dim">Account controls require a signed-in session.</p><Link to="/cables" className="underline">Return to Cables</Link></div>;
  if (path !== '/sign-in' && me.instance?.accounts !== true) return <div className="p-4"><h1>{title}</h1><p className="text-dim">This server does not provide these account controls.</p></div>;
  return <iframe ref={iframe} title={title} src={src} onLoad={applyTheme} className="block h-full w-full border-0" data-testid="account-frame" />;
}
