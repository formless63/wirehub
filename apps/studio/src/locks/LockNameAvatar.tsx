/**
 * Edit locks — the rail's avatar, doubling as where a
 * browser names itself when the login is off: the name colleagues see on
 * "… is editing". Set once, kept in this browser (default "This browser").
 * With the login on, the avatar opens the person's sign-in methods.
 */

import { Link } from '@tanstack/react-router';
import { useState, type JSX } from 'react';

import { initialsOf } from '../me.browser.ts';
import { useLockClient, useLockSnapshot } from './lock-context.tsx';

const AVATAR =
  'mt-1 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-line2 bg-raised text-[11px] font-semibold text-dim';

export function LockNameAvatar({ user, who, signedIn }: { user: string; who: string; signedIn: boolean }): JSX.Element {
  const client = useLockClient();
  const snapshot = useLockSnapshot();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  if (signedIn) {
    return (
      <Link to="/sign-in" title={`${who} — sign-in methods and sign out`} aria-label="My sign-in methods" className={`${AVATAR} hover:bg-hover focus-visible:outline focus-visible:outline-accent`}>
        {initialsOf(user)}
      </Link>
    );
  }
  if (client === undefined || snapshot === undefined) {
    return (
      <span title={who} aria-label={who} className={AVATAR}>
        {initialsOf(user)}
      </span>
    );
  }
  const name = snapshot.me.name;
  const title = `Editing as “${name}” — click to change`;
  return (
    <span className="relative">
      <button
        type="button"
        title={title}
        aria-label={title}
        className={`${AVATAR} hover:bg-hover`}
        onClick={() => {
          setDraft(snapshot.me.nameSet ? name : '');
          setOpen((v) => !v);
        }}
      >
        {initialsOf(name)}
      </button>
      {open ? (
        <form
          className="absolute bottom-0 left-9 z-50 flex w-56 items-center gap-1.5 rounded-md border border-line2 bg-panel p-1.5 shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            client.setName(draft);
            setOpen(false);
          }}
        >
          <input
            aria-label="Name shown when you edit"
            autoFocus
            placeholder="This browser"
            value={draft}
            maxLength={60}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
            className="h-7 min-w-0 flex-1 rounded border border-line2 bg-raised px-2 text-[12px] text-ink outline-none focus:border-accent"
          />
          <button type="submit" className="h-7 rounded border border-line2 bg-raised px-2 text-[12px] text-ink hover:bg-hover">
            Save
          </button>
        </form>
      ) : null}
    </span>
  );
}
