/**
 * The design lifecycle's state machine — Save · Revert · New · Duplicate ·
 * Rename · Delete — factored out of `DesignActions`
 * so two different chrome surfaces can drive the same rules without either
 * one reimplementing them:
 *
 * - `DesignActions` (full chrome, unchanged): the button row + dialogs, both
 *   driven by this hook.
 * - `CableEditor`'s **host chrome**: no button row —
 *   the host's own top bar calls `openLifecycle('rename' | …)` through the
 *   `EditorHandle` — but the *dialogs* (`DesignLifecycleDialogs`) are still
 *   mounted by the editor and still run through this same hook, so the
 *   validation, the warnings gate, and `onCatalogChange` wiring are written
 *   exactly once.
 */

import { useState, type Dispatch, type SetStateAction } from 'react';
import { validateDesign, type CableDesign, type Db } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import {
  createDesign,
  deleteDesign,
  createWiredDesign,
  duplicateDesign,
  renameDesign,
  saveDesign,
  type CatalogChange,
  type LifecycleProblem,
  type LifecycleResult,
} from '../lifecycle.ts';
import { explainWarnings, type EditorAction } from '../store.ts';
import { isDirty, type DesignSummary, type PersistenceAdapter } from '../persistence.ts';

export type { CatalogChange };

export type DialogKind =
  | 'wizard'
  | 'new'
  | 'duplicate'
  | 'rename'
  | 'delete';

/** The subset a host's own chrome opens by name — see `EditorHandle.openLifecycle`. */
export type LifecycleAction =
  | 'rename'
  | 'duplicate'
  | 'delete'
  | 'new';

export interface DesignLifecycleProps {
  design: CableDesign;
  baseline?: CableDesign;
  persistence?: PersistenceAdapter;
  designs?: DesignSummary[];
  db?: Db;
  depictions?: boolean | DepictionSource;
  onCatalogChange?: (change: CatalogChange) => void;
  /**
   * The store's dispatch — passed explicitly rather than read through
   * `useEditorApi()` so this hook works both *below* `EditorContext.Provider`
   * (`DesignActions`, a descendant) and *inside the same component that
   * renders the provider* (`CableEditor`'s host chrome, which cannot read
   * its own provider's value via context).
   */
  dispatch: (action: EditorAction) => void;
}

export interface DesignLifecycleApi {
  dialog: DialogKind | undefined;
  setDialog: Dispatch<SetStateAction<DialogKind | undefined>>;
  busy: boolean;
  problem: LifecycleProblem | undefined;
  status: string | undefined;
  confirming: boolean;
  setConfirming: Dispatch<SetStateAction<boolean>>;
  /** there are unsaved changes — Save/Revert/Duplicate/Rename all read this */
  dirty: boolean;
  warningLines: string[];
  taken: string[];
  run: (operation: () => Promise<LifecycleResult>) => Promise<void>;
  /** Save, gated on the warnings dialog exactly as the button row always was */
  requestSave: () => void;
  /** write the draft now, skipping the warnings gate — used once it is confirmed */
  save: () => Promise<void>;
  revert: () => void;
  close: () => void;
  /** New…: the wizard when a library is available, the blank dialog otherwise */
  openNew: () => void;
  /** the chevron/overflow menus' entry point — see `LifecycleAction` */
  openLifecycle: (action: LifecycleAction) => void;
  /** the wizard's own `onCatalogChange`: it already produced a finished `CatalogChange` itself */
  finishWizard: (change: CatalogChange) => void;
  /** New… shows the plug-and-board wizard (kept for hosts that toggle it) */
  byHand: boolean;
  setByHand: Dispatch<SetStateAction<boolean>>;
}

export function useDesignLifecycle(props: DesignLifecycleProps): DesignLifecycleApi {
  const { dispatch } = props;
  const [dialog, setDialog] = useState<DialogKind | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LifecycleProblem | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  /** New…: the plug-and-board wizard */
  const [byHand, setByHand] = useState(false);

  const dirty = isDirty(props.design, props.baseline);

  const warningLines =
    props.db === undefined ? [] : explainWarnings(validateDesign(props.design, props.db));
  const taken = (props.designs ?? []).map((summary) => summary.id);

  const run = async (operation: () => Promise<LifecycleResult>): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await operation();
      if (result.ok) {
        setStatus(result.status);
        setDialog(undefined);
        props.onCatalogChange?.(result.change);
      } else {
        // the dialog stays open with what the user typed still in it
        setProblem(result.problem);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Write the draft. A save that carried warnings says so in the status chip afterwards. */
  const save = async (): Promise<void> => {
    if (props.persistence === undefined) return;
    const persistence = props.persistence;
    setConfirming(false);
    const count = warningLines.length;
    await run(async () => {
      const result = await saveDesign(persistence, props.design);
      if (!result.ok || count === 0) return result;
      return {
        ...result,
        status: `saved — ${count} thing${count === 1 ? '' : 's'} to look at`,
      };
    });
  };

  /** the exact gate the Save button (and Ctrl+S) always applied */
  const requestSave = (): void => {
    if (props.persistence === undefined || !dirty || busy) return;
    if (warningLines.length === 0) void save();
    else setConfirming(true);
  };

  const revert = (): void => {
    if (props.baseline === undefined) return;
    setProblem(undefined);
    setStatus(`went back to the saved ${props.baseline.id}`);
    dispatch({ type: 'load-design', design: structuredClone(props.baseline) });
  };

  const close = (): void => {
    setDialog(undefined);
    setProblem(undefined);
    setByHand(false);
  };

  const openNew = (): void => setDialog(props.db === undefined ? 'new' : 'wizard');

  const openLifecycle = (action: LifecycleAction): void => {
    if (action === 'new') {
      openNew();
      return;
    }
    setDialog(action);
  };

  const finishWizard = (change: CatalogChange): void => {
    setStatus(`created ${change.kind === 'deleted' ? change.id : change.design.id}`);
    setDialog(undefined);
    setByHand(false);
    props.onCatalogChange?.(change);
  };

  return {
    dialog,
    setDialog,
    busy,
    problem,
    status,
    confirming,
    setConfirming,
    dirty,
    warningLines,
    taken,
    run,
    requestSave,
    save,
    revert,
    close,
    openNew,
    openLifecycle,
    finishWizard,
    byHand,
    setByHand,
  };
}

export { createDesign, createWiredDesign, deleteDesign, duplicateDesign, renameDesign };
