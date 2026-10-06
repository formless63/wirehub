/**
 * Quick open — cmdk inside a Radix Dialog, opened by
 * Ctrl K / Cmd K (from anywhere — `registry.tsx`'s global listener, which
 * lets Ctrl K through even while a text input has focus) or the top bar's
 * search button (`TopBar.tsx`, via `useCommandRegistry().run(QUICK_OPEN_COMMAND_ID)`).
 * Mounted once, at the shell (`Shell.tsx`).
 *
 * Three groups, matching `specs/mockups/ui-redesign/cables-quickopen-light.png`
 * and its generator's `palette`/`qRow`/`qHead`:
 *
 * - **CABLES** — `cableListKey`'s rows (label + id, fuzzy over label, id,
 *   wire and board — the same fields the `/cables` text filter reads — and
 *   every part number the cable answers to, `pn-search.ts`).
 * - **LIBRARY** — every definition in `studio.db` (connectors, components,
 *   wire stocks, boards), label + id, a kind-coloured icon.
 * - **ACTIONS** — every non-hidden `AppCommand` currently in the registry
 *   (`useCommands`), each shown with its shortcut if it has one.
 *
 * A leading `>` switches to commands-only (CABLES/LIBRARY drop out; the rest
 * of the text still filters ACTIONS) — matches the footer hint "Type > for
 * commands". Matching itself is deliberately simple — case-insensitive
 * substring over each row's fields — not a scored fuzzy algorithm; `cmdk`'s
 * own filtering is turned off (`shouldFilter={false}`) so this file decides
 * what's visible (and so empty groups can be left out entirely, which cmdk
 * itself won't do once its filtering is off).
 *
 * Enter opens the highlighted row in place; Ctrl Enter opens it in a new
 * browser tab (`window.open`, not a router navigation — genuinely a new
 * tab). Which modifier was held is read off the `keydown` itself: a
 * capture-phase handler on the dialog records `event.ctrlKey` for the
 * `Enter` that is about to trigger cmdk's own `onSelect`, since `onSelect`
 * itself is only ever given the item's value, never the keyboard event.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { Command } from 'cmdk';
import {
  IconCommand,
  IconCornerDownLeft,
  IconCpu,
  IconPlug,
  IconPackage,
  IconPlugConnected,
  IconRoute2,
  IconTool,
  IconSearch,
  IconWaveSine,
} from '@tabler/icons-react';
import type { Db } from '@wirehub/model';
import type { LibraryKind } from '@wirehub/editor-react';

import type { CableListEntry } from '../cable-list.ts';
import { matchedPartNumber, pnMatches } from '../pn-search.ts';
import { cableListKey, loadCableList } from '../queries.ts';
import { cableRoute, libraryItemRoute } from '../router.tsx';
import { useStudio } from '../studio-context.tsx';
import { formatShortcut } from './shortcuts.ts';
import { useCommandRegistry, useCommands, useRegisterCommands, type AppCommand } from './registry.tsx';

/** the command that opens/closes this palette — `TopBar.tsx`'s search button runs it by id */
export const QUICK_OPEN_COMMAND_ID = 'quick-open';

const MAX_ROWS_PER_GROUP = 8;

interface LibraryEntry {
  kind: LibraryKind;
  id: string;
  label: string;
}

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const KIND_ICON: Record<LibraryKind, IconComponent> = {
  connectors: IconPlug,
  components: IconCpu,
  wires: IconWaveSine,
  pcbas: IconRoute2,
  mechanicals: IconTool,
  kits: IconPackage,
};

const KIND_BADGE: Record<LibraryKind, string> = {
  connectors: 'bg-conn-kind',
  components: 'bg-comp-kind',
  wires: 'bg-wire-kind',
  pcbas: 'bg-board',
  mechanicals: 'bg-comp-kind',
  kits: 'bg-board',
};

function libraryEntriesOf(db: Db): LibraryEntry[] {
  return [
    ...db.connectors.map((d): LibraryEntry => ({ kind: 'connectors', id: d.id, label: d.label })),
    ...db.components.map((d): LibraryEntry => ({ kind: 'components', id: d.id, label: d.label })),
    ...db.wires.map((d): LibraryEntry => ({ kind: 'wires', id: d.id, label: d.label })),
    ...db.pcbas.map((d): LibraryEntry => ({ kind: 'pcbas', id: d.id, label: d.label })),
    ...(db.mechanicals ?? []).map((d): LibraryEntry => ({ kind: 'mechanicals', id: d.id, label: d.label })),
    ...(db.kits ?? []).map((d): LibraryEntry => ({ kind: 'kits', id: d.id, label: `${d.label} (${d.sku})` })),
  ];
}

