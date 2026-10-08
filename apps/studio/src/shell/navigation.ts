/** Shared destinations and page titles for desktop and mobile navigation. */
import { IconBox, IconBuilding, IconChecklist, IconHistory, IconKey, IconList, IconListNumbers, IconPackages, IconRoute, IconSettings, IconShoppingBag, IconUsers } from '@tabler/icons-react';

/**
 * `rail: false` keeps a destination out of the desktop rail (it stays in the phone menu and
 * the page titles): People and API tokens sit in the rail's account block, Modules is reached
 * from the Store page and Settings. Rail items from modules are placement-gated
 * (`modules/placement.ts`).
 */
export const NAV_LINKS = [
  { to: '/cables', label: 'Cables', title: 'Cables', icon: IconList, rail: true },
  { to: '/library', label: 'Library', title: 'Library', icon: IconBox, rail: true },
  { to: '/library/store', label: 'Store', title: 'Store', icon: IconShoppingBag, rail: true },
  { to: '/resolver', label: 'Find cable', title: 'Which cable do I need?', icon: IconRoute, rail: true },
  { to: '/products', label: 'Products', title: 'Products', icon: IconPackages, rail: true },
  { to: '/history', label: 'History', title: 'History', icon: IconHistory, rail: true },
  { to: '/jobs', label: 'Jobs', title: 'Jobs', icon: IconChecklist, rail: true },
  { to: '/part-numbers', label: 'Numbers', title: 'Part numbers', icon: IconListNumbers, rail: true },
  { to: '/settings', label: 'Settings', title: 'Hub settings', icon: IconBuilding, rail: true },
  { to: '/modules', label: 'Modules', title: 'Modules and their settings', icon: IconSettings, rail: false },
  { to: '/settings/people', label: 'People', title: 'People of this hub', icon: IconUsers, rail: false },
  { to: '/account/tokens', label: 'API tokens', title: 'My API tokens', icon: IconKey, rail: false },
] as const satisfies readonly { to: string; label: string; title: string; icon: unknown; rail: boolean }[];

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
