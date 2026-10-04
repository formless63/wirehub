/**
 * The derived-data panels: nets, validation issues, and the trace readout for
 * the selected terminal. None of these are editable — they are `core` telling
 * you what the design you just edited actually means.
 */

import {
  deriveNets,
  netForTerminal,
  parseTerminalKey,
  terminalKey,
  trace,
  type CableDesign,
  type CompatibilityCode,
  type Issue,
  type Net,
} from '@wirehub/model';
import { depictionDiagnostics, type DepictionDiagnostic, type DepictionSource } from '@wirehub/render-svg';
import { IconNote } from '@tabler/icons-react';
import { useDeferredValue, useMemo, type JSX } from 'react';

import { classes, useEditorApi } from '../context.ts';
import type { EditorState } from '../store.ts';
import { floatingEndNote } from './Notes.tsx';

function TerminalButton({ terminalKey: key }: { terminalKey: string }): JSX.Element {
  const { dispatch } = useEditorApi();
  return (
    <button
      type="button"
      className="cs-link cs-term"
      onClick={() =>
        dispatch({ type: 'select', selection: { kind: 'terminal', ref: parseTerminalKey(key) } })
      }
    >
      {key}
    </button>
  );
}

/** The nets `core` derives from the joints — the editor never authors these. */
export function NetsPanel({ state }: { state: EditorState }): JSX.Element {
  const nets = useMemo(
    () => deriveNets(state.design, state.db),
    [state.design, state.db],
  );
  const selectedKey =
    state.selection?.kind === 'terminal' ? terminalKey(state.selection.ref) : undefined;
  const selectedNet: Net | undefined =
    selectedKey === undefined ? undefined : netForTerminal(nets, selectedKey);

  return (
    <div className="cs-panel cs-nets">
      <h2>
        nets <span className="cs-count">{nets.length}</span>
      </h2>
      <div className="cs-scroll">
        {nets.map((net) => (
          <div
            key={net.id}
            className={classes('cs-net', selectedNet?.id === net.id && 'is-selected')}
          >
            <h3>
              {net.id} <span className="cs-count">{net.terminals.length}</span>
            </h3>
            <div className="cs-net-terms">
              {net.terminals.map((terminal) => (
                <TerminalButton key={terminal.key} terminalKey={terminal.key} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Warnings a design note naming the terminal (`issue.where`) silences — `noteReferencesTerminal`. */
const NOTE_FIXABLE: ReadonlySet<string> = new Set(['floating-conductor-end', 'screen-floating']);

function IssueRow({ issue, notes }: { issue: Issue; notes?: readonly string[] }): JSX.Element {
  const { dispatch } = useEditorApi();
  const fix = notes !== undefined && issue.where !== undefined && NOTE_FIXABLE.has(issue.code);
  return (
    <div className={classes('cs-issue', `is-${issue.severity}`, fix && 'has-fix')}>
      <span className="cs-issue-code">{issue.code}</span>
      <span className="cs-issue-message">{issue.message}</span>
      {issue.where === undefined ? null : <span className="cs-issue-where">{issue.where}</span>}
      {!fix ? null : (
        <button
          type="button"
          className="cs-icon-btn cs-issue-fix"
          title={`Deliberate — add a design note naming ${issue.where}`}
          aria-label={`add a design note naming ${issue.where}`}
          onClick={() => dispatch({ type: 'set-notes', notes: [...notes, floatingEndNote(issue.where as string)] })}
        >
          <IconNote size={14} />
        </button>
      )}
    </div>
  );
}

/** A block whose artwork exists but could not be used — worth an author's attention. */
const ARTWORK_PROBLEM: ReadonlySet<DepictionDiagnostic['status']> = new Set([
  'no-usable-view',
  'unreadable-asset',
  'unanchored-pin',
]);

function diagnosticText(d: DepictionDiagnostic): string {
  const missing = d.missing === undefined || d.missing.length === 0 ? '' : ` — no anchor for ${d.missing.join(', ')}`;
  const detail = d.detail === undefined ? '' : ` — ${d.detail}`;
  return `${d.instance} (${d.def})${d.view === undefined ? '' : ` ${d.view} view`}${missing}${detail}`;
}

/**
 * Why a block drew abstract: the schematic layout's own
 * depiction diagnostics, beside the validator's issues. Artwork that exists
 * but cannot be used is a warning row; blocks with no artwork at all are one
 * quiet line.
 */
function ArtworkDiagnostics({
  design,
  db,
  depictions,
}: {
  design: CableDesign;
  db: EditorState['db'];
  depictions: boolean | DepictionSource;
}): JSX.Element | null {
  // a layout pass per edit: deferred, so typing in the inspector never waits on it
  const deferred = useDeferredValue(design);
  const diagnostics = useMemo(() => {
    try {
      return depictionDiagnostics(deferred, db, { depictions });
    } catch {
      return [];
    }
  }, [deferred, db, depictions]);
  const problems = diagnostics.filter((d) => ARTWORK_PROBLEM.has(d.status));
  const plain = diagnostics.filter((d) => d.status === 'no-depiction').map((d) => d.instance);
  if (problems.length === 0 && plain.length === 0) return null;
  return (
    <div className="cs-issues-artwork">
      <h3>
        Schematic artwork {problems.length === 0 ? null : <span className="cs-count">{problems.length}</span>}
      </h3>
      {problems.map((d) => (
        <div key={`${d.instance}:${d.status}`} className="cs-issue is-warning">
          <span className="cs-issue-code">{d.status}</span>
          <span className="cs-issue-message">{diagnosticText(d)}</span>
        </div>
      ))}
      {plain.length === 0 ? null : (
        <p className="cs-issue-plain" title="No schematic artwork in the catalog for these parts: the schematic draws them as pin tables">
          no artwork: <span className="cs-mono">{plain.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

/** `joints[3]` → `3`; `undefined` for anything else (or no `where` at all). */
function jointIndexOf(where: string | undefined): number | undefined {
  const match = where === undefined ? null : /^joints\[(\d+)\]$/.exec(where);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * One compatibility warning: code + the joint's own two terminals, in mono —
 * not the validator's prose, which is `compatibilityIssues`' business, not
 * this row's. Clicking it selects the joint, exactly as clicking its edge on
 * the canvas would, so the Connection tab comes forward showing it.
 */
function CompatIssueRow({ design, issue }: { design: CableDesign; issue: Issue }): JSX.Element {
  const { dispatch } = useEditorApi();
  const index = jointIndexOf(issue.where);
  const joint = index === undefined ? undefined : design.joints[index];
  return (
    <button
      type="button"
      className="cs-issue cs-issue-compat is-warning"
      disabled={joint === undefined}
      onClick={() => {
        if (index === undefined) return;
        dispatch({ type: 'select', selection: { kind: 'joint', index } });
      }}
    >
      <span className="cs-issue-code">{issue.code}</span>
      {joint === undefined ? null : (
        <span className="cs-mono cs-issue-terms">
          {terminalKey(joint.a)} ↔ {terminalKey(joint.b)}
        </span>
      )}
    </button>
  );
}

/**
 * Codes `compatibilityIssues` reports — kept here just to split
 * `state.issues` into "everything else" and "Compatibility" below, since
 * `validateDesign` folds both into one list.
 */
const COMPAT_CODES: ReadonlySet<CompatibilityCode> = new Set([
  'shield-off-ground',
  'pin-to-foreign-pin',
  'board-to-board',
  'wire-to-itself',
]);
const isCompatIssue = (issue: Issue): boolean => COMPAT_CODES.has(issue.code as CompatibilityCode);

/**
 * `validateDesign` on the committed design (always in sync with it) — its
 * compatibility warnings (`compat.ts`) are split out into their own compact
 * group below rather than re-derived, so a design's warnings are counted and
 * shown exactly once.
 */
export function IssuesPanel({
  state,
  depictions = false,
}: {
  state: EditorState;
  /** the artwork the schematic draws from; `false` = none, and no Artwork group */
  depictions?: boolean | DepictionSource;
}): JSX.Element {
  const errorCount = state.issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = state.issues.length - errorCount;
  const { general, compat } = useMemo(() => {
    const general: Issue[] = [];
    const compat: Issue[] = [];
    for (const issue of state.issues) (isCompatIssue(issue) ? compat : general).push(issue);
    return { general, compat };
  }, [state.issues]);
  return (
    <div className="cs-panel cs-issues">
      <h2>
        validation{' '}
        <span className={classes('cs-count', errorCount > 0 && 'is-error')}>
          {errorCount} error{errorCount === 1 ? '' : 's'}
        </span>
        <span className="cs-count">{warningCount} warn</span>
      </h2>
      <div className="cs-scroll">
        {state.issues.length === 0 ? (
          <p className="cs-empty">clean</p>
        ) : (
          general.map((issue, index) => (
            <IssueRow key={`${issue.code}:${issue.where ?? ''}:${index}`} issue={issue} notes={state.design.notes ?? []} />
          ))
        )}
        {compat.length === 0 ? null : (
          <div className="cs-issues-compat">
            <h3>
              Compatibility <span className="cs-count">{compat.length}</span>
            </h3>
            {compat.map((issue, index) => (
              <CompatIssueRow
                key={`compat:${issue.where ?? ''}:${index}`}
                design={state.design}
                issue={issue}
              />
            ))}
          </div>
        )}
        {depictions === false ? null : <ArtworkDiagnostics design={state.design} db={state.db} depictions={depictions} />}
      </div>
    </div>
  );
}

/** `trace()` from the selected terminal — what a continuity spec derives from. */
export function TracePanel({ state }: { state: EditorState }): JSX.Element {
  const selection = state.selection;
  const result = useMemo(() => {
    if (selection?.kind !== 'terminal') return undefined;
    return trace(state.design, state.db, selection.ref);
  }, [selection, state.design, state.db]);

  return (
    <div className="cs-panel cs-trace">
      <h2>
        trace
        {result === undefined ? null : (
          <span className="cs-count">{result.reached.length} reached</span>
        )}
      </h2>
      <div className="cs-scroll">
        {result === undefined ? (
          <p className="cs-empty">select a pin to trace from it</p>
        ) : (
          <>
            <p className="cs-from">
              from <strong>{result.from.key}</strong>
              {result.from.label === undefined ? '' : ` — ${result.from.label}`}
            </p>
            {result.issues.map((issue, index) => (
              <IssueRow key={index} issue={issue} />
            ))}
            {result.reached.map((step) => (
              <div key={step.terminal.key} className="cs-step">
                <TerminalButton terminalKey={step.terminal.key} />
                <span className="cs-step-label">{step.terminal.label ?? ''}</span>
                {step.passages.length === 0 ? (
                  <span className="cs-passage cs-copper">copper</span>
                ) : (
                  step.passages.map((passage, index) => (
                    <span key={index} className="cs-passage">
                      through {passage.description}
                    </span>
                  ))
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
