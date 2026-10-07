/** Shared destinations and page titles for desktop and mobile navigation. */
import { IconBox, IconBuilding, IconChecklist, IconHistory, IconKey, IconList, IconListNumbers, IconPackages, IconRoute, IconSettings, IconShoppingBag, IconUsers } from '@tabler/icons-react';

export const NAV_LINKS = [
  { to: '/cables', label: 'Cables', title: 'Cables', icon: IconList },
  { to: '/library', label: 'Library', title: 'Library', icon: IconBox },
  { to: '/library/store', label: 'Store', title: 'Store', icon: IconShoppingBag },
  { to: '/resolver', label: 'Find cable', title: 'Which cable do I need?', icon: IconRoute },
  { to: '/products', label: 'Products', title: 'Products', icon: IconPackages },
  { to: '/history', label: 'History', title: 'History', icon: IconHistory },
  { to: '/jobs', label: 'Jobs', title: 'Jobs', icon: IconChecklist },
  { to: '/part-numbers', label: 'Numbers', title: 'Part numbers', icon: IconListNumbers },
  { to: '/settings', label: 'Settings', title: 'Hub settings', icon: IconBuilding },
  { to: '/modules', label: 'Modules', title: 'Modules and their settings', icon: IconSettings },
  { to: '/settings/people', label: 'People', title: 'People of this hub', icon: IconUsers },
  { to: '/account/tokens', label: 'API tokens', title: 'My API tokens', icon: IconKey },
] as const;

export function navActive(pathname: string, to: string): boolean {
  if (to === '/library') return pathname.startsWith('/library') && !pathname.startsWith('/library/store');
  if (to === '/settings') return pathname === '/settings';
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function pageTitle(pathname: string): string {
  if (pathname === '/sign-in') return 'My account';
  if (pathname === '/setup') return 'Set up WireHub';
  return NAV_LINKS.find(link => navActive(pathname, link.to))?.title ?? 'WireHub';
}
