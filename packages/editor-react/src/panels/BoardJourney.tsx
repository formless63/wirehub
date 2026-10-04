/**
 * A board's page as the journey a new PCB takes (data model v2 §8 J3,
 *): **Import → Pads → Connector → Builds → Guides**, each
 * a step with its completion state, beside the plain Definition.
 *
 * - **Import**: where the art, pads and definitions came from, which builds
 *   have definitions, and Re-run (the host's route, carrying any pad-map
 *   edits made here).
 * - **Pads**: the gerber art with every pad on it. Click a pad (or step
 *   through the ones to check with `n` / `p`) and pick its pad role and
 *   signal — saved at once, as owner corrections in `data/tags/review.json`,
 *   for every build of the board, so a re-import keeps them. Moving a pad to
 *   another terminal is a pad-map change: it is staged and applied by Re-run.
 * - **Connector**: the interface each connector footprint carries; the
 *   footprint's pads map onto its positions and every mismatch is flagged.
 * - **Builds**: the build editor.
 * - **Guides**: the entry-guide editor (the Library's Artwork pane).
 *
 * `useBoardJourney` holds what the steps share (the art, the build file and
 * its draft); `BoardJourneyStrip` is the step bar and `BoardJourneyStep` the
 * open step, so the Library places them without restructuring its detail.
 */

import {
  buildsFileName,
  footprintPadMap,
  rankFootprintInterfaces,
  suggestFootprintPads,
  validateBoardBuilds,
  type BoardBuilds,
  type BoardFootprint,
  type Db,
  type Issue,
  type PcbaDefinition,
  type SignalRef,
} from '@wirehub/model';
import { boardOutlineFromSvg, defaultEntryGuides, type DepictionArtwork } from '@wirehub/render-svg';
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleDashed,
  IconFileImport,
  IconMinus,
  IconRefresh,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type { ArtworkAdapter, DepictionMeta, EntryGuide } from '../artwork.ts';
import {
  allTerminals,
  boardBuildsFile,
  boardSiblings,
  cablePads,
  connectorPrefixes,
  journeySteps,
  padLandings,
  padTags,
  type BoardJourneyHost,
  type BuildsFileView,
  type StepId,
  type StepStatus,
} from '../board-journey.ts';
import { classes } from '../context.ts';
import type { PickOption, VocabAdapter } from '../vocab.ts';
import { signalRefOf, signalText } from '../vocab.ts';
import { artworkSrc } from './Artwork.tsx';
import { BuildEditor } from './BuildEditor.tsx';
import { PadMapArt, type ArtPad } from './PadMapArt.tsx';
import { Pick } from './Pick.tsx';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.ts';

type Part = NonNullable<DepictionMeta['components']>['parts'][number];

export const JOURNEY_STEPS: readonly { id: StepId; label: string; tab: string }[] = [
  { id: 'import', label: 'Import', tab: 'import' },
  { id: 'pads', label: 'Pads', tab: 'pads' },
  { id: 'connector', label: 'Connector', tab: 'connector' },
  { id: 'builds', label: 'Builds', tab: 'builds' },
  // the Library's Artwork pane is where the entry guides are set
  { id: 'guides', label: 'Guides', tab: 'artwork' },
];

/** The detail tabs the journey renders itself (Guides is the Library's own Artwork pane). */
export function isJourneyTab(tab: string): tab is 'import' | 'pads' | 'connector' | 'builds' {
  return tab === 'import' || tab === 'pads' || tab === 'connector' || tab === 'builds';
}

const GUIDE_SRC = 'Default (inferred): square to the row approach axis, outside the Edge.Cuts outline.';

/* ------------------------------------------------------------------ *
 * The shared state
 * ------------------------------------------------------------------ */

export interface BoardJourneyArgs {
  enabled: boolean;
  db: Db;
  def: PcbaDefinition | undefined;
  host: BoardJourneyHost | undefined;
  artwork?: ArtworkAdapter;
  vocab?: VocabAdapter;
  /** tags were written — the host reloads its db */
  onVocabChange?: () => void;
}

export interface BoardJourney {
  enabled: boolean;
  db: Db;
  def: PcbaDefinition;
  siblings: PcbaDefinition[];
  host: BoardJourneyHost;
  vocab?: VocabAdapter;
  meta: DepictionMeta | undefined;
  top: string | undefined;
  bottom: string | undefined;
  /** every part any build of the board mounts */
  parts: Part[] | undefined;
  files: BuildsFileView[] | undefined;
  filesError: string | undefined;
  /** the board's build file as stored, and the draft being edited */
  stored: BuildsFileView | undefined;
  draft: BoardBuilds | undefined;
  setDraft: (next: BoardBuilds) => void;
  dirty: boolean;
  /** core's errors on the draft, live — a save waits for none */
  draftErrors: Issue[];
  save: () => Promise<void>;
  revert: () => void;
  saving: boolean;
  saveProblem: { message: string; issues: Issue[] } | undefined;
  saveNote: string | undefined;
  steps: StepStatus[];
  /** the art and the build files have been read (or failed to be) */
  loaded: boolean;
  /** pad → terminal moves waiting for a re-run */
  padEdits: Record<string, string | null>;
  setPadEdits: (next: Record<string, string | null>) => void;
  /** tags just written, shown until the host's db has them */
  tagOverlay: Record<string, { role?: string | null; signal?: SignalRef | null }>;
  saveTag: (terminal: string, patch: { role?: string | null; signal?: SignalRef | null }, allBuilds: boolean) => Promise<string | undefined>;
  selectedBuild: string;
  setSelectedBuild: (key: string) => void;
  loadParts: () => void;
}

