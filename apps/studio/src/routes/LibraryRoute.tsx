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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useMatches, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { DEFINITION_LABELS, LIBRARY_KINDS, Library, Page, RevisionsSection, Tab, TabList, Tabs, VocabularyBrowse, type BoardJourneyHost, type DefinitionKind, type LibraryKind } from '@wirehub/editor-react';
import { isRevisionKind, type Db } from '@wirehub/model';

import { RouteHeader } from '../shell/RouteHeader.tsx';
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
import { routesIn } from '../modules/placement.ts';
import { allowedRailModules } from '../modules.browser.ts';
import { ModulePanels } from '../modules/slots.tsx';
import { HistoryButton } from '../history/HistoryPanel.tsx';
import { definitionNoun } from '../history/types.ts';
import { helpForLibraryKind } from '../help.ts';
import { useDocsBase } from '../hooks/useDocsBase.ts';
import { useIsNarrow } from '../hooks/useIsNarrow.ts';
import { CompareHost } from '../modules/CompareHost.tsx';
import { RecordCover } from '../RecordCover.tsx';
import { BoardOutputs } from '../BoardOutputs.tsx';
import { BoardCheck } from '../BoardCheck.tsx';
import { BoardFirmware } from '../FirmwareLinks.tsx';
import { AdoptRevisionSection } from '../adopt/AdoptRevision.tsx';
import { frozenRecords } from '../versions/frozen-records.ts';
import { NotesPanel } from '../knowledge/NotesPanel.tsx';
import { StockPanel } from '../inventory/StockPanel.tsx';
import { OffersPanel } from '../inventory/OffersPanel.tsx';
import { BoardEnclosures } from '../enclosures/BoardEnclosures.tsx';
import { EnclosurePanel } from '../enclosures/EnclosurePanel.tsx';
import { PrintPanel } from '../print/PrintPanel.tsx';
import { RecordSections } from '../shell/RecordSections.tsx';
import { modelCoverAdapter } from '../cover-capture.ts';

function recordLabel(db: Db, kind: Exclude<LibraryKind, 'kits'>, id: string): string {
  const list: readonly { id: string; label?: string }[] = kind === 'mechanicals' ? (db.mechanicals ?? []) : db[kind];
  return list.find((r) => r.id === id)?.label ?? definitionNoun(kind);
}

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

const VOCAB_TAB = (onSelect: () => void): readonly { id: string; label: string; onSelect: () => void }[] => [{ id: 'vocabulary', label: 'Vocabulary', onSelect }];

function kindOfUrl(value: string | undefined): LibraryKind {
  return (value !== undefined && KIND_FROM_URL[value]) || 'connectors';
}

