/** Shared destinations and page titles for desktop and mobile navigation. */
import { IconBox, IconChecklist, IconHistory, IconKey, IconList, IconListNumbers, IconPackages, IconPuzzle, IconRoute, IconSettings, IconUser } from '@tabler/icons-react';

/**
 * The rail is grouped: Work (the hub's content), Activity (what happened and what is running),
 * and at the bottom Extensions, Settings and the avatar menu. At most eight items plus the avatar;
 * a module's route joins the rail only when the owner allows it (`modules/placement.ts`).
 */
export type NavGroup = 'work' | 'activity' | 'bottom';

export const NAV_LINKS = [
  { to: '/cables', label: 'Designs', title: 'Designs', icon: IconList, group: 'work' },
  { to: '/library', label: 'Library', title: 'Library', icon: IconBox, group: 'work' },
  { to: '/resolver', label: 'Find a design', title: 'Find a design', icon: IconRoute, group: 'work' },
  { to: '/products', label: 'Products', title: 'Products', icon: IconPackages, group: 'work' },
  { to: '/history', label: 'History', title: 'History', icon: IconHistory, group: 'activity' },
  { to: '/jobs', label: 'Jobs', title: 'Jobs', icon: IconChecklist, group: 'activity' },
  { to: '/extensions', label: 'Extensions', title: 'Extensions', icon: IconPuzzle, group: 'bottom' },
  { to: '/settings', label: 'Settings', title: 'Settings', icon: IconSettings, group: 'bottom' },
] as const satisfies readonly { to: string; label: string; title: string; icon: unknown; group: NavGroup }[];

export const NAV_GROUP_LABEL: Readonly<Record<NavGroup, string>> = { work: 'Work', activity: 'Activity', bottom: 'Hub' };

/** destinations that are reached from elsewhere (the Library, the avatar menu), with their page titles */
export const OTHER_PAGES = [
  { to: '/part-numbers', title: 'Part numbers', icon: IconListNumbers },
  { to: '/sign-in', title: 'My account', icon: IconUser },
  { to: '/account/tokens', title: 'API tokens', icon: IconKey },
] as const;

export function navActive(pathname: string, to: string): boolean {
  if (to === '/library') return pathname.startsWith('/library');
  if (to === '/settings') return pathname.startsWith('/settings');
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function pageTitle(pathname: string): string {
  if (pathname === '/setup') return 'Set up WireHub';
  const other = OTHER_PAGES.find((page) => pathname === page.to);
  if (other !== undefined) return other.title;
  return NAV_LINKS.find((link) => navActive(pathname, link.to))?.title ?? 'WireHub';
}
