/**
 * The 48px left rail — Cables and Library section icons (tooltips via
 * `title`, per the studio-workbench UX rule: no on-page explanatory text) and
 * the user's initials pinned to the bottom. No placeholder icons for sections
 * that do not exist yet.
 */

import { Link, useMatches } from '@tanstack/react-router';
import { IconBox, IconKey, IconList, IconUsers } from '@tabler/icons-react';
import type { JSX } from 'react';

import { LockNameAvatar } from '../locks/LockNameAvatar.tsx';
import { useStudio } from '../studio-context.tsx';

type Section = 'cables' | 'library';

const SECTIONS: readonly { to: '/cables' | '/library'; label: string; icon: typeof IconList; section: Section }[] = [
  { to: '/cables', label: 'Cables', icon: IconList, section: 'cables' },
  { to: '/library', label: 'Library — connectors, boards, wire, components', icon: IconBox, section: 'library' },
];

const railIcon = (active: boolean): string =>
  active
    ? 'flex h-[34px] w-[34px] items-center justify-center rounded-md border-0 bg-accent-soft text-accent'
    : 'flex h-[34px] w-[34px] items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink';

export function Rail(): JSX.Element {
  const matches = useMatches();
  // `GET /api/me`: the session user with the login on, else the local user
  const { user, me } = useStudio();
  const who = me?.email === undefined ? user : `${user} <${me.email}>`;
  const pathname = matches[matches.length - 1]?.pathname ?? '';
  const active: Section | undefined = pathname.startsWith('/library')
    ? 'library'
    : pathname.startsWith('/cables')
      ? 'cables'
      : undefined;

  return (
    <nav
      aria-label="sections"
      // portrait phone widths: `MobileNavSheet`, opened
      // from `TopBar`'s hamburger, takes over below `sm` — there is no room
      // for a permanent 48px rail beside a canvas that is already tight
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-rail py-2 max-sm:hidden"
    >
      {SECTIONS.map(({ to, label, icon: Icon, section }) => (
        <Link key={to} to={to} aria-label={label} title={label} className={railIcon(active === section)}>
          <Icon size={18} />
        </Link>
      ))}
      <span className="grow" />
      {me?.instance?.env === 'dev' ? (
        <span title="A development instance: its data is a copy, not production" className="rounded bg-warn px-1 text-[9px] font-bold uppercase tracking-wide text-accent-ink">
          dev
        </span>
      ) : null}
      {me?.source === 'session' && me.instance?.accounts === true ? (
        <>
          <a href="/settings/people" aria-label="People of this hub" title="People of this hub" className={railIcon(false)}>
            <IconUsers size={18} />
          </a>
          <a href="/account/tokens" aria-label="My API tokens" title="My API tokens" className={railIcon(false)}>
            <IconKey size={18} />
          </a>
        </>
      ) : null}
      {/* with the login off, also where this browser names itself for edit locks */}
      <LockNameAvatar user={user} who={who} signedIn={me?.source === 'session'} />
    </nav>
  );
}
