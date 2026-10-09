import { Link, useMatches } from '@tanstack/react-router';
import { IconPlug, IconPuzzle, IconReport, IconSettings, IconTool, IconBox, IconList } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useModules } from '../modules/ModulesContext.tsx';
import { useStudio } from '../studio-context.tsx';
import { useRailModules } from '../hooks/useRailModules.ts';
import { routesIn } from '../modules/placement.ts';
import { NAV_GROUP_LABEL, NAV_LINKS, navActive, type NavGroup } from './navigation.ts';

const MODULE_ICONS: Readonly<Record<string, typeof IconList>> = { IconPlug, IconPuzzle, IconReport, IconSettings, IconTool, IconBox, IconList };

/**
 * The available destinations of one group, in the rail (`compact`) or the phone menu.
 * `groups` picks which groups to draw; each is a labelled group of links.
 */
export function NavItems({ compact, onNavigate, groups = ['work', 'activity', 'bottom'] }: { compact?: boolean; onNavigate?: () => void; groups?: readonly NavGroup[] }): JSX.Element {
  const matches = useMatches();
  const pathname = matches[matches.length - 1]?.pathname ?? '';
  const registry = useModules();
  const railModules = useRailModules();
  const className = (active: boolean): string => `${compact ? 'cs-nav-item' : 'cs-mobile-nav-item'} ${active ? 'cs-nav-active' : ''}`;
  useStudio();
  return <>
    {groups.map((group) => {
      const links = NAV_LINKS.filter((link) => link.group === group && (link.to !== '/jobs' || registry.importers().length > 0));
      const moduleRoutes = group === 'work' ? routesIn(registry, 'rail', railModules) : [];
      if (links.length === 0 && moduleRoutes.length === 0) return null;
      return <div key={group} role="group" aria-label={NAV_GROUP_LABEL[group]} className="cs-nav-group" data-group={group}>
        {compact ? null : <p className="cs-nav-group-label">{NAV_GROUP_LABEL[group]}</p>}
        {links.map(({ to, label, title, icon: Icon }) => <Link key={to} to={to} aria-label={title} title={title} aria-current={navActive(pathname, to) ? 'page' : undefined} className={className(navActive(pathname, to))} onClick={onNavigate}>
          <Icon size={19} aria-hidden="true" /><span>{compact ? label : title}</span>
        </Link>)}
        {moduleRoutes.map(route => {
          const Icon = MODULE_ICONS[route.icon ?? ''] ?? IconPuzzle;
          const active = pathname === `/m/${route.module}/${route.path}`;
          return <Link key={`${route.module}/${route.path}`} to="/m/$module/$" params={{ module: route.module, _splat: route.path }} aria-label={route.label} title={route.label} aria-current={active ? 'page' : undefined} className={className(active)} onClick={onNavigate}>
            <Icon size={19} aria-hidden="true" /><span>{route.label}</span>
          </Link>;
        })}
      </div>;
    })}
  </>;
}