export function LibraryRoute(): JSX.Element {
  const docsBase = useDocsBase();
  const phone = useIsNarrow();
  const studio = useStudio();
  const modules = useModules();
  const navigate = useNavigate();
  // shared by `/library/$kind` and `/library/$kind/$id` — reading the last
  // match's own params, rather than either route's `.useParams()`, is what
  // lets one component answer for both without throwing on whichever route
  // did not match
  const matches = useMatches();
  const params = (matches[matches.length - 1]?.params ?? {}) as { kind?: string; id?: string };
  const search = (matches[matches.length - 1]?.search ?? {}) as { pack?: string; compare?: string };
  const packFilter = search.pack;
  const kind = kindOfUrl(params.kind);
  // the wire builder's parts library — only the Library reads it
  const wireLibrary = useMemo(() => workbenchWireLibrary(), []);
  const vendorDocuments = useMemo(() => workbenchDocuments(), []);
  // each record's 3D model
  // a new adapter makes the open record's 3D panel re-read its link (a generated enclosure replaces it)
  const [modelsEpoch, setModelsEpoch] = useState(0);
  const models = useMemo(() => workbenchModels(), [modelsEpoch]);
  const queryClient = useQueryClient();
  const modelCover = useMemo(() => modelCoverAdapter(queryClient), [queryClient]);
  const revisions = useMemo(() => workbenchRevisions(), []);
  const selectedId = params.id;
  // the compare view: a module's, or the base's field diff — `Library`'s Compare actions open it
  const [compare, setCompare] = useState<{ a: string; b?: string } | undefined>(undefined);
  // `?compare=kinds/id@rev` or `kinds/id@design:rev` (a saved version's "Changed since" link): that revision, or the version's frozen copy, against the record now
  useEffect(() => {
    if (search.compare !== undefined) setCompare({ a: search.compare, b: search.compare.slice(0, search.compare.lastIndexOf('@')) });
  }, [search.compare]);
  // a board's page walks its journey: builds are read and saved here (an
  // importer module may add the import step — docs/modules.md)
  // "Update from file": the library-import page of the module that reads board files, told which board (`?update=`)
  const boardPage = useMemo(() => {
    const readers = new Set(modules.importers().filter((i) => i.accepts.includes('.kicad_pcb')).map((i) => i.module));
    return routesIn(modules, 'library-import', allowedRailModules).find((r) => readers.has(r.module));
  }, [modules]);
  const boardEditable = studio.me?.role !== 'viewer';
  const boardJourney = useMemo((): BoardJourneyHost => ({
    builds: workbenchBuilds(),
    ...(boardPage === undefined ? {} : { onImport: (board) => { if (board.id !== undefined) void navigate({ href: `/m/${boardPage.module}/${boardPage.path}?update=${encodeURIComponent(board.id)}` }); } }),
    // the KiCad check under Import; "Update from this file" opens the update with the stored board file
    sourceCheck: (board) => <BoardCheck board={board} editable={boardEditable}
      {...(boardPage === undefined ? {} : { onUseFile: () => void navigate({ href: `/m/${boardPage.module}/${boardPage.path}?update=${encodeURIComponent(board.id)}&source=stored` }) })} />,
  }), [boardPage, navigate, boardEditable]);

  const onKindChange = useCallback(
    (next: LibraryKind): void => {
      void navigate({ to: '/library/$kind', params: { kind: KIND_TO_URL[next] }, search: packFilter === undefined ? {} : { pack: packFilter } });
    },
    [navigate, packFilter],
  );

  const onSelectId = useCallback(
    (id: string | undefined): void => {
      if (id === undefined) {
        void navigate({ to: '/library/$kind', params: { kind: KIND_TO_URL[kind] }, search: packFilter === undefined ? {} : { pack: packFilter } });
      } else {
        void navigate({ to: '/library/$kind/$id', params: { kind: KIND_TO_URL[kind], id }, search: packFilter === undefined ? {} : { pack: packFilter } });
      }
    },
    [navigate, kind, packFilter],
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
      <Link to="/extensions" className="cs-small cs-action-link" data-testid="browse-store" title="Catalog packs from the store indexes this hub trusts">
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
  // Library › Vocabulary: the controlled lists, read-only (`/library/vocabulary`)
  if (params.kind === 'vocabulary') {
    return (
      <Page>
        <RouteHeader title="Library" />
        <Tabs value="vocabulary" onValueChange={(next) => { if (next !== 'vocabulary') void navigate({ to: '/library/$kind', params: { kind: KIND_TO_URL[next as LibraryKind] } }); }}>
          <TabList aria-label="parts library" className="cs-library-tabs px-4">
            {LIBRARY_KINDS.map((entry) => <Tab key={entry} value={entry}>{DEFINITION_LABELS[entry]}</Tab>)}
            <Tab value="vocabulary">Vocabulary</Tab>
          </TabList>
        </Tabs>
        <VocabularyBrowse vocab={studio.db.vocab} />
      </Page>
    );
  }

  return (
    <Page>
    <RouteHeader title="Library" secondary={<Link to="/part-numbers" className="cs-ui-btn no-underline" title="Numbers used twice, parts without a number, numbers the scheme objects to">Numbering</Link>} />
    <div className="cs-editor min-h-0 flex-1">
      <EditLockScope record={selectedId === undefined ? undefined : definitionRecord(kind, selectedId)}>
      <LibraryNavigationGuard>
      <Library
        {...(packFilter === undefined ? {} : { packFilter })}
        onPackFilterChange={(pack) => {
          const search = pack === undefined ? {} : { pack };
          void navigate({ to: '/library/$kind', params: { kind: KIND_TO_URL[kind] }, search });
        }}
        rowMarker={(rowKind, id) => <>{rowKind !== 'pcbas' && rowKind !== 'wires' && rowKind !== 'mechanicals' ? null : <RecordCover key={id} kind={rowKind} id={id} label={(rowKind === 'pcbas' ? studio.db.pcbas : rowKind === 'wires' ? studio.db.wires : studio.db.mechanicals ?? []).find((r) => r.id === id)?.label ?? 'Unavailable item'} compact />}<LockMarker record={definitionRecord(rowKind, id)} /></>}
        recordPreview={({ kind, id, label }) => kind !== 'pcbas' && kind !== 'wires' && kind !== 'mechanicals' ? null : <><RecordCover key={`${kind}/${id}`} kind={kind} id={id} label={label} editable={!phone && studio.me?.role !== 'viewer'} /></>}
        db={studio.db}
        loading={!studio.dbReady}
        definitions={phone ? undefined : studio.definitions}
        readDefinitions={studio.definitions}
        viewOnly={phone}
        onDefinitionsChange={studio.onDefinitionsChange}
        vocab={studio.vocab}
        onVocabChange={studio.onDefinitionsChange}
        artworkAdapter={studio.artwork}
        assets={studio.assets}
        models={models}
        modelCover={modelCover}
        wireLibrary={wireLibrary}
        vendorDocuments={vendorDocuments}
        kind={kind}
        emptyHelp={(libraryKind) => helpForLibraryKind(libraryKind, docsBase)}
        onKindChange={onKindChange}
        {...(selectedId === undefined ? {} : { selectedId })}
        onSelectId={onSelectId}
        onOpenRecord={onOpenRecord}
        boardJourney={boardJourney}
        listActions={phone ? undefined : listActions}
        onCompare={(a, b) => setCompare({ a, ...(b === undefined ? {} : { b }) })}
        compareKinds={LIBRARY_KINDS}
        moduleExtras={(record: { kind: LibraryKind; id: string }) =>
          modules.panels('library-detail').length === 0 ? null : <ModulePanels registry={modules} slot="library-detail" context={{ db: studio.db, record, readOnly: false }} framed />
        }
        detailExtras={(record: { kind: LibraryKind; id: string; readOnly?: boolean }) => {
          const viewer = studio.me?.role === 'viewer';
          const shell = record.kind === 'mechanicals' ? (studio.db.mechanicals ?? []).find((m) => m.id === record.id) : undefined;
          const board = record.kind === 'pcbas' ? studio.db.pcbas.find((b) => b.id === record.id) : undefined;
          // one section pattern (shell/RecordSections.tsx), ordered by what matters for the kind:
          // a board's outputs and firmware, a shell's enclosure and print, then stock, revisions, notes
          return (
            <RecordSections key={`${record.kind}/${record.id}`} tools={phone ? undefined : (
              <span data-testid="library-history"><HistoryButton subject={definitionRecord(record.kind, record.id)} label={record.kind === 'kits' ? studio.db.kits?.find((k) => k.id === record.id)?.label ?? 'Kit' : recordLabel(studio.db, record.kind, record.id)} onRestored={studio.onDefinitionsChange} /></span>
            )}>
              {board === undefined || phone ? null : <BoardOutputs id={board.id} editable={!viewer} />}
              {board === undefined ? null : <BoardFirmware board={board.id} />}
              {board === undefined || phone ? null : <BoardEnclosures board={board} db={studio.db} definitions={studio.definitions} readOnly={viewer}
                onCreated={studio.onDefinitionsChange} onOpen={(id) => onOpenRecord('mechanicals', id)} />}
              {shell?.enclosure === undefined || phone ? null : <EnclosurePanel key={shell.id} record={shell} db={studio.db} definitions={studio.definitions}
                readOnly={viewer} onSaved={studio.onDefinitionsChange} onGenerated={() => { setModelsEpoch((n) => n + 1); void queryClient.invalidateQueries({ queryKey: ['print', shell.id] }); }} />}
              {shell === undefined || phone ? null : <PrintPanel id={shell.id} readOnly={viewer} />}
              {/* designs on an older revision of this part, with what moving changes and Adopt (docs/revisions.md) */}
              {record.kind === 'pcbas' || record.kind === 'mechanicals' ? <AdoptRevisionSection kind={record.kind} id={record.id} readOnly={phone || viewer} onOpen={(id) => onOpenRecord(record.kind, id)} /> : null}
              {/* what is in stock of it (docs/inventory.md); kits are not stocked */}
              {record.kind === 'kits' ? null : <StockPanel item={{ kind: record.kind, id: record.id }} label={recordLabel(studio.db, record.kind, record.id)} readOnly={phone || viewer} />}
              {record.kind === 'kits' ? null : <OffersPanel item={{ kind: record.kind, id: record.id }} dim={record.kind === 'wires' ? 'length' : 'count'} readOnly={phone || viewer} />}
              {/* the record's saved revisions: where each is used, compare, save the next (docs/revisions.md) */}
              {isRevisionKind(record.kind) ? (
                <RevisionsSection
                  kind={record.kind}
                  id={record.id}
                  revisions={revisions}
                  artwork={studio.artwork}
                  models={models}
                  readOnly={phone || viewer || record.readOnly === true}
                  onCompare={(a, b) => setCompare({ a, ...(b === undefined ? {} : { b }) })}
                  onChanged={() => studio.onDefinitionsChange()}
                />
              ) : null}
              <NotesPanel record={definitionRecord(record.kind, record.id)} readOnly={phone || viewer} />
            </RecordSections>
          );
        }}
        {...(partNumbers === undefined ? {} : { partNumbers })}
        {...(partNumbers?.designs === undefined ? {} : { designs: partNumbers.designs })}
        art={art}
        extraTabs={VOCAB_TAB(() => void navigate({ to: '/library/$kind', params: { kind: 'vocabulary' } }))}
        onOpenDesign={(id) => void navigate({ to: '/cables/$id', params: { id } })}
      />
      </LibraryNavigationGuard>
      </EditLockScope>
      {compare === undefined ? null : <CompareHost registry={modules} db={studio.db} a={compare.a} {...(compare.b === undefined ? {} : { b: compare.b })} revisions={revisions} artwork={studio.artwork} models={models} frozen={frozenRecords} onClose={() => setCompare(undefined)} />}
    </div>
    </Page>
  );
}
