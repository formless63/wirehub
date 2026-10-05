/**
 * The open cable's own commands: Save, Undo, Redo,
 * Auto-arrange, Fit view, Add part ( — opens the node
 * picker at the viewport centre), the Select/Pan tools, Rename, Duplicate,
 * Make variant (copy onto another wire stock), Delete — registered only while a cable is
 * open, and only once `CableRoute` has handed a `chrome="host"` `EditorHandle`
 * down through `useEditorChrome()` (`shell/editor-chrome.tsx`).
 *
 * Every `run` calls straight into that handle — this file adds no logic of
 * its own beyond the shortcuts and the palette rows; `useDesignLifecycle`
 * (`@wirehub/editor-react`) still owns the actual rules. Mounted once,
 * at the shell (`Shell.tsx`), same as `AppCommands`. Renders nothing.
 */

import { useMemo } from 'react';
import { useMatches } from '@tanstack/react-router';

import { cableRoute } from '../router.tsx';
import { useEditorChrome } from '../shell/editor-chrome.tsx';
import { useRegisterCommands, type AppCommand } from './registry.tsx';

/** No visual output — `useRegisterCommands` is the only effect. */
export function EditorCommands(): null {
  const chrome = useEditorChrome();
  const matches = useMatches();
  const cableId = matches.some((match) => match.routeId === cableRoute.id);

  const commands = useMemo<AppCommand[]>(() => {
    if (!cableId || chrome.handle === null) return [];
    const handle = chrome.handle;
    const state = chrome.state;

    const list: AppCommand[] = [
      {
        id: 'editor.save',
        title: state.saving ? 'Saving…' : 'Save',
        keywords: ['write', 'store'],
        shortcut: 'Ctrl+S',
        enabled: () => state.dirty && !state.saving,
        run: handle.save,
      },
      {
        id: 'editor.undo',
        title: state.undoLabel === undefined ? 'Undo' : `Undo: ${state.undoLabel}`,
        shortcut: 'Ctrl+Z',
        enabled: () => state.canUndo,
        run: handle.undo,
      },
      {
        id: 'editor.redo',
        title: state.redoLabel === undefined ? 'Redo' : `Redo: ${state.redoLabel}`,
        shortcut: 'Ctrl+Shift+Z',
        enabled: () => state.canRedo,
        run: handle.redo,
      },
      // the Windows/Ctrl+Y hand for the same command — a second shortcut, not
      // a second palette row (`registry.tsx`'s `runShortcut` matches by combo,
      // `hidden` keeps quick-open showing "Redo" once)
      {
        id: 'editor.redo.ctrlY',
        title: 'Redo',
        shortcut: 'Ctrl+Y',
        hidden: true,
        enabled: () => state.canRedo,
        run: handle.redo,
      },
      {
        id: 'editor.autoArrange',
        title: 'Auto-arrange the canvas',
        keywords: ['layout', 'tidy'],
        shortcut: 'Shift+A',
        run: handle.autoArrange,
      },
      {
        id: 'editor.fitView',
        title: 'Fit view',
        keywords: ['zoom', 'centre'],
        shortcut: 'Shift+1',
        run: handle.fitView,
      },
      {
        id: 'editor.findPin',
        title: 'Find a pin…',
        keywords: ['search', 'pad', 'terminal', 'jump'],
        shortcut: '/',
        run: handle.findPin,
      },
      {
        id: 'editor.addPart',
        title: 'Add part…',
        keywords: ['insert', 'connector', 'wire', 'component', 'pcba', 'picker'],
        run: handle.openPicker,
      },
      {
        id: 'editor.tool.select',
        title: 'Select tool',
        keywords: ['cursor', 'pointer'],
        shortcut: 'V',
        enabled: () => state.tool !== 'select',
        run: () => handle.setTool('select'),
      },
      {
        id: 'editor.tool.pan',
        title: 'Pan tool',
        keywords: ['hand', 'move canvas'],
        shortcut: 'H',
        enabled: () => state.tool !== 'pan',
        run: () => handle.setTool('pan'),
      },
      {
        id: 'editor.rename',
        title: 'Rename this cable',
        keywords: ['id', 'label'],
        run: () => handle.openLifecycle('rename'),
      },
      {
        id: 'editor.duplicate',
        title: 'Duplicate this cable',
        keywords: ['copy', 'save as'],
        run: () => handle.openLifecycle('duplicate'),
      },
      {
        id: 'editor.makeVariant',
        title: 'Make variant: copy this cable onto another wire stock…',
        keywords: ['variant', 'stock', 'wire', 'swap', 'copy'],
        run: () => handle.openLifecycle('variant'),
      },
      {
        id: 'editor.delete',
        title: 'Delete this cable',
        keywords: ['remove'],
        run: () => handle.openLifecycle('delete'),
      },
    ];

    return list;
  }, [cableId, chrome.handle, chrome.state]);

  useRegisterCommands(commands);
  return null;
}
