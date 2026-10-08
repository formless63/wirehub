/**
 * `/library/$kind` and `/library/$kind/$id` — the parts library as a real
 * section: a list on the left (kind tabs, search, count, "New <kind>"), the
 * selected definition's detail on the right, selection in the URL. `/library`
 * itself redirects to the first kind (`router.tsx`).
 *
 * `Library` (`@wirehub/editor-react`) does the actual list/detail/tabs
 * work — this route is only the URL ↔ props wiring asked
 * for: which kind and which id the URL names, in both directions (a click in
 * the list pushes a URL; a URL change selects). The kind segment in the URL
 * is the user-facing `boards` (`specs/ui-redesign.md`'s wording); `Library`'s
 * own vocabulary is `pcbas` (`DefinitionKind`) — `urlKindOf`/`kindOfUrl` is
 * the one place that translation happens. `pcbas` is accepted too, since
 * `commands/CommandPalette.tsx` builds its library links with the internal
 * name directly.
 *
 * `Library` was written to live inside `CableEditor`'s `.cs-editor` scope —
 * that class is where `editor.css` hangs the generic button/tab chrome every
 * `cs-*` element under it reads (`.cs-editor button`, `.cs-tabs button`, …),
 * not just canvas-specific rules. Outside it, Library's own tabs and buttons
 * fall back to unstyled browser defaults. Carrying just the class name (no
 * `<CableEditor>`) is the cheap way to opt back into that chrome without this
 * app reaching into editor-react's internals.
 */

import { LibraryNavigationGuard } from './LibraryNavigationGuard.tsx';
import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useMatches, useNavigate } from '@tanstack/react-router';
import { LIBRARY_KINDS, Library, RevisionsSection, type BoardJourneyHost, type DefinitionKind, type LibraryKind } from '@wirehub/editor-react';
import { isRevisionKind } from '@wirehub/model';

import { useStudio } from '../studio-context.tsx';
import { workbenchWireLibrary } from '../wire-library.browser.ts';
import { workbenchDocuments } from '../persistence.browser.ts';
import { workbenchBuilds } from '../builds.browser.ts';
import { workbenchModels } from '../models.browser.ts';
import { workbenchRevisions } from '../revisions.browser.ts';
import { EditLockScope } from '../locks/EditLockScope.tsx';
import { LockMarker } from '../locks/LockMarker.tsx';
import { definitionRecord } from '../locks/records.ts';
import { browserDepictions } from '../depictions.browser.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { ImportMenu } from '../modules/ImportMenu.tsx';
import { ModulePanels } from '../modules/slots.tsx';
import { HistoryButton } from '../history/HistoryPanel.tsx';
import { definitionNoun } from '../history/types.ts';
import { CompareHost } from '../modules/CompareHost.tsx';

const KIND_FROM_URL: Readonly<Record<string, LibraryKind>> = {
  connectors: 'connectors',
  components: 'components',
  wires: 'wires',
  boards: 'pcbas',
  // shells and hardware, and kits
  hardware: 'mechanicals',
  mechanicals: 'mechanicals',
  kits: 'kits',
  // the internal name, accepted too — `commands/CommandPalette.tsx` links
  // straight to it
  pcbas: 'pcbas',
};

const KIND_TO_URL: Readonly<Record<LibraryKind, string>> = {
  connectors: 'connectors',
  components: 'components',
  wires: 'wires',
  pcbas: 'boards',
  mechanicals: 'hardware',
  kits: 'kits',
};

function kindOfUrl(value: string | undefined): LibraryKind {
  return (value !== undefined && KIND_FROM_URL[value]) || 'connectors';
}

