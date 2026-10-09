/**
 * The 26px status bar: error/warning counts, part/joint counts and the
 * unsaved state — only on a cable's own page (the mockup's cables list and
 * library screens have no footer). Counts come from `CableEditor`'s
 * `onStatusChange` (see `CableRoute.tsx`), not re-derived here: the editor
 * already has the one true computation of what counts as an error, a part, a
 * joint. Clicking the error/warning counts opens the editor's Issues tab —
 * `EditorHandle.showIssues()`, via `useEditorChrome()`.
 */

import { useMatches } from '@tanstack/react-router';
import type { JSX } from 'react';

import { cableRoute } from '../router.tsx';
import { useStudio } from '../studio-context.tsx';
import { useEditorChrome } from './editor-chrome.tsx';

export function StatusBar(): JSX.Element | null {
  const studio = useStudio();
  const chrome = useEditorChrome();
  const matches = useMatches();
  const cableMatch = matches.find((match) => match.routeId === cableRoute.id);
  if (cableMatch === undefined) return null;

  const id = (cableMatch.params as { id: string }).id;
  if (studio.cableId !== id || studio.design === undefined) return null;

  const status = studio.editorStatus;
  const dirty = studio.dirtyIds.includes(id);
  const showIssues = (): void => chrome.handle?.showIssues();

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-xs text-dim">
      <button
        type="button"
        onClick={showIssues}
        title="Open the issues panel"
        className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-dim hover:text-ink"
      >
        <span
          aria-hidden="true"
          className={`h-[7px] w-[7px] rounded-full ${(status?.errorCount ?? 0) > 0 ? 'bg-err' : 'bg-ok'}`}
        />
        {status?.errorCount ?? 0} error{(status?.errorCount ?? 0) === 1 ? '' : 's'}
      </button>
      <button
        type="button"
        onClick={showIssues}
        title="Open the issues panel"
        className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-dim hover:text-ink"
      >
        <span
          aria-hidden="true"
          className={`h-[7px] w-[7px] rounded-full ${(status?.warningCount ?? 0) > 0 ? 'bg-warn' : 'bg-line2'}`}
        />
        {status?.warningCount ?? 0} warning{(status?.warningCount ?? 0) === 1 ? '' : 's'}
      </button>
      <span>
        {status?.partCount ?? 0} parts · {status?.jointCount ?? 0} joints
      </span>
      <span className="grow" />
      <span>{dirty ? 'Unsaved changes' : (chrome.state.statusMessage ?? 'Saved')}</span>
    </footer>
  );
}
