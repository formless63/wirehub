import { Link, useRouter } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';
import type { SettingsSection } from '../settings-sections.ts';

export type ExtensionsTab = 'browse' | 'installed' | 'sources';

/** Panels also render outside the SPA (tests/hosts); use client navigation when available. */
export function AppLink({ to, section, tab, children, className }: { to: '/settings' | '/extensions'; section?: SettingsSection; tab?: ExtensionsTab; children: ReactNode; className?: string }): JSX.Element {
  const router = useRouter({ warn: false });
  if (router === undefined || router === null) {
    const query = to === '/settings' ? (section === undefined ? '' : `?section=${section}`) : tab === undefined ? '' : `?tab=${tab}`;
    return <a href={`${to}${query}`} className={className}>{children}</a>;
  }
  if (to === '/settings') return <Link to="/settings" search={section === undefined ? {} : { section }} className={className}>{children}</Link>;
  return <Link to="/extensions" search={tab === undefined ? {} : { tab }} className={className}>{children}</Link>;
}
