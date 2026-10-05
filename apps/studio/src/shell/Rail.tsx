/**
 * The 48px left rail — Cables and Library section icons (tooltips via
 * `title`, per the studio-workbench UX rule: no on-page explanatory text) and
 * the user's initials pinned to the bottom. No placeholder icons for sections
 * that do not exist yet.
 */

import { Link, useMatches } from '@tanstack/react-router';
import { IconBox, IconBuilding, IconListNumbers, IconChecklist, IconHistory, IconKey, IconList, IconPlug, IconPuzzle, IconReport, IconSettings, IconTool, IconUsers } from '@tabler/icons-react';
import type { JSX } from 'react';

import { LockNameAvatar } from '../locks/LockNameAvatar.tsx';
import { useModules } from '../modules/ModulesContext.tsx';
import { useStudio } from '../studio-context.tsx';

type Section = 'cables' | 'library';

const SECTIONS: readonly { to: '/cables' | '/library'; label: string; icon: typeof IconList; section: Section }[] = [
  { to: '/cables', label: 'Cables', icon: IconList, section: 'cables' },
  { to: '/library', label: 'Library — connectors, boards, wire, components', icon: IconBox, section: 'library' },
];

/** the Tabler icons a module route may name (`UiRouteContribution.icon`); anything else is a puzzle piece */
const MODULE_ICONS: Readonly<Record<string, typeof IconList>> = { IconPlug, IconPuzzle, IconReport, IconSettings, IconTool, IconBox, IconList };

const railIcon = (active: boolean): string =>
  active
    ? 'flex h-[34px] w-[34px] items-center justify-center rounded-md border-0 bg-accent-soft text-accent'
    : 'flex h-[34px] w-[34px] items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink';

export function Rail(): JSX.Element {
  const matches = useMatches();
  // `GET /api/me`: the session user with the login on, else the local user
  const { user, me } = useStudio();
  const who = me?.email === undefined ? user : `${user} <${me.email}>`;
  const registry = useModules();
  const moduleRoutes = registry.routes().filter((r) => r.icon !== undefined);
  const hasImporters = registry.importers().length > 0;
  const hasSettings = registry.panels('settings').length > 0;
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
      {moduleRoutes.map((r) => {
        const Icon = MODULE_ICONS[r.icon ?? ''] ?? IconPuzzle;
        return (
          <Link key={`${r.module}/${r.path}`} to="/m/$module/$" params={{ module: r.module, _splat: r.path }} aria-label={r.label} title={r.label} className={railIcon(pathname === `/m/${r.module}/${r.path}`)}>
            <Icon size={18} />
          </Link>
        );
      })}
      <span className="grow" />
      <Link to="/history" aria-label="History" title="History — who changed what, and when" className={railIcon(pathname === '/history')}>
        <IconHistory size={18} />
      </Link>
      {hasImporters ? (
        <Link to="/jobs" aria-label="Jobs" title="Jobs — imports to review and publish, model builds" className={railIcon(pathname === '/jobs')}>
          <IconChecklist size={18} />
        </Link>
      ) : null}
      <Link to="/part-numbers" aria-label="Part numbers" title="Part numbers — duplicates, unnumbered, disagreements" className={railIcon(pathname === '/part-numbers')}>
        <IconListNumbers size={18} />
      </Link>
      <Link to="/settings" aria-label="Hub settings" title="Hub settings — organisation, logo, rights line" className={railIcon(pathname === '/settings')}>
        <IconBuilding size={18} />
      </Link>
      {hasSettings ? (
        <Link to="/modules" aria-label="Modules" title="Modules and their settings" className={railIcon(pathname === '/modules')}>
          <IconSettings size={18} />
        </Link>
      ) : null}
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
