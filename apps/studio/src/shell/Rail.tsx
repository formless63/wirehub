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
      {me?.instance?.env === 'dev' ? <span className="text-[9px] text-warn" title="A development instance">DEV</span> : null}
      <LockNameAvatar user={user} who={who} signedIn={me?.source === 'session'} />
      {me?.source === 'session' ? <Link to="/sign-in" className="text-[10px] text-dim" aria-label="My account">Account</Link> : null}
    </div>
  </nav>;
}
