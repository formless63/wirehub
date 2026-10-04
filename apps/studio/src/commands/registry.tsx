/**
 * The app's single command/shortcut registry.
 *
 * A `Command` is anything the palette can list or a keyboard combo can run —
 * "Go to Cables", the theme toggle, New cable, later
 * "Save", undo/redo, auto-arrange. Registering is imperative and scoped to
 * whoever calls it: `useRegisterCommands` adds its commands in an effect and
 * removes them on unmount/re-registration, so a component that only makes
 * sense with a cable open (the editor toolbar kcf.7 adds) can register its
 * commands exactly while it is mounted and never leak a stale "Save" into
 * the palette once the cable closes.
 *
 * `CommandRegistryProvider` also owns the one global keyboard listener: it
 * turns every `keydown` into a canonical combo (`shortcuts.ts`) and runs the
 * first enabled command whose `shortcut` matches. It listens in the capture
 * phase at `document` so a shortcut still fires from inside the canvas or
 * any other component that might otherwise stop propagation, and it ignores
 * every combo but `Ctrl+K` while the target is a text input, textarea,
 * select or `contenteditable` — see `shortcuts.ts`'s `isTypingTarget`. This
 * is also the seam plugs the editor's own shortcuts
 * (Ctrl S, V/H, Shift A, Shift 1) into: nothing about this file is specific
 * to quick-open or navigation.
 *
 * The registry itself (`createCommandRegistry`) is plain, React-free state —
 * a `Map` plus a listener set — so `CommandPalette.tsx` can read it through
 * `useSyncExternalStore` (`useCommands`) without every registration causing
 * a re-render of components that do not care.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';

import { comboFromEvent, isTypingTarget } from './shortcuts.ts';

/** One entry in the registry — a palette row, a shortcut, or both. */
export interface AppCommand {
  /** stable across the app, e.g. `'nav.cables'`, `'quick-open'` — kcf.7 might use `'editor.save'` */
  id: string;
  title: string;
  /** extra text the palette also matches against (synonyms, the thing this replaces, …) */
  keywords?: string[];
  /**
   * The canonical combo this command runs on, e.g. `'Ctrl+K'`, `'Ctrl+S'`,
   * `'Shift+A'`, `'V'` — modifiers always in `Ctrl`, `Shift`, `Alt` order,
   * `+`-joined, then the key (`shortcuts.ts`'s `comboFromEvent` produces the
   * same shape from a `KeyboardEvent`). Shown in the palette row and usable
   * as tooltip text via `formatShortcut`.
   */
  shortcut?: string;
  /** true: still runnable (by id or shortcut), but never listed in the palette — `quick-open` itself uses this */
  hidden?: boolean;
  run: () => void;
  /** default: always enabled */
  enabled?: () => boolean;
}

export interface CommandRegistry {
  /** adds `commands` (by id, replacing anything already registered under the same id); returns the cleanup that removes exactly these */
  register: (commands: AppCommand[]) => () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => AppCommand[];
  /** runs a command by id if it exists and is enabled; returns whether it ran */
  run: (id: string) => boolean;
  /** runs the (enabled) command whose `shortcut` equals `combo`, if any; returns whether it ran */
  runShortcut: (combo: string) => boolean;
}

export function createCommandRegistry(): CommandRegistry {
  const byId = new Map<string, AppCommand>();
  const listeners = new Set<() => void>();
  let snapshot: AppCommand[] = [];

  function recompute(): void {
    snapshot = [...byId.values()];
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function register(commands: AppCommand[]): () => void {
    for (const command of commands) byId.set(command.id, command);
    recompute();
    notify();
    return () => {
      // only drop it if nothing has re-registered the same id since — a
      // StrictMode double-invoke, or one owner's unmount racing another's
      // registration of the same id, must never delete the newer one
      for (const command of commands) {
        if (byId.get(command.id) === command) byId.delete(command.id);
      }
      recompute();
      notify();
    };
  }

  function run(id: string): boolean {
    const command = byId.get(id);
    if (command === undefined || command.enabled?.() === false) return false;
    command.run();
    return true;
  }

  function runShortcut(combo: string): boolean {
    for (const command of byId.values()) {
      if (command.shortcut !== combo) continue;
      if (command.enabled?.() === false) continue;
      command.run();
      return true;
    }
    return false;
  }

  return {
    register,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    run,
    runShortcut,
  };
}

const CommandRegistryContext = createContext<CommandRegistry | undefined>(undefined);

export function CommandRegistryProvider({ children }: { children: ReactNode }): JSX.Element {
  const registryRef = useRef<CommandRegistry | undefined>(undefined);
  registryRef.current ??= createCommandRegistry();
  const registry = registryRef.current;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const combo = comboFromEvent(event);
      if (combo === '') return;
      // every shortcut but Ctrl+K is ignored while typing — see the file header
      if (isTypingTarget(event.target) && combo !== 'Ctrl+K') return;
      if (registry.runShortcut(combo)) event.preventDefault();
    }
    // capture phase: fires before a focused canvas/editor element can stop
    // propagation, so Ctrl+K (and later, kcf.7's shortcuts) work from anywhere
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [registry]);

  return <CommandRegistryContext.Provider value={registry}>{children}</CommandRegistryContext.Provider>;
}

export function useCommandRegistry(): CommandRegistry {
  const value = useContext(CommandRegistryContext);
  if (value === undefined) throw new Error('useCommandRegistry() must be used inside <CommandRegistryProvider>');
  return value;
}

/**
 * Registers `commands` for as long as the caller stays mounted, replacing
 * them whenever the array identity changes and removing them on unmount —
 * this is the hook's editor toolbar calls to plug Save,
 * undo/redo, V/H and auto-arrange into this same registry. Callers should
 * memoize `commands` (`useMemo`) so it is not re-registered every render.
 */
export function useRegisterCommands(commands: AppCommand[]): void {
  const registry = useCommandRegistry();
  useEffect(() => registry.register(commands), [registry, commands]);
}

/** every currently-registered command, live — what `CommandPalette.tsx` lists under ACTIONS */
export function useCommands(): AppCommand[] {
  const registry = useCommandRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}
