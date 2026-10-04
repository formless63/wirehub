/**
 * A wire stock's page in the Library (reordered
 * 50a.62): the visuals — the parametric 3D wire, open on load with no extra
 * click, plus the documentary section (cutaway) drawing — sit first and
 * full-width, always shown. Below them are the wire's settings: its
 * properties (handed in by the caller, which owns the table columns) and the
 * builder/edit controls, one tab each (Builder, Spec sheet, Record). "Where
 * used" is the caller's business too, rendered after this component — last,
 * as the owner asked (2026-09-29): "the visuals and settings and such should
 * be at the top" and the owner "didn't find the new 3D wires" when they were
 * behind a tab.
 *
 * Holds the draft recipe, the parts library (reloaded after "New part…"),
 * and the save: compile, gate, hand to the host adapter, which validates the
 * whole library again before writing the recipe and its compiled stock.
 */

import type { StripPractice, WireDefinition, WireLibrary, WirePart, WirePartKind, WireRecipe } from '@wirehub/model';
import { renderWireSpecSheet, wireSpecFileName, wireSpecFileStem } from '@wirehub/docs';
import { IconDownload, IconPrinter } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';

import { classes } from '../context.ts';
import { useVocab } from '../vocab.ts';
import { compileRecipe, recipeProblems, type VendorDocumentsAdapter, type WireLibraryAdapter } from '../wire-builder.ts';
import { layFactsOf, presetsFor } from '../wire-view.ts';
import { Cutaway } from './WireStockEditor.tsx';
import { NewPartDialog, WireBuilder } from './WireBuilder.tsx';
import { LazyWireModel3d } from './wire-model-lazy.tsx';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.ts';

export type WireDetailTab = 'builder' | 'spec' | 'record';

/**
 * The stock's WireHub Standard sheet (pci.18/pci.29). Every file it
 * leaves as is named `ASS_<part number>`: the download, and the print —
 * a browser names a saved PDF after the page title, so the title is set for
 * the length of the print.
 */
export function WireSpecPane(props: {
  wire: WireDefinition;
  recipe?: WireRecipe;
  parts?: readonly WirePart[];
  documents?: VendorDocumentsAdapter;
}): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const { vocab } = useVocab();
  const manufacturers = vocab?.['manufacturers']?.entries;
  const documents = props.documents;
  const html = useMemo(
    () =>
      renderWireSpecSheet(props.wire, {
        ...(props.recipe === undefined ? {} : { recipe: props.recipe }),
        ...(props.parts === undefined ? {} : { parts: props.parts }),
        ...(manufacturers === undefined ? {} : { manufacturers }),
        ...(documents === undefined ? {} : { vendorDocHref: (asset: string) => documents.href(asset) }),
      }),
    [props.wire, props.recipe, props.parts, manufacturers, documents],
  );
  const stem = wireSpecFileStem(props.wire);
  const print = (): void => {
    const win = frame.current?.contentWindow;
    if (win === null || win === undefined) return;
    const before = document.title;
    document.title = stem;
    try {
      win.print();
    } finally {
      document.title = before;
    }
  };
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = wireSpecFileName(props.wire, 'html');
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="cs-wb-spec">
      <div className="cs-wb-spec-bar">
        <span className="cs-wb-spec-name cs-mono" title="What the downloaded or printed file is called">
          {stem}
        </span>
        <span className="cs-wb-spacer" />
        <button type="button" className="cs-small" onClick={download} title={`Download ${wireSpecFileName(props.wire, 'html')}`}>
          <IconDownload size={14} stroke={1.75} /> Download
        </button>
        <button type="button" className="cs-small" onClick={print} title={`Print, or save as ${wireSpecFileName(props.wire, 'pdf')}`}>
          <IconPrinter size={14} stroke={1.75} /> Print
        </button>
      </div>
      <iframe ref={frame} className="cs-wb-spec-frame" title={`${props.wire.label} — spec sheet`} srcDoc={html} />
    </div>
  );
}

export interface WireStockDetailProps {
  adapter: WireLibraryAdapter;
  /** the stock being edited, or the starting recipe of a new one */
  recipe: WireRecipe;
  create: boolean;
  /** the stock on file (edit mode) — the spec sheet reads it when the draft is unchanged */
  wire?: WireDefinition;
  readOnly?: boolean;
  /** ids already used anywhere in the library */
  takenIds: readonly string[];
  tab: WireDetailTab;
  onTab: (tab: WireDetailTab) => void;
  onSaved: (recipe: WireRecipe, wire: WireDefinition, create: boolean) => void;
  onDuplicate?: (recipe: WireRecipe) => void;
  onClose: () => void;
  /** the record tab's content (the Library's existing stock form) */
  record?: JSX.Element | null;
  library: WireLibrary;
  onLibrary: (library: WireLibrary) => void;
  /** the host's stored files — vendor documents link to and open from them */
  documents?: VendorDocumentsAdapter;
  /** the record's properties grid (the caller owns the table columns) — shown
   * between the visuals and the builder/edit tabs */
  properties?: ReactNode;
}

