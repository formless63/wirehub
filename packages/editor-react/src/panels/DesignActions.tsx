/**
 * Save · Revert · New · Duplicate · Rename · Delete — the button row **for
 * the editor's own chrome** (`chrome="full"`, `CableEditor`'s default).
 *
 * The state machine and the dialogs live in `useDesignLifecycle.ts` /
 * `DesignLifecycleDialogs.tsx` now, so `chrome="host"` (
 * — the studio's own top bar) can drive the exact same rules through
 * `EditorHandle` without this button row ever mounting.
 */

import type { CableDesign, Db } from '@cable-studio/model';
import type { DepictionSource } from '@cable-studio/render-svg';
import type { JSX } from 'react';

import { classes, useEditorApi } from '../context.ts';
import type { CatalogChange } from '../lifecycle.ts';
import type { DesignSummary, PersistenceAdapter } from '../persistence.ts';
import { DesignLifecycleDialogs } from './DesignLifecycleDialogs.tsx';
import { useDesignLifecycle } from './useDesignLifecycle.ts';

export interface DesignActionsProps {
  /** the design as edited — what Save writes */
  design: CableDesign;
  /** the design as stored; absent while the host is still loading it */
  baseline?: CableDesign;
  persistence: PersistenceAdapter;
  /** every design the host knows about, so a new id can avoid the taken ones */
  designs?: DesignSummary[];
  /** the host refreshes its picker and its buffers from this */
  onCatalogChange?: (change: CatalogChange) => void;
  /**
   * The parts library. With one, **New** opens the guided new-cable wizard —
   * which needs the catalog to offer plugs, boards and wire stocks and to work
   * the joints out. Without one, New is the plain name-and-id dialog it always
   * was, which still produces a valid (empty) design.
   */
  db?: Db;
  /** artwork for the wizard's review schematic, when the host has any */
  depictions?: boolean | DepictionSource;
}

export function DesignActions(props: DesignActionsProps): JSX.Element {
  const { dispatch } = useEditorApi();
  const api = useDesignLifecycle({ ...props, dispatch });
  const { dialog, busy, dirty, warningLines, status, setDialog } = api;

  return (
    <>
      <div className="cs-lifecycle">
        <button
          type="button"
          className="cs-primary"
          disabled={!dirty || busy}
          title={
            !dirty
              ? 'Nothing has changed since the last save'
              : warningLines.length === 0
                ? 'Write these changes to the catalog'
                : `Write these changes to the catalog — ${warningLines.length} thing${warningLines.length === 1 ? '' : 's'} to look at first`
          }
          onClick={api.requestSave}
        >
          {busy && dialog === undefined ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={!dirty || busy || props.baseline === undefined}
          title={dirty ? 'Throw away the unsaved changes and reload the stored design' : 'Nothing to undo back to'}
          onClick={api.revert}
        >
          Revert
        </button>
        <button type="button" disabled={busy} onClick={api.openNew}>
          New…
        </button>
        <button type="button" disabled={busy} onClick={() => setDialog('duplicate')}>
          Duplicate…
        </button>
        <button type="button" disabled={busy} onClick={() => setDialog('rename')}>
          Rename…
        </button>
        <button type="button" className="cs-danger-quiet" disabled={busy} onClick={() => setDialog('delete')}>
          Delete…
        </button>
        <span className={classes('cs-chip', dirty && 'is-dirty')}>
          {dirty ? 'unsaved changes' : (status ?? 'saved')}
        </span>
      </div>

      <DesignLifecycleDialogs
        api={api}
        design={props.design}
        persistence={props.persistence}
        {...(props.db === undefined ? {} : { db: props.db })}
        {...(props.designs === undefined ? {} : { designs: props.designs })}
        {...(props.depictions === undefined ? {} : { depictions: props.depictions })}
      />
    </>
  );
}
