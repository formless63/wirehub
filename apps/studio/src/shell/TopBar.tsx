/**
 * The 44px top bar — logo + wordmark, breadcrumb (with the cable menu),
 * the Build/Schematic/Documents switch, quick-open search,
 * undo/redo, the Make-variant menu, Save, the
 * overflow menu, the git backup indicator (`BackupIndicator`)
 * and the theme toggle.
 *
 * The breadcrumb and the switch read the current match for `cableRoute`
 * rather than taking props, so the top bar can live at the root layout (one
 * `<Shell>` for every route) without every route threading its cable state
 * up through it. Everything past Save/undo/redo/the menus reads
 * `useEditorChrome()` — the bridge to `CableRoute`'s `chrome="host"`
 * `<CableEditor>` (`shell/editor-chrome.tsx`) — instead of `studio-context`,
 * since none of it is persistence or routing state.
 */

import { Link, useMatches, useNavigate } from '@tanstack/react-router';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDotsVertical,
  IconGitBranch,
  IconMenu2,
  IconMoon,
  IconPencil,
  IconPlug,
  IconPlugOff,
  IconRotate2,
  IconSearch,
  IconSun,
  IconTrash,
} from '@tabler/icons-react';
import { DropdownMenu } from 'radix-ui';
import type { JSX, ReactNode } from 'react';

import { QUICK_OPEN_COMMAND_ID } from '../commands/CommandPalette.tsx';
import { useCommandRegistry } from '../commands/registry.tsx';
import { formatShortcut } from '../commands/shortcuts.ts';
import { StudioMark, Wordmark } from './Wordmark.tsx';
import { BackupIndicator } from './BackupIndicator.tsx';
import { cableRoute, type CableSearch, type CableView } from '../router.tsx';
import { swappableStocks } from '@wirehub/editor-react';
import { useStudio } from '../studio-context.tsx';
import { useEditorChrome } from './editor-chrome.tsx';
import { designProducts } from '../cable-list.ts';
import { ProductChips } from './ProductChips.tsx';
import { StatusChip } from './StatusChip.tsx';
import { ReleaseChip } from '../versions/ReleaseChip.tsx';
import { HistoryButton } from '../history/HistoryPanel.tsx';
import { pageTitle } from './navigation.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { designRecord } from '../locks/records.ts';

const VIEWS: readonly { key: CableView; label: string }[] = [
  { key: 'build', label: 'Build' },
  { key: 'schematic', label: 'Schematic' },
  { key: 'documents', label: 'Documents' },
];

const MENU_CONTENT =
  'z-50 min-w-[180px] rounded-md border border-line2 bg-panel py-1 text-sm text-ink shadow-[var(--shadow)]';
const MENU_ITEM =
  'flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-default data-[disabled]:text-faint data-[disabled]:opacity-60';
const MENU_ITEM_DANGER = 'text-err data-[highlighted]:bg-hover';

function IconButton(props: {
  icon: ReactNode;
  title: string;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink disabled:cursor-default disabled:text-faint disabled:opacity-50 disabled:hover:text-faint"
    >
      {props.icon}
    </button>
  );
}