/** A new board's first build file: one as-designed build, as the importer already treats it. */
export function starterBuilds(def: PcbaDefinition, siblings: readonly PcbaDefinition[]): BoardBuilds {
  const prefixes = connectorPrefixes(def);
  return {
    board: def.partNumber,
    label: def.label.replace(/\s*[—-]\s*[^—-]*$/, '') || def.label,
    end: 'source',
    ...(prefixes.length === 0 ? {} : { footprints: [] }),
    builds: siblings.map((s, n) => ({
      key: n === 0 ? 'as-designed' : `build-${n + 1}`,
      idSuffix: s.id.startsWith(`${def.partNumber.toLowerCase()}-${def.revision.toLowerCase()}`) ? s.id.slice(`${def.partNumber.toLowerCase()}-${def.revision.toLowerCase()}`.length) : '',
      build: s.build ?? 'as-designed',
      src: `Started in the studio from the imported definition ${s.id} (${s.build ?? 'as-designed'}); population as the importer made it.`,
    })),
  };
}

export function useBoardJourney(args: BoardJourneyArgs): BoardJourney | undefined {
  const { enabled, db, def, host, artwork } = args;
  const defId = def?.id;
  const [meta, setMeta] = useState<DepictionMeta | undefined>(undefined);
  const [art, setArt] = useState<Record<string, DepictionArtwork>>({});
  const [parts, setParts] = useState<Part[] | undefined>(undefined);
  const [files, setFiles] = useState<BuildsFileView[] | undefined>(undefined);
  const [filesError, setFilesError] = useState<string | undefined>(undefined);
  const [draft, setDraftState] = useState<BoardBuilds | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<{ message: string; issues: Issue[] } | undefined>(undefined);
  const [saveNote, setSaveNote] = useState<string | undefined>(undefined);
  const [padEdits, setPadEdits] = useState<Record<string, string | null>>({});
  const [tagOverlay, setTagOverlay] = useState<BoardJourney['tagOverlay']>({});
  const [selectedBuild, setSelectedBuild] = useState('');
  const [artDone, setArtDone] = useState(false);
  const siblings = useMemo(() => (def === undefined ? [] : boardSiblings(db, def)), [db, def]);

  // the art of this definition
  useEffect(() => {
    setMeta(undefined);
    setArt({});
    setParts(undefined);
    setPadEdits({});
    setTagOverlay({});
    setArtDone(false);
    if (!enabled || artwork === undefined || defId === undefined) return;
    let live = true;
    void (async () => {
      const detail = await artwork.detail(defId);
      if (!live) return;
      if (!detail.ok) {
        setArtDone(true);
        return;
      }
      setMeta(detail.value.meta);
      const bytes: Record<string, DepictionArtwork> = {};
      for (const view of ['board-top', 'board-bottom']) {
        if (detail.value.meta?.views[view] === undefined) continue;
        const b = await artwork.artwork(defId, view);
        if (b.ok) bytes[view] = b.value;
      }
      if (live) {
        setArt(bytes);
        setArtDone(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, artwork, defId]);

  // a fresh db has the tags just written
  useEffect(() => setTagOverlay({}), [db]);

  const builds = host?.builds;
  const reloadFiles = useCallback(async (): Promise<BuildsFileView[] | undefined> => {
    if (builds === undefined) return undefined;
    const r = await builds.list();
    if (!r.ok) {
      setFilesError(r.message);
      return undefined;
    }
    setFilesError(undefined);
    setFiles(r.value.files);
    return r.value.files;
  }, [builds]);
  useEffect(() => {
    if (enabled) void reloadFiles();
  }, [enabled, reloadFiles]);

  const stored = useMemo(() => (files === undefined || def === undefined ? undefined : boardBuildsFile(files, def)), [files, def]);
  // the draft follows the stored file whenever it (or the board) changes
  const storedKey = `${defId}|${stored?.etag ?? stored?.name ?? ''}`;
  const lastKey = useRef('');
  useEffect(() => {
    if (lastKey.current === storedKey) return;
    lastKey.current = storedKey;
    setDraftState(stored === undefined ? undefined : structuredClone(stored.file));
    setSaveProblem(undefined);
    setSelectedBuild((current) => {
      const keys = stored?.file.builds.map((b) => b.key) ?? [];
      const own = stored?.file.builds.find((b) => b.build === def?.build)?.key;
      return keys.includes(current) ? current : (own ?? keys[0] ?? '');
    });
  }, [storedKey, stored, def]);

  const loadParts = useCallback((): void => {
    if (parts !== undefined || artwork === undefined) return;
    void (async () => {
      const byRef = new Map<string, Part>();
      for (const s of siblings) {
        const d = await artwork.detail(s.id);
        for (const p of d.ok ? (d.value.meta?.components?.parts ?? []) : []) if (!byRef.has(p.ref)) byRef.set(p.ref, p);
      }
      setParts([...byRef.values()]);
    })();
  }, [parts, artwork, siblings]);

  const topSource = art['board-top']?.kind === 'vector' ? art['board-top'].source : undefined;
  const guidesNeeded = useMemo<EntryGuide[]>(
    () => (meta === undefined ? [] : defaultEntryGuides(meta, topSource === undefined ? undefined : boardOutlineFromSvg(topSource), GUIDE_SRC)),
    [meta, topSource],
  );

  const dirty = draft !== undefined && (stored === undefined || JSON.stringify(draft) !== JSON.stringify(stored.file));
  useUnsavedChangesGuard(dirty);
  const draftErrors = useMemo(
    () =>
      draft === undefined
        ? []
        : validateBoardBuilds([draft], {
            pcbas: db.pcbas,
            ...(db.interfaces === undefined ? {} : { interfaces: db.interfaces }),
            ...(db.vocab === undefined ? {} : { vocab: db.vocab }),
          }).filter((i) => i.severity === 'error'),
    [draft, db],
  );
  const steps = useMemo(
    () => (def === undefined ? [] : journeySteps({ db: withTagOverlay(db, def, tagOverlay), def, meta, files, draft, guidesNeeded })),
    [db, def, meta, files, draft, guidesNeeded, tagOverlay],
  );

  if (!enabled || def === undefined || host === undefined) return undefined;

  const save = async (): Promise<void> => {
    if (draft === undefined || builds === undefined) return;
    setSaving(true);
    setSaveProblem(undefined);
    const name = stored?.name ?? buildsFileName(draft);
    const r = await builds.save(name, draft, stored?.etag);
    setSaving(false);
    if (!r.ok) {
      setSaveProblem({ message: `${r.message}${r.hint === undefined ? '' : ` ${r.hint}`}`, issues: r.issues ?? [] });
      return;
    }
    setSaveNote(r.value.created ? `created builds/${name}.json` : `saved builds/${name}.json`);
    await reloadFiles();
  };

  const saveTag = async (terminal: string, patch: { role?: string | null; signal?: SignalRef | null }, allBuilds: boolean): Promise<string | undefined> => {
    const vocab = args.vocab;
    if (vocab === undefined) return 'This studio cannot save tags.';
    const targets = (allBuilds ? siblings : [def]).filter((d) => d.terminals.some((t) => t.id === terminal));
    setTagOverlay((o) => ({ ...o, [terminal]: { ...o[terminal], ...patch } }));
    for (const target of targets) {
      const r = await vocab.saveTags({ kind: 'pcbas', id: target.id, tags: { [terminal]: patch } });
      if (!r.ok) {
        setTagOverlay((o) => {
          const { [terminal]: _drop, ...rest } = o;
          return rest;
        });
        return `${target.id}: ${r.message}`;
      }
    }
    args.onVocabChange?.();
    return undefined;
  };

  return {
    enabled,
    db,
    def,
    siblings,
    host,
    ...(args.vocab === undefined ? {} : { vocab: args.vocab }),
    meta,
    top: artworkSrc(art['board-top']),
    bottom: artworkSrc(art['board-bottom']),
    parts,
    files,
    filesError,
    stored,
    draft,
    setDraft: (next) => {
      setSaveNote(undefined);
      setDraftState(next);
    },
    dirty,
    draftErrors,
    save,
    revert: () => {
      setSaveProblem(undefined);
      setDraftState(stored === undefined ? undefined : structuredClone(stored.file));
    },
    saving,
    saveProblem,
    saveNote,
    steps,
    loaded: artDone && (files !== undefined || filesError !== undefined || builds === undefined),
    padEdits,
    setPadEdits,
    tagOverlay,
    saveTag,
    selectedBuild,
    setSelectedBuild,
    loadParts,
  };
}

/** `db` with the tags just written laid over the table, for the step states. */
function withTagOverlay(db: Db, def: PcbaDefinition, overlay: BoardJourney['tagOverlay']): Db {
  if (Object.keys(overlay).length === 0) return db;
  const table = { ...(db.tags?.pcbas?.[def.id] ?? {}) };
  for (const [terminal, patch] of Object.entries(overlay)) {
    const next: { role?: string; signal?: SignalRef } = { ...table[terminal] };
    if (patch.role !== undefined) {
      if (patch.role === null) delete next.role;
      else next.role = patch.role;
    }
    if (patch.signal !== undefined) {
      if (patch.signal === null) delete next.signal;
      else next.signal = patch.signal;
    }
    table[terminal] = next;
  }
  return { ...db, tags: { src: db.tags?.src ?? '', ...db.tags, pcbas: { ...(db.tags?.pcbas ?? {}), [def.id]: table } } };
}

/* ------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------ */

function StateIcon(props: { state: StepStatus['state'] }): JSX.Element {
  if (props.state === 'done') return <IconCheck size={13} stroke={2.25} className="cs-bj-st is-done" aria-hidden="true" />;
  if (props.state === 'warn') return <IconAlertTriangle size={13} stroke={2} className="cs-bj-st is-warn" aria-hidden="true" />;
  if (props.state === 'none') return <IconMinus size={13} stroke={2} className="cs-bj-st is-none" aria-hidden="true" />;
  return <IconCircleDashed size={13} stroke={2} className="cs-bj-st is-todo" aria-hidden="true" />;
}

export function BoardJourneyStrip(props: { journey: BoardJourney; tab: string; onTab: (tab: string) => void }): JSX.Element {
  const { journey } = props;
  const ready = journey.steps.length > 0 && journey.steps.every((s) => s.state === 'done' || s.state === 'none');
  return (
    <nav className="cs-bj-strip" aria-label="board steps">
      <ol>
        {JOURNEY_STEPS.map((step, n) => {
          const status = journey.steps.find((s) => s.id === step.id);
          return (
            <li key={step.id}>
              <button
                type="button"
                aria-current={props.tab === step.tab ? 'step' : undefined}
                className={classes(props.tab === step.tab && 'is-on', status !== undefined && `is-${status.state}`)}
                title={status?.title}
                onClick={() => props.onTab(step.tab)}
              >
                <span className="cs-bj-n">{n + 1}</span>
                <span className="cs-bj-name">{step.label}</span>
                {status === undefined ? null : <StateIcon state={status.state} />}
                <span className="cs-bj-note">{status?.note}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <span className={classes('cs-chip', ready && 'is-done')} title={ready ? 'Every step is done: the builder draws this board from its art, pads and builds' : 'Steps left to do'}>
        {ready ? 'ready' : `${journey.steps.filter((s) => s.state === 'todo' || s.state === 'warn').length} to do`}
      </span>
      <button type="button" className={classes('cs-bj-deftab', props.tab === 'definition' && 'is-on')} aria-pressed={props.tab === 'definition'} onClick={() => props.onTab('definition')}>
        Definition
      </button>
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * The open step
 * ------------------------------------------------------------------ */

export function BoardJourneyStep(props: { journey: BoardJourney; tab: 'import' | 'pads' | 'connector' | 'builds' }): JSX.Element {
  const { journey } = props;
  if (props.tab === 'import') return <ImportStep journey={journey} />;
  if (props.tab === 'pads') return <PadsStep journey={journey} />;
  if (props.tab === 'connector') return <ConnectorStep journey={journey} />;
  return <BuildsStep journey={journey} />;
}

function SaveBar(props: { journey: BoardJourney; what: string }): JSX.Element | null {
  const { journey } = props;
  if (journey.host.builds === undefined) return <p className="cs-bj-hint">This studio cannot save build files.</p>;
  return (
    <div className="cs-bj-savebar">
      <span className="cs-mono cs-dim" title="The build file this board reads">
        builds/{journey.stored?.name ?? (journey.draft === undefined ? '—' : buildsFileName(journey.draft))}.json
      </span>
      <span className="cs-spacer" />
      {journey.saveNote === undefined || journey.dirty ? null : <span className="cs-chip is-done">{journey.saveNote}</span>}
      {journey.dirty ? <span className="cs-chip is-dirty">unsaved</span> : null}
      <button type="button" disabled={!journey.dirty || journey.saving} onClick={journey.revert}>
        Revert
      </button>
      <button
        type="button"
        className="cs-primary"
        disabled={!journey.dirty || journey.saving || journey.draftErrors.length > 0}
        title={journey.draftErrors.length > 0 ? `Fix ${journey.draftErrors.length} issue${journey.draftErrors.length === 1 ? '' : 's'} first` : `Check and write ${props.what}`}
        onClick={() => void journey.save()}
      >
        {journey.saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function SaveProblem(props: { journey: BoardJourney }): JSX.Element | null {
  const p = props.journey.saveProblem;
  if (p === undefined) return null;
  return (
    <div className="cs-problem" role="alert">
      <strong>{p.message}</strong>
      {p.issues.length === 0 ? null : (
        <ul className="cs-problem-list">
          {p.issues.map((i, n) => (
            <li key={n}>
              <span className="cs-mono">{i.code}</span> {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---- Import ---- */

function ImportStep(props: { journey: BoardJourney }): JSX.Element {
  const { journey } = props;
  const { def, meta, draft } = journey;
  const edits = Object.keys(journey.padEdits).length;
  const rerun = (): void => journey.host.onImport?.({ partNumber: def.partNumber, revision: def.revision }, edits === 0 ? undefined : { pads: journey.padEdits });
  return (
    <section className="cs-bj-step">
      <div className="cs-bj-toolbar">
        <strong>
          {def.partNumber} {def.revision}
        </strong>
        <span className="cs-spacer" />
        {journey.host.onImport === undefined ? null : (
          <button type="button" className={edits > 0 || journey.steps[0]?.state !== 'done' ? 'cs-primary' : ''} onClick={rerun} title="Run the board's import again: art, pad map, definitions — nothing is written until you publish">
            {meta === undefined ? <IconFileImport size={14} stroke={1.75} aria-hidden="true" /> : <IconRefresh size={14} stroke={1.75} aria-hidden="true" />}
            {meta === undefined ? 'Import' : edits > 0 ? `Re-run with ${edits} pad move${edits === 1 ? '' : 's'}` : 'Re-run import'}
          </button>
        )}
      </div>
      <table className="cs-bj-table">
        <tbody>
          {(meta?.sources ?? []).map((s) => (
            <tr key={s.path}>
              <th scope="row">{s.role}</th>
              <td className="cs-mono cs-bj-path-cell" title={`sha256 ${s.sha256}`}>
                {s.path}
              </td>
            </tr>
          ))}
          {meta?.sources === undefined || meta.sources.length === 0 ? (
            <tr>
              <th scope="row">art</th>
              <td className="cs-dim">{meta === undefined ? 'none yet' : 'no source files recorded'}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <h4 className="cs-bj-h">Builds → definitions</h4>
      <table className="cs-bj-table">
        <tbody>
          {(draft?.builds ?? []).map((b) => {
            const defs = journey.siblings.filter((s) => s.build === b.build);
            return (
              <tr key={b.key}>
                <th scope="row" className="cs-mono">
                  {b.key}
                </th>
                <td>
                  {defs.length === 0 ? (
                    <span className="cs-bj-bad" title="Re-run the import to emit it">
                      not emitted
                    </span>
                  ) : (
                    defs.map((d) => (
                      <span key={d.id} className={classes('cs-mono', d.id === def.id && 'cs-bj-me')}>
                        {d.id}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            );
          })}
          {draft === undefined ? (
            <tr>
              <th scope="row">—</th>
              <td className="cs-dim">
                {journey.siblings.map((s) => s.id).join(' · ')} · no build file
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

/* ---- Pads ---- */

interface PadRow {
  terminal: string;
  role?: string;
  signal?: SignalRef;
  anchored: boolean;
}

function PadsStep(props: { journey: BoardJourney }): JSX.Element {
  const { journey } = props;
  const { db, def, meta } = journey;
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [allBuilds, setAllBuilds] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const firstControl = useRef<HTMLDivElement>(null);

  const tagsOf = (terminal: string): { role?: string; signal?: SignalRef } => {
    const base = padTags(db, def, terminal);
    const over = journey.tagOverlay[terminal];
    if (over === undefined) return base;
    const role = over.role === undefined ? base.role : (over.role ?? undefined);
    const signal = over.signal === undefined ? base.signal : (over.signal ?? undefined);
    return { ...(role === undefined ? {} : { role }), ...(signal === undefined ? {} : { signal }) };
  };
  const rows: PadRow[] = cablePads(def).map((terminal) => ({ terminal, ...tagsOf(terminal), anchored: meta?.pinAnchors[terminal] !== undefined }));
  const uncertain = new Set(rows.filter((r) => r.role === undefined || !r.anchored).map((r) => r.terminal));
  const roleLabel = (id: string | undefined): string => (id === undefined ? '' : (db.vocab?.['pad-roles']?.entries.find((e) => e.id === id)?.label.replace(/ pad$/, '') ?? id));

  // one art pad per physical copper pad
  const pads: ArtPad[] = [];
  for (const row of rows) {
    const anchor = meta?.pinAnchors[row.terminal];
    if (anchor === undefined) continue;
    const physical = anchor.pads ?? [{ ref: row.terminal, pad: '1', x: anchor.x, y: anchor.y, side: anchor.side ?? 'top' }];
    for (const p of physical) {
      const key = `${p.ref}#${p.pad}`;
      const moved = journey.padEdits[key];
      const terminal = moved === undefined ? row.terminal : (moved ?? '—');
      pads.push({
        key,
        x: p.x,
        y: p.y,
        side: p.side,
        group: row.terminal,
        label: terminal,
        tone: moved !== undefined ? 'accent' : uncertain.has(row.terminal) ? 'warn' : 'ok',
        title: `${key} → ${terminal}${row.role === undefined ? ' · no role' : ` · ${roleLabel(row.role)}`}`,
      });
    }
  }
  const uncertainKeys = pads.filter((p) => p.tone === 'warn').map((p) => p.key);
  const pad = pads.find((p) => p.key === selected);
  const terminal = pad?.group;
  const row = rows.find((r) => r.terminal === terminal);
  const terminalOptions: PickOption[] = rows.map((r) => ({ value: r.terminal, label: r.terminal }));

  const put = async (patch: { role?: string | null; signal?: SignalRef | null }): Promise<void> => {
    if (terminal === undefined) return;
    setStatus({ ok: true, text: 'saving…' });
    const problem = await journey.saveTag(terminal, patch, allBuilds);
    const n = allBuilds ? journey.siblings.filter((d) => d.terminals.some((t) => t.id === terminal)).length : 1;
    setStatus(problem === undefined ? { ok: true, text: `saved · ${n} build${n === 1 ? '' : 's'}` } : { ok: false, text: problem });
  };

  const frame = meta?.views['board-top'];
  return (
    <section className="cs-bj-step cs-bj-pads">
      <div className="cs-bj-toolbar">
        <span className={classes('cs-chip', uncertain.size === 0 && 'is-done')}>{uncertain.size === 0 ? 'all pads set' : `${uncertain.size} to check`}</span>
        <span className="cs-bj-keys" title="With the art focused">
          <kbd>n</kbd>/<kbd>p</kbd> next to check · <kbd>↑</kbd><kbd>↓</kbd> every pad · <kbd>Enter</kbd> edit
        </span>
        <span className="cs-spacer" />
        <label className="cs-bj-check" title="Tags are kept per definition: write this pad's tags on every build of the board">
          <input type="checkbox" checked={allBuilds} onChange={(e) => setAllBuilds(e.target.checked)} /> all {journey.siblings.length} builds
        </label>
      </div>
      <div className="cs-bj-padgrid">
        {frame?.widthUnits === undefined || frame.heightUnits === undefined ? (
          <p className="cs-empty">{meta === undefined ? 'No board art yet — run the import.' : 'The art has no frame.'}</p>
        ) : (
          <PadMapArt
            frame={{ width: frame.widthUnits, height: frame.heightUnits }}
            {...(journey.top === undefined ? {} : { top: journey.top })}
            {...(journey.bottom === undefined ? {} : { bottom: journey.bottom })}
            pads={pads}
            {...(selected === undefined ? {} : { selected })}
            onSelect={(key) => {
              setSelected(key);
              setStatus(undefined);
            }}
            uncertain={uncertainKeys}
            onEnter={() => firstControl.current?.querySelector<HTMLElement>('[aria-label^="pad role"]')?.focus()}
            label="board pads — click one"
          />
        )}
        <div className="cs-bj-card" ref={firstControl}>
          {pad === undefined || row === undefined ? (
            <p className="cs-empty">Pick a pad on the art.</p>
          ) : (
            <>
              <header>
                <strong className="cs-mono">{row.terminal}</strong>
                <span className="cs-mono cs-dim">{pad.key}</span>
                <span className="cs-dim">{pads.find((p) => p.key === pad.key)?.side}</span>
                {uncertain.has(row.terminal) ? <span className="cs-chip is-warn">check</span> : <span className="cs-chip is-done">set</span>}
              </header>
              <label className="cs-bj-text" title="The terminal this copper pad belongs to. A move is a pad-map change: it is applied by re-running the import.">
                <span>Terminal</span>
                <Pick
                  ariaLabel={`terminal of ${pad.key}`}
                  options={terminalOptions}
                  value={journey.padEdits[pad.key] === undefined ? row.terminal : (journey.padEdits[pad.key] ?? '')}
                  mono
                  allowCustom
                  clearable
                  noneLabel="not a terminal"
                  onChange={(v) => {
                    const next = { ...journey.padEdits };
                    if (v === row.terminal) delete next[pad.key];
                    else next[pad.key] = v === '' ? null : v;
                    journey.setPadEdits(next);
                  }}
                />
              </label>
              <label className="cs-bj-text" title="Which pad this is for the cable (the pad-roles list)">
                <span>Pad role</span>
                <Pick list="pad-roles" ariaLabel={`pad role of ${row.terminal}`} value={row.role ?? ''} clearable noneLabel="untagged" onChange={(v) => void put({ role: v === '' ? null : v })} />
              </label>
              <label className="cs-bj-text" title="What the pad carries, where the board says more than its role">
                <span>Signal</span>
                <Pick
                  list="signals"
                  ariaLabel={`signal of ${row.terminal}`}
                  value={signalText(row.signal)}
                  clearable
                  noneLabel="untagged"
                  onChange={(v) => void put({ signal: signalRefOf(v) ?? null })}
                />
              </label>
              {status === undefined ? null : <p className={classes('cs-bj-hint', status.ok ? 'is-ok' : 'is-bad')}>{status.text}</p>}
              {Object.keys(journey.padEdits).length === 0 || journey.host.onImport === undefined ? null : (
                <button
                  type="button"
                  className="cs-primary"
                  onClick={() => journey.host.onImport?.({ partNumber: def.partNumber, revision: def.revision }, { pads: journey.padEdits })}
                  title="Pad moves change the reviewed pad map: the import re-runs with them, and you publish the result"
                >
                  <IconRefresh size={13} stroke={1.75} aria-hidden="true" /> Re-run with {Object.keys(journey.padEdits).length} move{Object.keys(journey.padEdits).length === 1 ? '' : 's'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <table className="cs-bj-table cs-bj-padtable">
        <thead>
          <tr>
            <th>Pad</th>
            <th>Role</th>
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.terminal}
              className={classes(uncertain.has(r.terminal) && 'is-warn', r.terminal === terminal && 'is-on')}
              onClick={() => setSelected(pads.find((p) => p.group === r.terminal)?.key)}
            >
              <td className="cs-mono">{r.terminal}</td>
              <td>{r.role === undefined ? <span className="cs-bj-bad">none</span> : roleLabel(r.role)}</td>
              <td className="cs-mono">{signalText(r.signal) || <span className="cs-dim">—</span>}</td>
              {r.anchored ? null : (
                <td>
                  <span className="cs-bj-bad" title="No pad on the art lands this terminal">
                    not on art
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ---- Connector ---- */

function ConnectorStep(props: { journey: BoardJourney }): JSX.Element {
  const { journey } = props;
  const { db, def, meta, draft } = journey;
  const prefixes = connectorPrefixes(def);
  const terminals = useMemo(() => [...new Set(journey.siblings.flatMap((d) => allTerminals(d)))], [journey.siblings]);
  const signals = useMemo(() => Object.fromEntries(terminals.map((t) => [t, padTags(db, def, t).signal])), [terminals, db, def]);
  const landings = useMemo(() => padLandings(db, def), [db, def]);
  const [open, setOpen] = useState<string | undefined>(prefixes[0]);
  const interfaces = db.interfaces ?? [];

  if (prefixes.length === 0) {
    return (
      <section className="cs-bj-step">
        <p className="cs-empty">No connector footprint on this board — its cable pads are all there is.</p>
      </section>
    );
  }
  if (draft === undefined) {
    return (
      <section className="cs-bj-step">
        <NoBuildFile journey={journey} />
      </section>
    );
  }
  const footprint = (prefix: string): BoardFootprint | undefined => draft.footprints?.find((f) => f.prefix === prefix);
  const setFootprint = (prefix: string, next: BoardFootprint | undefined): void => {
    const rest = (draft.footprints ?? []).filter((f) => f.prefix !== prefix);
    journey.setDraft({ ...draft, footprints: next === undefined ? rest : [...rest, next].sort((a, b) => a.prefix.localeCompare(b.prefix)) });
  };
  const current = open === undefined ? undefined : footprint(open);
  const iface = current === undefined ? undefined : interfaces.find((i) => i.id === current.interface);
  const map = open === undefined ? undefined : footprintPadMap(current ?? { prefix: open }, iface, terminals, signals, db.vocab, { landings });
  // offered only when it would land more tagged pads than the map in use
  const suggested = open === undefined || iface === undefined ? undefined : suggestFootprintPads({ prefix: open }, iface, terminals, signals, db.vocab);
  const suggestion =
    suggested !== undefined && map !== undefined && suggested.ok > map.rows.filter((r) => r.status === 'ok').length ? suggested : undefined;

  const frame = meta?.views['board-top'];
  const byTerminal = new Map((map?.rows ?? []).map((r) => [r.terminal, r]));
  const pads: ArtPad[] = [];
  for (const [terminal, anchor] of Object.entries(meta?.pinAnchors ?? {})) {
    const row = byTerminal.get(terminal);
    for (const p of anchor.pads ?? [{ ref: terminal, pad: '1', x: anchor.x, y: anchor.y, side: anchor.side ?? 'top' }]) {
      pads.push({
        key: `${terminal}:${p.ref}#${p.pad}`,
        x: p.x,
        y: p.y,
        side: p.side,
        group: terminal,
        label: row === undefined ? '' : (row.position ?? '?'),
        tone: row === undefined ? 'dim' : row.status === 'ok' || row.status === 'untagged' || row.status === 'dual-landing' ? 'ok' : 'err',
        title: row === undefined ? terminal : `${terminal} → ${row.position ?? 'no position'}${row.signal === undefined ? '' : ` · ${row.label ?? signalText(row.signal)}`}${row.status === 'signal-mismatch' ? ` · tagged ${signalText(row.padSignal)}` : ''}${row.status === 'dual-landing' ? ` · also lands the ${signalText(row.padSignal)} wire (${row.landing})` : ''}`,
      });
    }
  }

  return (
    <section className="cs-bj-step">
      <SaveBar journey={journey} what="the connector footprints into the build file" />
      <SaveProblem journey={journey} />
      <nav className="cs-bj-buildtabs" aria-label="footprints">
        {prefixes.map((prefix) => {
          const fp = footprint(prefix);
          const m = footprintPadMap(fp ?? { prefix }, interfaces.find((i) => i.id === fp?.interface), terminals, signals, db.vocab, { landings });
          return (
            <button key={prefix} type="button" aria-pressed={prefix === open} className={classes(prefix === open && 'is-on')} onClick={() => setOpen(prefix)}>
              <span className="cs-mono">{prefix}.*</span>
              {fp === undefined ? <span className="cs-bj-count is-warn">?</span> : m.mismatches > 0 ? <span className="cs-bj-count is-err">{m.mismatches}</span> : <IconCheck size={12} stroke={2} className="cs-bj-ok" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>
      {open === undefined || map === undefined ? null : (
        <div className="cs-bj-padgrid">
          {frame?.widthUnits === undefined || frame.heightUnits === undefined ? (
            <p className="cs-empty">No board art.</p>
          ) : (
            <PadMapArt
              frame={{ width: frame.widthUnits, height: frame.heightUnits }}
              {...(journey.top === undefined ? {} : { top: journey.top })}
              {...(journey.bottom === undefined ? {} : { bottom: journey.bottom })}
              pads={pads}
              onSelect={() => undefined}
              uncertain={pads.filter((p) => p.tone === 'err').map((p) => p.key)}
              label="footprint pads"
            />
          )}
          <div className="cs-bj-card">
            <label className="cs-bj-text is-wide" title="The pinout the mated connector carries: footprint pads land on its positions">
              <span>Interface</span>
              <Pick
                ariaLabel={`interface of ${open}`}
                options={rankFootprintInterfaces({ prefix: open }, interfaces, terminals, signals, db.vocab).map(({ iface: i, map: m }) => ({
                  value: i.id,
                  label: i.label,
                  hint: `${m.rows.length - m.mismatches}/${m.rows.length} pads`,
                }))}
                value={current?.interface ?? ''}
                clearable
                noneLabel="none"
                onChange={(v) => setFootprint(open, v === '' ? undefined : { prefix: open, interface: v, integrated: current?.integrated ?? false, ...(current?.pads === undefined ? {} : { pads: current.pads }) })}
              />
            </label>
            {current === undefined ? null : (
              <label className="cs-bj-check" title="The board carries the connector itself (a multi-out or SCART on the board)">
                <input type="checkbox" checked={current.integrated} onChange={(e) => setFootprint(open, { ...current, integrated: e.target.checked })} /> connector on the board
              </label>
            )}
            {current === undefined || iface === undefined || (suggestion === undefined && current.pads === undefined) ? null : (
              <div className="cs-bj-toolbar">
                {suggestion === undefined ? null : <button
                  type="button"
                  title={`Map the footprint pads onto the interface by their tagged signals${suggestion.mirrored ? ' — the socket numbers mirror the plug (n → max + 1 − n)' : ''}: ${suggestion.ok}/${suggestion.of} tagged pads then agree`}
                  onClick={() => {
                    const { pads: _old, ...rest } = current;
                    setFootprint(open, Object.keys(suggestion.pads).length === 0 ? rest : { ...rest, pads: suggestion.pads });
                  }}
                >
                  Map pads by signal{suggestion.mirrored ? ' (mirrored)' : ''} · {suggestion.ok}/{suggestion.of}
                </button>}
                {current.pads === undefined ? null : (
                  <span className="cs-mono cs-dim" title="The footprint's own pad → position map">
                    {Object.entries(current.pads)
                      .map(([pad, position]) => `${pad}→${position}`)
                      .join(' ')}
                  </span>
                )}
              </div>
            )}
            <p className={classes('cs-bj-hint', map.mismatches > 0 ? 'is-bad' : 'is-ok')}>
              {map.rows.length - map.mismatches}/{map.rows.length} pads land
              {map.mismatches > 0 ? ` · ${map.mismatches} mismatch${map.mismatches === 1 ? '' : 'es'}` : ''}
              {map.unlanded.length > 0 && iface !== undefined ? ` · unused ${map.unlanded.join(' ')}` : ''}
            </p>
            <table className="cs-bj-table">
              <thead>
                <tr>
                  <th>Pad</th>
                  <th>Position</th>
                  <th>Interface</th>
                  <th>Tagged</th>
                </tr>
              </thead>
              <tbody>
                {map.rows.map((r) => (
                  <tr key={r.terminal} className={classes((r.status === 'unknown-position' || r.status === 'signal-mismatch') && 'is-bad')}>
                    <td className="cs-mono">{r.terminal}</td>
                    <td className="cs-mono" title={r.by === undefined ? '' : `by ${r.by}`}>
                      {r.position ?? '—'}
                    </td>
                    <td>{r.label ?? signalText(r.signal)}</td>
                    <td className="cs-mono">
                      {signalText(r.padSignal)}
                      {r.status === 'signal-mismatch' ? <IconAlertTriangle size={12} stroke={2} className="cs-bj-st is-warn" aria-label="mismatch" /> : null}
                      {r.status === 'unknown-position' ? <span className="cs-bj-bad"> no position</span> : null}
                      {r.status === 'dual-landing' ? <span className="cs-dim" title="The pad takes the carrier's T-join and a wire from the wire side"> + wire at {r.landing}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function NoBuildFile(props: { journey: BoardJourney }): JSX.Element {
  const { journey } = props;
  if (journey.files === undefined) return <p className="cs-empty">{journey.filesError ?? 'Reading the build files…'}</p>;
  return (
    <div className="cs-bj-toolbar">
      <span className="cs-dim">No build file for {journey.def.partNumber}.</span>
      <button type="button" className="cs-primary" disabled={journey.host.builds === undefined} onClick={() => journey.setDraft(starterBuilds(journey.def, journey.siblings))} title="Start one from the imported definitions; nothing is written until Save">
        New build file
      </button>
    </div>
  );
}

/* ---- Builds ---- */

function BuildsStep(props: { journey: BoardJourney }): JSX.Element {
  const { journey } = props;
  const { loadParts } = journey;
  useEffect(() => loadParts(), [loadParts]);
  if (journey.draft === undefined) {
    return (
      <section className="cs-bj-step">
        <NoBuildFile journey={journey} />
      </section>
    );
  }
  return (
    <section className="cs-bj-step">
      <SaveBar journey={journey} what="the build file" />
      <SaveProblem journey={journey} />
      <BuildEditor
        db={journey.db}
        defs={journey.siblings}
        file={journey.draft}
        onChange={journey.setDraft}
        selected={journey.selectedBuild}
        onSelect={journey.setSelectedBuild}
        {...(journey.saveProblem === undefined ? {} : { serverIssues: journey.saveProblem.issues })}
        {...(journey.meta === undefined ? {} : { meta: journey.meta })}
        {...(journey.top === undefined ? {} : { top: journey.top })}
        {...(journey.bottom === undefined ? {} : { bottom: journey.bottom })}
        {...(journey.parts === undefined ? {} : { parts: journey.parts })}
        disabled={journey.host.builds === undefined}
      />
    </section>
  );
}

