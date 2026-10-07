import { Link, useMatches } from '@tanstack/react-router';
import { IconPlug, IconPuzzle, IconReport, IconSettings, IconTool, IconBox, IconList } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useModules } from '../modules/ModulesContext.tsx';
import { useStudio } from '../studio-context.tsx';
import { NAV_LINKS, navActive } from './navigation.ts';

const MODULE_ICONS: Readonly<Record<string, typeof IconList>> = { IconPlug, IconPuzzle, IconReport, IconSettings, IconTool, IconBox, IconList };

/** One set of available destinations in both navigation layouts. */
export function NavItems({ compact, onNavigate }: { compact?: boolean; onNavigate?: () => void }): JSX.Element {
  const matches = useMatches();
  const pathname = matches[matches.length - 1]?.pathname ?? '';
  const registry = useModules();
  const { me } = useStudio();
  const className = (active: boolean): string => `${compact ? 'cs-nav-item' : 'cs-mobile-nav-item'} ${active ? 'cs-nav-active' : ''}`;
  return <>
    {NAV_LINKS.filter(link => {
      if (link.to === '/jobs') return registry.importers().length > 0;
      if (link.to === '/modules') return registry.panels('settings').length > 0;
      if (link.to === '/settings/people') return me?.source === 'session' && me.instance?.accounts === true && me.role === 'owner';
      if (link.to === '/account/tokens') return me?.source === 'session' && me.instance?.accounts === true;
      return true;
    }).map(({ to, label, title, icon: Icon }) => <Link key={to} to={to} aria-label={title} title={title} aria-current={navActive(pathname, to) ? 'page' : undefined} className={className(navActive(pathname, to))} onClick={onNavigate}>
      <Icon size={19} aria-hidden="true" /><span>{compact ? label : title}</span>
    </Link>)}
    {registry.routes().filter(route => route.icon !== undefined).map(route => {
      const Icon = MODULE_ICONS[route.icon ?? ''] ?? IconPuzzle;
      const active = pathname === `/m/${route.module}/${route.path}`;
      return <Link key={`${route.module}/${route.path}`} to="/m/$module/$" params={{ module: route.module, _splat: route.path }} aria-label={route.label} title={route.label} aria-current={active ? 'page' : undefined} className={className(active)} onClick={onNavigate}>
        <Icon size={19} aria-hidden="true" /><span>{route.label}</span>
      </Link>;
    })}
  </>;
}