export function LibraryRoute(): JSX.Element {
  const studio = useStudio();
  const modules = useModules();
  const navigate = useNavigate();
  // shared by `/library/$kind` and `/library/$kind/$id` — reading the last
  // match's own params, rather than either route's `.useParams()`, is what
  // lets one component answer for both without throwing on whichever route
  // did not match
  const matches = useMatches();
  const params = (matches[matches.length - 1]?.params ?? {}) as { kind?: string; id?: string };
  const kind = kindOfUrl(params.kind);
  // the wire builder's parts library — only the Library reads it
  const wireLibrary = useMemo(() => workbenchWireLibrary(), []);
  const vendorDocuments = useMemo(() => workbenchDocuments(), []);
  // each record's 3D model
  const models = useMemo(() => workbenchModels(), []);
  const revisions = useMemo(() => workbenchRevisions(), []);
  const selectedId = params.id;
  // the compare view: a module's, or the base's field diff — `Library`'s Compare actions open it
  const [compare, setCompare] = useState<{ a: string; b?: string } | undefined>(undefined);
  // a board's page walks its journey: builds are read and saved here (an
  // importer module may add the import step — docs/modules.md)
  const boardJourney = useMemo((): BoardJourneyHost => ({ builds: workbenchBuilds() }), []);

  const onKindChange = useCallback(
    (next: LibraryKind): void => {
      void navigate({ to: '/library/$kind', params: { kind: KIND_TO_URL[next] } });
    },
    [navigate],
  );

  const onSelectId = useCallback(
    (id: string | undefined): void => {
      if (id === undefined) {
        void navigate({ to: '/library/$kind', params: { kind: KIND_TO_URL[kind] } });
      } else {
        void navigate({ to: '/library/$kind/$id', params: { kind: KIND_TO_URL[kind], id } });
      }
    },
    [navigate, kind],
  );

  const onOpenRecord = useCallback(
    (target: LibraryKind, id: string): void => {
      void navigate({ to: '/library/$kind/$id', params: { kind: KIND_TO_URL[target], id } });
    },
    [navigate],
  );

  // the numbering scheme for the part-number Suggest — live from the workbench
  const partNumbers = studio.partNumbers;
  // the tables' Used column and Art flag: every design, and which parts have drawn art
  const art = useMemo(() => new Set(browserDepictions().known()), [studio.depictions]);

  // beside "+ New": Browse store (packs from the trusted store indexes), and the
  // Import… button importers modules contribute
  const listActions = useMemo(() => {
    const store = (
      <Link to="/library/store" className="cs-small cs-action-link" data-testid="browse-store" title="Catalog packs from the store indexes this hub trusts">
        Browse store
      </Link>
    );
    const importMenu = <ImportMenu registry={modules} onImported={studio.onDefinitionsChange} />;
    const both = (
      <>
        {importMenu}
        {store}
      </>
    );
    return { connectors: both, components: both, wires: both, pcbas: both, mechanicals: both };
  }, [modules, studio.onDefinitionsChange]);

  // edit locks: the selected definition is the record; a new one locks nothing
  return (
    <div className="cs-editor">
      <EditLockScope record={selectedId === undefined ? undefined : definitionRecord(kind, selectedId)}>
      <LibraryNavigationGuard>
      <Library
        rowMarker={(rowKind, id) => <LockMarker record={definitionRecord(rowKind, id)} />}
        db={studio.db}
        definitions={studio.definitions}
        onDefinitionsChange={studio.onDefinitionsChange}
        vocab={studio.vocab}
        onVocabChange={studio.onDefinitionsChange}
        artworkAdapter={studio.artwork}
        assets={studio.assets}
        models={models}
        wireLibrary={wireLibrary}
        vendorDocuments={vendorDocuments}
        kind={kind}
        onKindChange={onKindChange}
        {...(selectedId === undefined ? {} : { selectedId })}
        onSelectId={onSelectId}
        onOpenRecord={onOpenRecord}
        boardJourney={boardJourney}
        listActions={listActions}
        onCompare={(a, b) => setCompare({ a, ...(b === undefined ? {} : { b }) })}
        compareKinds={LIBRARY_KINDS}
        moduleExtras={(record: { kind: LibraryKind; id: string }) =>
          modules.panels('library-detail').length === 0 ? null : <ModulePanels registry={modules} slot="library-detail" context={{ db: studio.db, record, readOnly: false }} framed />
        }
        detailExtras={(record: { kind: LibraryKind; id: string }) => (
          <>
            {/* the record's change history: who changed what, and restore an earlier state */}
            <div className="cs-row" data-testid="library-history">
              <HistoryButton subject={definitionRecord(record.kind, record.id)} label={`${definitionNoun(record.kind)} ${record.id}`} onRestored={studio.onDefinitionsChange} />
            </div>
            {/* the record's saved revisions: where each is used, compare, save the next (docs/revisions.md) */}
            {isRevisionKind(record.kind) ? (
              <RevisionsSection
                key={`${record.kind}/${record.id}`}
                kind={record.kind}
                id={record.id}
                revisions={revisions}
                artwork={studio.artwork}
                models={models}
                readOnly={studio.me?.role === 'viewer'}
                onCompare={(a, b) => setCompare({ a, ...(b === undefined ? {} : { b }) })}
                onChanged={() => studio.onDefinitionsChange()}
              />
            ) : null}
          </>
        )}
        {...(partNumbers === undefined ? {} : { partNumbers })}
        {...(partNumbers?.designs === undefined ? {} : { designs: partNumbers.designs })}
        art={art}
        onOpenDesign={(id) => void navigate({ to: '/cables/$id', params: { id } })}
      />
      </LibraryNavigationGuard>
      </EditLockScope>
      {compare === undefined ? null : <CompareHost registry={modules} db={studio.db} a={compare.a} {...(compare.b === undefined ? {} : { b: compare.b })} revisions={revisions} artwork={studio.artwork} models={models} onClose={() => setCompare(undefined)} />}
    </div>
  );
}
