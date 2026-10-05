/**
 * The left rail's stand-in at portrait phone widths:
 * `Rail` (48px, always visible on desktop) is hidden below `sm` — see its
 * own `max-sm:hidden` — and this slide-in sheet takes over Cables/Library
 * navigation instead of squeezing it permanently onto the canvas. Desktop
 * never mounts this open (`Shell` only flips it from the hamburger button
 * that is itself `max-sm:` only), so there is nothing here that can affect
 * the ≥640px layout.
 */

import { Link, useMatches } from '@tanstack/react-router';
import { IconBox, IconHistory, IconList, IconX } from '@tabler/icons-react';
import { useEffect, type JSX } from 'react';

import { useModules } from '../modules/ModulesContext.tsx';
import { Wordmark } from './Wordmark.tsx';

const LINKS = [
  { to: '/cables' as const, label: 'Cables', icon: IconList },
  { to: '/library' as const, label: 'Library', icon: IconBox },
  { to: '/history' as const, label: 'History', icon: IconHistory },
];

export function MobileNavSheet(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props;
  const matches = useMatches();
  const registry = useModules();
  const moduleRoutes = registry.routes().filter((r) => r.icon !== undefined);
  const hasImporters = registry.importers().length > 0;
  const pathname = matches[matches.length - 1]?.pathname ?? '';

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Navigation" className="fixed inset-0 z-50 hidden max-sm:block">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 border-0 bg-black/45 p-0"
      />
      <nav className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col gap-1 border-r border-line bg-panel p-2 shadow-[var(--shadow)]">
        <div className="flex items-center justify-between px-1.5 py-1.5">
          <Wordmark className="text-[13px]" />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-dim"
          >
            <IconX size={16} />
          </button>
        </div>
        {LINKS.map(({ to, label, icon: Icon }) => {
          const active = pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              onClick={onClose}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] no-underline ${
                active ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-hover'
              }`}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
        {moduleRoutes.map((r) => (
          <Link
            key={`${r.module}/${r.path}`}
            to="/m/$module/$"
            params={{ module: r.module, _splat: r.path }}
            onClick={onClose}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] no-underline ${
              pathname === `/m/${r.module}/${r.path}` ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-hover'
            }`}
          >
            {r.label}
          </Link>
        ))}
        {hasImporters ? (
          <Link
            to="/jobs"
            onClick={onClose}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] no-underline ${pathname === '/jobs' ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-hover'}`}
          >
            Jobs
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
