/** The account block at the bottom of the rail: an avatar that opens My account, API tokens, Theme and Sign out. */

import { useNavigate } from '@tanstack/react-router';
import { Menu, type MenuEntry } from '@wirehub/editor-react';
import { IconKey, IconLogout, IconMoon, IconSun, IconUser } from '@tabler/icons-react';
import type { JSX } from 'react';

import { LockNameAvatar } from '../locks/LockNameAvatar.tsx';
import { initialsOf } from '../me.browser.ts';
import { useStudio } from '../studio-context.tsx';

export function AvatarMenu({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const { user, me, theme, toggleTheme } = useStudio();
  const navigate = useNavigate();
  const who = me?.email === undefined ? user : `${user} <${me.email}>`;
  const session = me?.source === 'session';
  const items: MenuEntry[] = [
    ...(session ? [{ label: 'My account', icon: <IconUser size={14} aria-hidden />, onSelect: () => { onNavigate?.(); void navigate({ to: '/sign-in' }); } }] : []),
    ...(session && me.instance?.accounts === true ? [{ label: 'API tokens', icon: <IconKey size={14} aria-hidden />, onSelect: () => { onNavigate?.(); void navigate({ to: '/account/tokens' }); } }] : []),
    { label: theme === 'dark' ? 'Light theme' : 'Dark theme', icon: theme === 'dark' ? <IconSun size={14} aria-hidden /> : <IconMoon size={14} aria-hidden />, onSelect: toggleTheme },
    ...(session
      ? [
          { type: 'separator' } as const,
          {
            label: 'Sign out',
            icon: <IconLogout size={14} aria-hidden />,
            onSelect: () => {
              void fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: '{}' }).finally(() => {
                window.location.href = '/sign-in';
              });
            },
          },
        ]
      : []),
  ];
  // with the login off the avatar is also where a browser names itself for edit locks
  const avatar = session ? (
    <button type="button" className="cs-avatar" aria-label={`Account menu, ${who}`} title={who}>
      {initialsOf(user)}
    </button>
  ) : null;
  return (
    <div className="cs-navigation-account" data-testid="avatar-menu">
      {me?.instance?.env === 'dev' ? <span className="text-2xs text-warn" title="A development instance">DEV</span> : null}
      {avatar === null ? (
        <>
          <LockNameAvatar user={user} who={who} signedIn={false} />
          <Menu aria-label="Account" items={items} align="start" trigger={<button type="button" className="cs-avatar-more" aria-label="Theme and account">{theme === 'dark' ? <IconSun size={14} aria-hidden /> : <IconMoon size={14} aria-hidden />}</button>} />
        </>
      ) : (
        <Menu aria-label="Account" items={items} align="start" trigger={avatar} />
      )}
    </div>
  );
}
