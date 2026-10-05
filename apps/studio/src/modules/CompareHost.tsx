/**
 * The Library's compare view: a module's (`CompareViewContribution`) for the kinds it
 * declares, else the base's generic field diff (`RecordCompare`, cs-5k1.21).
 */

import { RecordCompare, parseCompareSide, type ArtworkAdapter, type ModelsAdapter, type RecordRef, type RevisionsAdapter } from '@wirehub/editor-react';
import type { Db } from '@wirehub/model';
import type { CompareProps, ModuleRegistry } from '@wirehub/modules';
import { useMemo, type ComponentType, type JSX } from 'react';

import { moduleApi } from './api.ts';
import { PanelBoundary } from './slots.tsx';

/** `pcbas/PCA-00001` → `{ kind: 'pcbas', id: 'PCA-00001' }`; `pcbas/PCA-00001@2` names its revision 2 */
export function parseRecordRef(item: string | undefined): RecordRef | undefined {
  return parseCompareSide(item);
}

export function CompareHost(props: { registry: ModuleRegistry; db: Db; a: string; b?: string; onClose: () => void; revisions?: RevisionsAdapter; artwork?: ArtworkAdapter; models?: ModelsAdapter }): JSX.Element | null {
  const a = parseRecordRef(props.a);
  const b = parseRecordRef(props.b);
  const view = a === undefined ? undefined : props.registry.compareViewFor(a.kind);
  const api = useMemo(() => (view === undefined ? undefined : moduleApi(view.module)), [view]);
  if (a === undefined) return null;
  if (view === undefined || api === undefined) {
    return (
      <RecordCompare
        db={props.db}
        a={a}
        {...(b === undefined ? {} : { b })}
        {...(props.revisions === undefined ? {} : { revisions: props.revisions })}
        {...(props.artwork === undefined ? {} : { artwork: props.artwork })}
        {...(props.models === undefined ? {} : { models: props.models })}
        onClose={props.onClose}
      />
    );
  }
  const View = view.component as ComponentType<CompareProps>;
  return (
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label={view.label} data-compare-module={view.module}>
      <div className="cs-modal-card cs-compare">
        <PanelBoundary label={view.label}>
          <View module={view.module} db={props.db} a={a} {...(b === undefined ? {} : { b })} api={api} onClose={props.onClose} />
        </PanelBoundary>
      </div>
    </div>
  );
}