export function TopBar(props: { onOpenNav?: () => void }): JSX.Element {
  const studio = useStudio();
  // Make variant is offered only where some other stock accepts this cable's trunk
  const canMakeVariant = studio.design !== undefined && swappableStocks(studio.design, studio.db).length > 0;
  const matches = useMatches();
  const navigate = useNavigate();
  const registry = useCommandRegistry();
  const chrome = useEditorChrome();

  const pathname = matches[matches.length - 1]?.pathname ?? '';
  const modules = useModules();
  const moduleTitle = modules.routes().find(route => pathname === `/m/${route.module}/${route.path}`)?.label;
  const cableMatch = matches.find((match) => match.routeId === cableRoute.id);


  const cableId = cableMatch === undefined ? undefined : (cableMatch.params as { id: string }).id;
  const search = cableMatch === undefined ? undefined : (cableMatch.search as CableSearch);
  // the open cable could not be loaded: its build-time copy is shown read-only, never saved
  const offlineCopy = cableId !== undefined && studio.cableId === cableId && studio.loadError !== undefined;
  const label = cableId !== undefined && studio.cableId === cableId ? (studio.design?.label ?? studio.offlineCopy?.label) : undefined;
  const dirty = cableId !== undefined && studio.dirtyIds.includes(cableId);

  // the editor's own imperative handle — `null` until `CableRoute` mounts a
  // `chrome="host"` `<CableEditor>` for this id (still loading, or no cable
  // open at all), so every control below is disabled/hidden until then
  const handle = chrome.handle;
  const chromeState = chrome.state;
  const workspaceReady = cableId !== undefined && handle !== null;

  const undoTitle = chromeState.canUndo
    ? `Undo: ${chromeState.undoLabel} — ${formatShortcut('Ctrl+Z')}`
    : 'Nothing to undo';
  const redoTitle = chromeState.canRedo
    ? `Redo: ${chromeState.redoLabel} — ${formatShortcut('Ctrl+Shift+Z')}`
    : 'Nothing to redo';

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel pr-2.5 max-sm:gap-1.5">
      {/* portrait phone widths: the rail hides itself
          below `sm`, so this is where Cables/Library moves to */}
      <button
        type="button"
        onClick={props.onOpenNav}
        title="Navigation"
        aria-label="Navigation"
        className="hidden h-11 w-9 shrink-0 items-center justify-center border-0 bg-transparent text-dim hover:text-ink max-sm:flex"
      >
        <IconMenu2 size={18} />
      </button>
      <Link to="/cables" aria-label="WireHub home" title="Designs" className="cs-home-mark flex h-11 shrink-0 items-center justify-center border-r border-line max-sm:border-r-0">
        <StudioMark />
      </Link>
      <Link to="/cables" aria-label="WireHub home wordmark" title="Designs" className="max-sm:hidden"><Wordmark className="text-lg" /></Link>
      <span className="h-[18px] w-px shrink-0 bg-line2 max-sm:hidden" aria-hidden="true" />

      {cableId !== undefined ? (
        <nav aria-label="breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          {/* the crumb is the first thing to go once space is tight — the
              title itself gets priority */}
          <Link to="/cables" className="shrink-0 text-dim no-underline hover:text-ink max-[1300px]:hidden max-sm:hidden">
            Designs
          </Link>
          <span className="shrink-0 text-faint max-[1300px]:hidden max-sm:hidden">/</span>
          <span
            className="min-w-0 flex-1 truncate font-medium text-ink max-sm:max-w-[96px]"
            title={label ?? cableId}
            aria-label={label ?? cableId}
          >
            {label ?? cableId}
          </span>
          <ProductChips products={designProducts(studio.db.products, cableId)} />
          <StatusChip status={cableId !== undefined && studio.cableId === cableId ? studio.design?.status : undefined} />
          {/* contract-manufactured (310/311): a generic badge, never a partner's name */}
          <ReleaseChip id={cableId} rev={search?.rev} />
          {/* the cable's change history: who changed what, and restore an earlier state */}
          <HistoryButton
            compact
            subject={designRecord(cableId)}
            label={`design ${cableId}`}
            {...(dirty ? { restoreBlocked: 'Save or discard your edits first — a restore replaces the saved design' } : {})}
            onRestored={(answer) => {
              if (answer.value !== undefined && studio.cableId === cableId) studio.reloadCable(answer.value as Parameters<typeof studio.reloadCable>[0]);
            }}
          />
          {dirty ? (
            <span
              title="Unsaved changes"
              aria-label="Unsaved changes"
              className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"
            />
          ) : null}

          {/* the design menu: rename/duplicate/delete/revert, per the mockup's
              chevron right after the breadcrumb label */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                disabled={!workspaceReady}
                title="Design menu"
                aria-label="Design menu"
                className="flex h-6 w-5 shrink-0 items-center justify-center rounded border-0 bg-transparent text-dim hover:text-ink disabled:cursor-default disabled:opacity-40"
              >
                <IconChevronDown size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CONTENT}>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => handle?.openLifecycle('rename')}
                >
                  <IconPencil size={14} />
                  Rename…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => handle?.openLifecycle('duplicate')}
                >
                  <IconCopy size={14} />
                  Duplicate…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  disabled={!canMakeVariant}
                  title="Copy this design onto another wire stock"
                  onSelect={() => handle?.openLifecycle('variant')}
                >
                  <IconGitBranch size={14} />
                  Make variant…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  title="Add the joints the signal tags settle, after you review them"
                  onSelect={() => handle?.connectKnownPins()}
                >
                  <IconPlug size={14} />
                  Connect known pins…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  disabled={!chromeState.dirty}
                  onSelect={() => handle?.revert()}
                >
                  <IconRotate2 size={14} />
                  Revert
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  className={`${MENU_ITEM} ${MENU_ITEM_DANGER}`}
                  onSelect={() => handle?.openLifecycle('delete')}
                >
                  <IconTrash size={14} />
                  Delete…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </nav>
      ) : (
        <>
          <span data-testid="section-title" className="truncate text-sm font-medium text-ink">
            {moduleTitle ?? pageTitle(pathname)}
          </span>
        </>
      )}

      {cableId !== undefined && search !== undefined ? (
        <div
          role="tablist"
          aria-label="workspace view"
          className="flex shrink-0 gap-0.5 rounded-md border border-line bg-raised p-0.5 max-sm:hidden"
        >
          {VIEWS.map(({ key, label: viewLabel }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={search.view === key}
              onClick={() =>
                void navigate({
                  to: cableRoute.id,
                  params: { id: cableId },
                  search: (prev: CableSearch) => ({ ...prev, view: key }),
                })
              }
              className={
                search.view === key
                  ? 'h-[22px] rounded border border-line2 bg-panel px-2.5 text-xs font-semibold text-ink'
                  : 'h-[22px] rounded border border-transparent bg-transparent px-2.5 text-xs font-normal text-dim'
              }
            >
              {viewLabel}
            </button>
          ))}
        </div>
      ) : null}

      {/* portrait phone widths: the segmented control
          above does not fit — a compact "Build ▾" menu replaces it, same
          three destinations */}
      {cableId !== undefined && search !== undefined ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="hidden h-7 shrink-0 items-center gap-1 rounded-md border border-line2 bg-raised px-2 text-xs font-medium text-ink max-sm:flex"
            >
              {VIEWS.find((v) => v.key === search.view)?.label ?? 'Build'}
              <IconChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="center" sideOffset={6} className={MENU_CONTENT}>
              {VIEWS.map(({ key, label: viewLabel }) => (
                <DropdownMenu.Item
                  key={key}
                  className={MENU_ITEM}
                  onSelect={() =>
                    void navigate({
                      to: cableRoute.id,
                      params: { id: cableId },
                      search: (prev: CableSearch) => ({ ...prev, view: key }),
                    })
                  }
                >
                  {search.view === key ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
                  {viewLabel}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}

      <button
        type="button"
        onClick={() => registry.run(QUICK_OPEN_COMMAND_ID)}
        title="Search and quick open — Ctrl K"
        aria-label="Search and quick open"
        className={
          // a cable is open: the title needs the room, so the search box
          // stays icon-only (its full form returns on the Cables/Library
          // pages, where nothing competes with it)
          cableId === undefined
            ? 'flex h-7 w-[200px] shrink-0 items-center gap-2 rounded-md border border-line2 bg-bg px-2 text-sm text-faint max-sm:w-7 max-sm:justify-center max-sm:px-0'
            : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line2 bg-bg px-0 text-sm text-faint'
        }
      >
        <IconSearch size={14} />
        {cableId !== undefined ? null : (
          <>
            <span className="grow text-left max-sm:hidden">Search</span>
            <kbd className="rounded border border-line2 px-1.5 font-mono text-2xs text-faint max-sm:hidden">
              Ctrl K
            </kbd>
          </>
        )}
      </button>

      {cableId === undefined ? null : (
        <>
          {/* portrait phone widths: undo/redo and the
              variant menu move into the overflow ("More") menu below instead
              of three more icon buttons the top bar has no room for */}
          <span className="contents max-sm:hidden">
            <IconButton
              icon={<IconArrowBackUp size={16} />}
              title={undoTitle}
              disabled={!workspaceReady || !chromeState.canUndo}
              onClick={() => handle?.undo()}
            />
          </span>
          <span className="contents max-sm:hidden">
            <IconButton
              icon={<IconArrowForwardUp size={16} />}
              title={redoTitle}
              disabled={!workspaceReady || !chromeState.canRedo}
              onClick={() => handle?.redo()}
            />
          </span>

          {search?.rev !== undefined || offlineCopy ? null : (
          <button
            type="button"
            disabled={!workspaceReady || !chromeState.dirty || chromeState.saving}
            title={chromeState.dirty ? 'Save — Ctrl S' : 'Nothing has changed since the last save'}
            onClick={() => handle?.save()}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-accent px-2.5 text-sm font-semibold text-accent-ink disabled:cursor-default disabled:bg-raised disabled:text-faint max-sm:w-7 max-sm:justify-center max-sm:px-0"
          >
            <span className="max-sm:hidden">{chromeState.saving ? 'Saving…' : 'Save'}</span>
            <span className="hidden max-sm:inline">{chromeState.saving ? '…' : 'S'}</span>
            <kbd className="rounded border border-current/30 px-1 font-mono text-2xs font-normal opacity-80 max-sm:hidden">
              Ctrl S
            </kbd>
          </button>
          )}

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                disabled={!workspaceReady}
                title="More"
                aria-label="More"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink disabled:cursor-default disabled:opacity-40"
              >
                <IconDotsVertical size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
                {/* portrait phone widths only — the
                    standalone icon buttons above are `max-sm:hidden`, so
                    these are the only way to reach undo/redo/variants there */}
                <DropdownMenu.Item
                  className={`${MENU_ITEM} sm:hidden`}
                  disabled={!chromeState.canUndo}
                  onSelect={() => handle?.undo()}
                >
                  <IconArrowBackUp size={14} />
                  {chromeState.canUndo ? `Undo ${chromeState.undoLabel}` : 'Undo'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={`${MENU_ITEM} sm:hidden`}
                  disabled={!chromeState.canRedo}
                  onSelect={() => handle?.redo()}
                >
                  <IconArrowForwardUp size={14} />
                  {chromeState.canRedo ? `Redo ${chromeState.redoLabel}` : 'Redo'}
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-line hidden max-sm:block" />
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => handle?.openLifecycle('rename')}
                >
                  Rename…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => handle?.openLifecycle('duplicate')}
                >
                  Duplicate…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  disabled={!canMakeVariant}
                  onSelect={() => handle?.openLifecycle('variant')}
                >
                  Make variant…
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  className={`${MENU_ITEM} ${MENU_ITEM_DANGER}`}
                  onSelect={() => handle?.openLifecycle('delete')}
                >
                  Delete…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      )}

      <BackupIndicator compact={cableId !== undefined} />

      {studio.apiOffline ? (
        <span
          role="status"
          title="WireHub could not reach the server. Showing the designs this page was built with — retries on every navigation."
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line2 bg-raised px-2 text-2xs font-medium text-warn"
        >
          <IconPlugOff size={13} />
          Offline
        </span>
      ) : null}

      <button
        type="button"
        onClick={studio.toggleTheme}
        title={studio.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={studio.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:text-ink"
      >
        {studio.theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
      </button>
    </header>
  );
}