export function WireStockDetail(props: WireStockDetailProps): JSX.Element {
  const [draft, setDraft] = useState<WireRecipe>(props.recipe);
  const [baseline, setBaseline] = useState<WireRecipe>(props.recipe);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [newPart, setNewPart] = useState<WirePartKind | undefined>(undefined);
  useEffect(() => {
    setDraft(props.recipe);
    setBaseline(props.recipe);
    setProblem(undefined);
    setStatus(undefined);
  }, [props.recipe]);

  const compiled = useMemo(() => compileRecipe(draft, props.library), [draft, props.library]);
  // the strip presets (the bench's standard work, as data) — once per adapter
  const [practice, setPractice] = useState<StripPractice[]>([]);
  useEffect(() => {
    let live = true;
    void props.adapter.practice?.().then((outcome) => {
      if (live && outcome.ok) setPractice(outcome.value);
    });
    return () => {
      live = false;
    };
  }, [props.adapter]);
  const presets = useMemo(() => presetsFor(compiled.wire, practice), [compiled.wire, practice]);
  const facts = useMemo(() => layFactsOf(draft), [draft]);
  const dirty = props.create || JSON.stringify(draft) !== JSON.stringify(baseline);
  useUnsavedChangesGuard(JSON.stringify(draft) !== JSON.stringify(baseline));
  const problems = recipeProblems(draft, compiled, props.create, props.takenIds);

  const save = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    const outcome = await props.adapter.saveStock(draft, props.create);
    setBusy(false);
    if (!outcome.ok) {
      setProblem([outcome.message, outcome.hint, ...(outcome.issues ?? []).map((i) => i.message)].filter(Boolean).join(' '));
      return;
    }
    setBaseline(draft);
    setStatus('saved');
    props.onSaved(draft, compiled.wire, props.create);
  };

  const tabs: { id: WireDetailTab; label: string }[] = [
    { id: 'builder', label: 'Builder' },
    { id: 'spec', label: 'Spec sheet' },
    ...(props.record === undefined || props.create ? [] : [{ id: 'record' as const, label: 'Record' }]),
  ];

  return (
    <div className="cs-wb-detail">
      {/* the visuals, first and full-width, open on load with no click needed
          (owner 2026-09-29: the new 3D wires went unnoticed behind a tab) */}
      <section className="cs-record-section cs-wb-views" aria-label="views">
        <h3 className="cs-record-h">Views</h3>
        <div className="cs-wb-views-3d">
          <LazyWireModel3d wire={compiled.wire} presets={presets} facts={facts} height={420} />
        </div>
        <div className="cs-wb-views-section">
          <Cutaway wire={compiled.wire} />
        </div>
      </section>

      {props.properties}

      <nav className="cs-tabs cs-def-tabs cs-wb-tabs" aria-label="wire stock detail">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={classes(props.tab === tab.id && 'is-active')}
            aria-pressed={props.tab === tab.id}
            onClick={() => props.onTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <span className="cs-wb-spacer" />
        {props.create || props.onDuplicate === undefined ? null : (
          <button type="button" className="cs-small" title="A copy to change — every part kept" onClick={() => props.onDuplicate?.(draft)}>
            Duplicate stock
          </button>
        )}
      </nav>

      {props.tab === 'builder' ? (
        <WireBuilder
          recipe={draft}
          library={props.library}
          create={props.create}
          readOnly={props.readOnly === true || busy}
          onChange={setDraft}
          onNewPart={props.readOnly === true ? undefined : (kind) => setNewPart(kind)}
          practice={practice}
          {...(props.documents === undefined ? {} : { documents: props.documents })}
        />
      ) : null}
      {props.tab === 'spec' ? (
        <WireSpecPane wire={compiled.wire} recipe={draft} parts={props.library.parts} {...(props.documents === undefined ? {} : { documents: props.documents })} />
      ) : null}
      {props.tab === 'record' ? props.record ?? null : null}

      {props.tab === 'record' || props.readOnly === true ? null : (
        <div className="cs-def-actions cs-wb-actions-bar">
          <button
            type="button"
            className="cs-primary"
            disabled={busy || !dirty || problems.length > 0}
            title={problems.length > 0 ? problems.join(' ') : dirty ? 'Compile and write the stock' : 'Nothing has changed'}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : props.create ? 'Create stock' : 'Save'}
          </button>
          {props.create ? null : (
            <button type="button" disabled={busy || !dirty} onClick={() => setDraft(baseline)}>
              Revert
            </button>
          )}
          <button type="button" disabled={busy} onClick={props.onClose}>
            {props.create ? 'Cancel' : 'Close'}
          </button>
          {props.create && !dirty && status === undefined ? null : (
            <span className={classes('cs-chip', dirty && 'is-dirty')} title={problems.join(' ')}>
              {problems.length > 0 && dirty ? `${problems.length} to fix` : dirty ? 'unsaved changes' : (status ?? 'saved')}
            </span>
          )}
        </div>
      )}
      {problem === undefined ? null : (
        <div className="cs-problem" role="alert">
          <strong>{problem}</strong>
        </div>
      )}
      {problems.length > 0 && dirty && props.tab === 'builder' ? (
        <ul className="cs-wb-problems" role="status">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      {newPart === undefined ? null : (
        <NewPartDialog
          library={props.library}
          initialKind={newPart}
          onCancel={() => setNewPart(undefined)}
          onAdd={async (part) => {
            const outcome = await props.adapter.addPart(part);
            if (!outcome.ok) return [outcome.message, outcome.hint].filter(Boolean).join(' ');
            const reloaded = await props.adapter.load();
            props.onLibrary(reloaded.ok ? reloaded.value : { ...props.library, parts: [...props.library.parts, part] });
            setNewPart(undefined);
            return undefined;
          }}
        />
      )}
    </div>
  );
}
