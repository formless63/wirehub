/** Shared destinations and page titles for desktop and mobile navigation. */
import { IconBox, IconChecklist, IconCompass, IconCpu, IconFolders, IconHistory, IconKey, IconList, IconListNumbers, IconPackages, IconPuzzle, IconRoute, IconSettings, IconStack2, IconTool, IconUser } from '@tabler/icons-react';

/**
 * The rail is grouped: Work (the hub's content), Activity (the workshop floor and what happened),
 * and at the bottom Extensions, Settings and the avatar menu. At most nine items plus the avatar;
 * a module's route joins the rail only when the owner allows it (`modules/placement.ts`).
 *
 * A rail item with `subs` is a section: it opens the sub-page last used (`sectionTarget`), and the
 * top bar shows the section's pages as a segmented switch, so every page is two clicks away.
 */
export type NavGroup = 'work' | 'activity' | 'bottom';

export interface SubPage { to: string; title: string; icon: typeof IconList; hint: string }

export const FIND_PAGES: readonly SubPage[] = [
  { to: '/resolver', title: 'Find a design', icon: IconRoute, hint: 'Ranked designs that connect two devices' },
  { to: '/explore', title: 'Combinations', icon: IconCompass, hint: 'Combinations of existing parts: valid, unknown, invalid' },
];

export const WORKSHOP_PAGES: readonly SubPage[] = [
  { to: '/inventory', title: 'Inventory', icon: IconStack2, hint: 'Stock by location, open builds, the ledger' },
  { to: '/firmware', title: 'Firmware', icon: IconCpu, hint: 'Firmware projects for boards and their placements' },
  { to: '/jobs', title: 'Jobs', icon: IconChecklist, hint: 'Imports and native tool runs' },
];

export const NAV_LINKS = [
  { to: '/cables', label: 'Designs', title: 'Designs', icon: IconList, group: 'work' },
  { to: '/library', label: 'Library', title: 'Library', icon: IconBox, group: 'work' },
  { to: '/products', label: 'Products', title: 'Products', icon: IconPackages, group: 'work' },
  { to: '/projects', label: 'Projects', title: 'Projects', icon: IconFolders, group: 'work' },
  { to: '/resolver', label: 'Find', title: 'Find', icon: IconRoute, group: 'work', subs: FIND_PAGES },
  { to: '/inventory', label: 'Workshop', title: 'Workshop', icon: IconTool, group: 'activity', subs: WORKSHOP_PAGES },
  { to: '/history', label: 'History', title: 'History', icon: IconHistory, group: 'activity' },
  { to: '/extensions', label: 'Extensions', title: 'Extensions', icon: IconPuzzle, group: 'bottom' },
  { to: '/settings', label: 'Settings', title: 'Settings', icon: IconSettings, group: 'bottom' },
] as const satisfies readonly { to: string; label: string; title: string; icon: unknown; group: NavGroup; subs?: readonly SubPage[] }[];

export type NavLink = (typeof NAV_LINKS)[number];

export const NAV_GROUP_LABEL: Readonly<Record<NavGroup, string>> = { work: 'Work', activity: 'Activity', bottom: 'Hub' };

/** destinations that are reached from elsewhere (the Library, the avatar menu), with their page titles */
export const OTHER_PAGES = [
  { to: '/part-numbers', title: 'Part numbers', icon: IconListNumbers },
  { to: '/sign-in', title: 'My account', icon: IconUser },
  { to: '/account/tokens', title: 'API tokens', icon: IconKey },
] as const;

/** every page the palette's "Go to" lists, sub-pages included */
export const ALL_PAGES: readonly { to: string; title: string; hint?: string }[] = [
  ...NAV_LINKS.flatMap((link): { to: string; title: string; hint?: string }[] => ('subs' in link ? link.subs.map((s) => ({ to: s.to, title: s.title, hint: s.hint })) : [{ to: link.to, title: link.title }])),
  ...OTHER_PAGES.map((p) => ({ to: p.to, title: p.title })),
];

const subActive = (pathname: string, to: string): boolean => pathname === to || pathname.startsWith(`${to}/`);

/** the section (a rail item with sub-pages) this path belongs to */
export function sectionOf(pathname: string): (NavLink & { subs: readonly SubPage[] }) | undefined {
  return NAV_LINKS.find((link): link is NavLink & { subs: readonly SubPage[] } => 'subs' in link && link.subs.some((s) => subActive(pathname, s.to)));
}

/** the sub-page a section's rail item opens: the one last used in this tab, else the first */
const lastSub = new Map<string, string>();
export function rememberSection(pathname: string): void {
  const section = sectionOf(pathname);
  const sub = section?.subs.find((s) => subActive(pathname, s.to));
  if (section !== undefined && sub !== undefined) lastSub.set(section.label, sub.to);
}
export function sectionTarget(link: NavLink): string {
  return 'subs' in link ? (lastSub.get(link.label) ?? link.to) : link.to;
}

export function navActive(pathname: string, to: string): boolean {
  const link = NAV_LINKS.find((l) => l.to === to);
  if (link !== undefined && 'subs' in link) return link.subs.some((s) => subActive(pathname, s.to));
  if (to === '/library') return pathname.startsWith('/library');
  if (to === '/settings') return pathname.startsWith('/settings');
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function pageTitle(pathname: string): string {
  if (pathname === '/setup') return 'Set up WireHub';
  const other = OTHER_PAGES.find((page) => pathname === page.to);
  if (other !== undefined) return other.title;
  const sub = sectionOf(pathname)?.subs.find((s) => subActive(pathname, s.to));
  if (sub !== undefined) return sub.title;
  return NAV_LINKS.find((link) => navActive(pathname, link.to))?.title ?? 'WireHub';
}
