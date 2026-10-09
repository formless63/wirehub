/**
 * The app shell — top bar, left rail, the routed page, and the status bar —
 * wrapping every route via `rootRoute` (see `router.tsx`).
 *
 * There is no banner here for "the workbench is unreachable" — that state is
 * surfaced once, compactly, as a toast plus the small indicator in `TopBar`
 * (`studio.apiOffline`), not as a paragraph pushing the page down.
 *
 * Three things mounted once here, regardless of route:
 * `AppCommands` (registers the go-to-Cables/Library, theme, view-switch and
 * New-cable commands — no visual output), `CommandPalette` (the Ctrl K
 * dialog itself) and `NewCableWizardHost` (the modal the palette's "New
 * cable" command, and the cables list's own button, both open).
 *
 * `MobileNavSheet`: `Rail` hides itself below `sm`
 * (portrait phone widths), and this slide-in stands in for it — opened from
 * `TopBar`'s hamburger button, which is itself `sm`-hidden, so nothing here
 * touches the ≥640px layout.
 */

import { useMatches } from '@tanstack/react-router';
import { useState, useCallback, useEffect, type JSX, type ReactNode } from 'react';

import { useSetupMode } from '../setup-mode.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { cableRoute } from '../router.tsx';
import { useStudio } from '../studio-context.tsx';
import { pageTitle } from './navigation.ts';

import { AppCommands } from '../commands/AppCommands.tsx';
import { CommandPalette } from '../commands/CommandPalette.tsx';
import { EditorCommands } from '../commands/EditorCommands.tsx';
import { EditorChromeProvider } from './editor-chrome.tsx';
import { MobileNavSheet } from './MobileNavSheet.tsx';
import { NewCableWizardHost } from './NewCableWizardHost.tsx';
import { Rail } from './Rail.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TopBar } from './TopBar.tsx';

/** The tab title names the page (and the open design): `Designs · WireHub`. */
function useDocumentTitle(): void {
  const matches = useMatches();
  const studio = useStudio();
  const modules = useModules();
  const pathname = matches[matches.length - 1]?.pathname ?? '/';
  const cableMatch = matches.find((match) => match.routeId === cableRoute.id);
  const cableId = cableMatch === undefined ? undefined : (cableMatch.params as { id: string }).id;
  const moduleTitle = modules.routes().find((route) => pathname === `/m/${route.module}/${route.path}`)?.label;
  const design = cableId !== undefined && studio.cableId === cableId ? (studio.design?.label ?? studio.offlineCopy?.label) : undefined;
  const title = cableId !== undefined ? (design ?? cableId) : (moduleTitle ?? pageTitle(pathname));
  useEffect(() => {
    document.title = title === 'WireHub' ? 'WireHub' : `${title} · WireHub`;
  }, [title]);
}

/** First stop for the keyboard: jumps past the rail and top bar to the page. */
function SkipLink(): JSX.Element {
  return (
    <a href="#main" className="cs-ui-skip" onClick={(event) => {
      event.preventDefault();
      const main = document.getElementById('main');
      main?.focus();
      main?.scrollIntoView?.({ block: 'start' });
    }}>
      Skip to content
    </a>
  );
}

export function Shell({ children }: { children: ReactNode }): JSX.Element {
  useDocumentTitle();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  // first-run setup stands alone: no rail, no top-bar status, no palette
  if (useSetupMode()) return <main id="main" tabIndex={-1} className="h-full bg-bg text-ink">{children}</main>;
  return (
    <EditorChromeProvider>
      <div className="flex h-full flex-col overflow-hidden bg-bg text-ink">
        <SkipLink />
        <AppCommands />
        <EditorCommands />
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <div className="flex min-h-0 grow">
          <Rail />
          <main id="main" tabIndex={-1} className="min-w-0 grow overflow-hidden outline-none">{children}</main>
        </div>
        <StatusBar />
        <CommandPalette />
        <NewCableWizardHost />
        <MobileNavSheet open={navOpen} onClose={closeNav} />
      </div>
    </EditorChromeProvider>
  );
}
