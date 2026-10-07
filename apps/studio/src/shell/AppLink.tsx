import { Link, useRouter } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';
import type { SettingsSection } from '../settings-sections.ts';

/** Store panels also render outside the SPA (tests/hosts); use client navigation when available. */
export function AppLink({ to, section, children, className }: { to: '/settings' | '/modules' | '/library/store'; section?: SettingsSection; children: ReactNode; className?: string }): JSX.Element {
  const router = useRouter({ warn: false });
  if (router === undefined || router === null) return <a href={`${to}${section === undefined ? '' : `?section=${section}`}`} className={className}>{children}</a>;
  if (to === '/settings') return <Link to="/settings" search={section === undefined ? {} : { section }} className={className}>{children}</Link>;
  return <Link to={to} className={className}>{children}</Link>;
}