/** case-insensitive substring match over every field — see the file header for why this isn't a scored fuzzy algorithm */
function matches(fields: readonly string[], query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="rounded border border-line2 px-[5px] font-mono text-[10.5px] leading-4 text-faint">
      {children}
    </kbd>
  );
}

/** badge + label + meta + (selected: an enter glyph · not selected: a shortcut hint, if any) — the mockup's `qRow` */
function ResultRow(props: {
  icon: IconComponent;
  badgeClass: string;
  label: string;
  meta?: string;
  shortcut?: string;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] ${props.badgeClass}`}>
        <Icon size={13} className="text-panel" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{props.label}</span>
      {props.meta !== undefined && props.meta !== '' ? (
        <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-faint">{props.meta}</span>
      ) : null}
      {props.shortcut !== undefined ? (
        <span className="shrink-0 group-data-[selected=true]:hidden">
          <Kbd>{formatShortcut(props.shortcut)}</Kbd>
        </span>
      ) : null}
      <span className="hidden shrink-0 text-faint group-data-[selected=true]:flex">
        <IconCornerDownLeft size={14} />
      </span>
    </>
  );
}

const ITEM_CLASS =
  'group flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 outline-none data-[selected=true]:bg-accent-soft';

function GroupHeading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-2.5 pb-1 pt-2.5 font-mono text-[10px] tracking-wide text-faint uppercase">{children}</div>
  );
}

export function CommandPalette(): JSX.Element {
  const studio = useStudio();
  const registry = useCommandRegistry();
  const commands = useCommands();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState('');
  const [highlighted, setHighlighted] = useState<string>('');
  /** whether Ctrl/Cmd was held on the `Enter` that is about to select the highlighted row — read inside `onSelect`, which cmdk gives no event to */
  const enterModRef = useRef(false);

  useRegisterCommands(
    useMemo<AppCommand[]>(
      () => [{ id: QUICK_OPEN_COMMAND_ID, title: 'Quick open', hidden: true, shortcut: 'Ctrl+K', run: () => setOpen((o) => !o) }],
      [],
    ),
  );

  useEffect(() => {
    if (open) setRawQuery('');
  }, [open]);

  // the same live query as /cables — no build-time first paint
  const listQuery = useQuery({
    queryKey: cableListKey,
    queryFn: loadCableList,
  });
  const cableEntries = useMemo(() => listQuery.data?.entries ?? [], [listQuery.data]);
  const libraryEntries = useMemo(() => libraryEntriesOf(studio.db), [studio.db]);

  const trimmed = rawQuery.trimStart();
  const isCommandMode = trimmed.startsWith('>');
  const commandQuery = isCommandMode ? trimmed.slice(1).trimStart() : trimmed;

  const cableResults = useMemo<CableListEntry[]>(() => {
    if (isCommandMode) return [];
    return cableEntries
      .filter(
        (entry) =>
          matches([entry.label, entry.id, ...entry.wireLabels, ...entry.boardLabels, ...(entry.productSearch ?? [])], commandQuery) ||
          // a design by any part number it answers to — drawing, length, part
          (entry.partNumbers ?? []).some((pn) => pnMatches(commandQuery, pn)),
      )
      .slice(0, MAX_ROWS_PER_GROUP);
  }, [cableEntries, isCommandMode, commandQuery]);

  const libraryResults = useMemo<LibraryEntry[]>(() => {
    if (isCommandMode) return [];
    return libraryEntries.filter((entry) => matches([entry.label, entry.id], commandQuery)).slice(0, MAX_ROWS_PER_GROUP);
  }, [libraryEntries, isCommandMode, commandQuery]);

  const actionResults = useMemo<AppCommand[]>(() => {
    return commands
      .filter((command) => !command.hidden)
      .filter((command) => command.enabled?.() !== false)
      .filter((command) => matches([command.title, ...(command.keywords ?? [])], commandQuery));
  }, [commands, commandQuery]);

  function close(): void {
    setOpen(false);
  }

  function openCablePath(id: string): string {
    return `/cables/${id}`;
  }
  function openLibraryPath(kind: string, id: string): string {
    return `/library/${kind}/${id}`;
  }

  function handleSelect(value: string): void {
    const newTab = enterModRef.current;
    enterModRef.current = false;

    if (value.startsWith('cable:')) {
      const id = value.slice('cable:'.length);
      if (newTab) window.open(openCablePath(id), '_blank', 'noopener');
      else void navigate({ to: cableRoute.id, params: { id }, search: { view: 'build' } });
      close();
      return;
    }
    if (value.startsWith('lib:')) {
      const rest = value.slice('lib:'.length);
      const sep = rest.indexOf(':');
      const kind = rest.slice(0, sep);
      const id = rest.slice(sep + 1);
      if (newTab) window.open(openLibraryPath(kind, id), '_blank', 'noopener');
      else void navigate({ to: libraryItemRoute.id, params: { kind, id } });
      close();
      return;
    }
    if (value.startsWith('cmd:')) {
      registry.run(value.slice('cmd:'.length));
      close();
    }
  }

  function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter') enterModRef.current = event.ctrlKey || event.metaKey;
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content
          onKeyDownCapture={onKeyDownCapture}
          className="fixed left-1/2 top-24 z-50 w-[620px] -translate-x-1/2 overflow-hidden rounded-[10px] border border-line2 bg-panel shadow-[var(--shadow)]"
        >
          <Dialog.Title className="sr-only">Quick open</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search cables, library definitions, and actions. Type &gt; for commands only.
          </Dialog.Description>
          <Command shouldFilter={false} value={highlighted} onValueChange={setHighlighted} loop label="Quick open">
            <div className="flex h-[46px] items-center gap-2.5 border-b border-line px-3.5 text-faint">
              <IconSearch size={17} />
              <Command.Input
                value={rawQuery}
                onValueChange={setRawQuery}
                placeholder="Search…"
                className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
              />
              <Kbd>Esc</Kbd>
            </div>

            <Command.List className="max-h-[420px] overflow-y-auto px-1.5 pb-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[12.5px] text-faint">
                Nothing found.
              </Command.Empty>

              {cableResults.length > 0 ? (
                <Command.Group heading={<GroupHeading>Cables</GroupHeading>}>
                  {cableResults.map((entry) => (
                    <Command.Item
                      key={entry.id}
                      value={`cable:${entry.id}`}
                      onSelect={handleSelect}
                      className={ITEM_CLASS}
                    >
                      <ResultRow
                        icon={IconPlugConnected}
                        badgeClass="bg-accent"
                        label={entry.label}
                        meta={((pn) => (pn === undefined ? entry.id : `${pn} · ${entry.id}`))(
                          matchedPartNumber(entry, commandQuery),
                        )}
                      />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {libraryResults.length > 0 ? (
                <Command.Group heading={<GroupHeading>Library</GroupHeading>}>
                  {libraryResults.map((entry) => (
                    <Command.Item
                      key={`${entry.kind}:${entry.id}`}
                      value={`lib:${entry.kind}:${entry.id}`}
                      onSelect={handleSelect}
                      className={ITEM_CLASS}
                    >
                      <ResultRow
                        icon={KIND_ICON[entry.kind]}
                        badgeClass={KIND_BADGE[entry.kind]}
                        label={entry.label}
                        meta={entry.id}
                      />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {actionResults.length > 0 ? (
                <Command.Group heading={<GroupHeading>Actions</GroupHeading>}>
                  {actionResults.map((command) => (
                    <Command.Item
                      key={command.id}
                      value={`cmd:${command.id}`}
                      onSelect={handleSelect}
                      className={ITEM_CLASS}
                    >
                      <ResultRow
                        icon={IconCommand}
                        badgeClass="bg-dim"
                        label={command.title}
                        shortcut={command.shortcut}
                      />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>

            <div className="flex h-[30px] items-center gap-3.5 border-t border-line bg-raised px-3.5 text-[11px] text-faint">
              <span className="flex items-center gap-1.5">
                <Kbd>↑↓</Kbd> move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Enter</Kbd> open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Ctrl Enter</Kbd> open in new tab
              </span>
              <span className="grow" />
              <span>
                Type <span className="font-mono">&gt;</span> for commands
              </span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
