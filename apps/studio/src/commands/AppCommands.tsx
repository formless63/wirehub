/**
 * App-level commands: go to Cables, go to Library,
 * toggle theme, switch view (Build/Schematic/Documents — only once a cable
 * is open), New cable. Registered once, at the shell (`Shell.tsx`), through
 * `useRegisterCommands` — the same hook's editor
 * toolbar will use for Save/undo/redo/V/H/auto-arrange. Renders nothing.
 */

import { useMemo } from 'react';
import { useMatches, useNavigate } from '@tanstack/react-router';

import { cableRoute, type CableSearch, type CableView } from '../router.tsx';
import { useStudio } from '../studio-context.tsx';
import { useRegisterCommands, type AppCommand } from './registry.tsx';
import { ALL_PAGES } from '../shell/navigation.ts';

/** extra words a page answers to in the palette */
const PAGE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  '/cables': ['design list', 'home', 'cables'],
  '/library': ['connectors', 'components', 'wire stocks', 'boards', 'parts'],
  '/part-numbers': ['pn', 'duplicate', 'unnumbered', 'numbering', 'health'],
  '/inventory': ['stock', 'lots', 'locations', 'workshop', 'reservations'],
  '/firmware': ['workshop', 'esphome', 'platformio', 'flash'],
  '/jobs': ['workshop', 'import', 'tool runs', 'queue'],
  '/explore': ['alternatives', 'combinations', 'configurations'],
  '/resolver': ['find', 'devices', 'connect'],
  '/account/tokens': ['mcp', 'api', 'agent', 'token'],
};

const VIEWS: readonly { key: CableView; label: string }[] = [
  { key: 'build', label: 'Build' },
  { key: 'schematic', label: 'Schematic' },
  { key: 'documents', label: 'Documents' },
  { key: 'device', label: 'Device' },
];

/** No visual output — `useRegisterCommands` is the only effect. */
export function AppCommands(): null {
  const studio = useStudio();
  const navigate = useNavigate();
  const matches = useMatches();

  const cableMatch = matches.find((match) => match.routeId === cableRoute.id);
  const cableId = cableMatch === undefined ? undefined : (cableMatch.params as { id: string }).id;
  const search = cableMatch === undefined ? undefined : (cableMatch.search as CableSearch);

  const commands = useMemo<AppCommand[]>(() => {
    const list: AppCommand[] = [
      // every page, sub-pages included (`shell/navigation.ts`): the palette reaches all of them
      ...ALL_PAGES.map((page): AppCommand => ({
        id: `nav.${page.to.slice(1).replace(/\//g, '.')}`,
        title: `Go to ${page.title}`,
        keywords: [...(PAGE_KEYWORDS[page.to] ?? []), ...(page.hint === undefined ? [] : [page.hint.toLowerCase()])],
        run: () => void navigate({ to: page.to }),
      })),
      {
        id: 'nav.setup',
        title: 'Set up domain modules',
        keywords: ['setup', 'modules', 'domains', 'packs', 'video', 'automotive'],
        run: () => void navigate({ to: '/setup' }),
      },
      {
        id: 'nav.settings.identity',
        title: 'Hub settings (organisation, logo, rights line)',
        keywords: ['branding', 'organisation', 'logo', 'title block', 'identity'],
        run: () => void navigate({ to: '/settings' }),
      },
      {
        id: 'view.theme.toggle',
        title: studio.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: ['theme', 'dark', 'light', 'appearance'],
        run: studio.toggleTheme,
      },
      {
        id: 'file.newCable',
        title: 'New design',
        keywords: ['create', 'wizard'],
        run: studio.openNewCableWizard,
      },
    ];

    if (cableId !== undefined && search !== undefined) {
      const openId = cableId;
      const currentView = search.view;
      for (const view of VIEWS) {
        list.push({
          id: `view.switch.${view.key}`,
          title: `Switch to ${view.label} view`,
          keywords: ['view', view.key],
          enabled: () => currentView !== view.key,
          run: () =>
            void navigate({
              to: cableRoute.id,
              params: { id: openId },
              search: (prev: CableSearch) => ({ ...prev, view: view.key }),
            }),
        });
      }
    }

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, studio.theme, studio.toggleTheme, studio.openNewCableWizard, cableId, search?.view]);

  useRegisterCommands(commands);
  return null;
}
