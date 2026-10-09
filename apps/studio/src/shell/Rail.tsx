/** Labeled desktop navigation, with scrolling destinations and a pinned account. */
import type { JSX } from 'react';
import { Link } from '@tanstack/react-router';
import { LockNameAvatar } from '../locks/LockNameAvatar.tsx';
import { useStudio } from '../studio-context.tsx';
import { NavItems } from './NavItems.tsx';

export function Rail(): JSX.Element {
  const { user, me } = useStudio();
  const who = me?.email === undefined ? user : `${user} <${me.email}>`;
  return <nav aria-label="sections" className="cs-navigation-rail max-sm:hidden">
    <div className="cs-navigation-links"><NavItems compact /></div>
    <div className="cs-navigation-account">
      {me?.instance?.env === 'dev' ? <span className="text-2xs text-warn" title="A development instance">DEV</span> : null}
      <LockNameAvatar user={user} who={who} signedIn={me?.source === 'session'} />
      {me?.source === 'session' ? <Link to="/sign-in" className="text-2xs text-dim" aria-label="My account">Account</Link> : null}
      {me?.source === 'session' && me.instance?.accounts === true ? <Link to="/account/tokens" className="text-2xs text-dim" aria-label="My API tokens" title="My API tokens">Tokens</Link> : null}
      {me?.source === 'session' && me.instance?.accounts === true && me.role === 'owner' ? <Link to="/settings/people" className="text-2xs text-dim" aria-label="People of this hub" title="People of this hub">People</Link> : null}
    </div>
  </nav>;
}
