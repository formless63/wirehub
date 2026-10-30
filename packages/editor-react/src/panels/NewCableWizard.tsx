/**
 * New cable — the guided flow.
 *
 * "New" used to make a blank document and leave a non-technical user staring at
 * an empty canvas. This is the replacement the spec asks for: six steps whose
 * answers the catalog can turn into a cable that is already wired, already
 * valid, and already drawable.
 *
 * The rules of this surface (specs/studio-workbench.md), and where each lives:
 *
 * - **Guided, and never dead-ending.** One question per screen, Back is always
 *   live, and a step that cannot be left says why in sentences (`stepBlockers`).
 * - **Every list is searchable**, and every row says what the thing *is* —
 *   family and pin count for a plug, part number and build for a board.
 * - **Units are explicit.** Length is millimetres, with the feet-and-inches it
 *   comes to underneath, live.
 * - **No raw JSON.** The review reads the generated joints as sentences, and
 *   draws the schematic; the document itself is never shown.
 * - **Nothing is invented.** Where the catalog is ambiguous the wizard asks
 *   (`openChoices`); where it is silent the review says what was left alone and
 *   why. All of that logic is in `wizard.ts`, which is pure and tested against
 *   the real catalog fixtures.
 */

import { cavityPins, type Db, type PcbaDefinition } from '@wirehub/model';
import { wireDisplayName } from '@wirehub/docs';
import type { DepictionSource } from '@wirehub/render-svg';
import { Component, useMemo, useReducer, useState, type ErrorInfo, type JSX, type ReactNode } from 'react';

import { useCoverSlot, type CoverSlotKind } from '../cover-slot.ts';
import { classes } from '../context.ts';
import { definitionDetail } from '../library.ts';
import { createWiredDesign, type CatalogChange, type LifecycleProblem } from '../lifecycle.ts';
import type { DesignSummary, PersistenceAdapter } from '../persistence.ts';
import { describeIssue } from '../store.ts';
import {
  CONNECT_MODES,
  LENGTH_PRESETS,
  IMPERIAL_LENGTH_PRESETS,
  STEP_SAY,
  STEP_TITLES,
  WIZARD_STEPS,
  describeLength,
  initialWizardState,
  maxLengthOf,
  parseLengthMm,
  planCable,
  plugPrefixes,
  stepBlockers,
  wizardReducer,
  type ConnectMode,
  type EndSide,
  type PlanLanding,
  type WizardState,
  type WizardStep,
} from '../wizard.ts';
import { Checkbox, Chip, RadioGroup, SegmentedControl, Select, Tooltip } from '../ui/index.ts';
import { PreviewPane } from './Preview.tsx';

export interface NewCableWizardProps {
  db: Db;
  persistence: PersistenceAdapter;
  /** the designs that already exist, so a suggested id never collides */
  designs?: DesignSummary[];
  /** the new design was written — the host opens it */
  onCatalogChange?: (change: CatalogChange) => void;
  onCancel: () => void;
  /** the escape hatch: make a blank design and wire it on the canvas instead */
  onBlank?: () => void;
  /** artwork for the review step's schematic, when the host has any */
  depictions?: boolean | DepictionSource;
}

/** The step numbers down the side, so it is obvious how far in this is. */
function StepRail(props: {
  state: WizardState;
  onGo: (step: WizardStep) => void;
}): JSX.Element {
  return (
    <ol className="cs-wizard-rail" aria-label="wizard steps">
      {WIZARD_STEPS.map((step, index) => (
        <li key={step}>
          <button
            type="button"
            className={classes(
              'cs-wizard-step',
              props.state.step === step && 'is-active',
              WIZARD_STEPS.indexOf(props.state.reached) >= index && 'is-reached',
            )}
            aria-current={props.state.step === step ? 'step' : undefined}
            onClick={() => props.onGo(step)}
          >
            <span className="cs-wizard-num">{index + 1}</span>
            <span>{STEP_TITLES[step]}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** the "nothing chosen" option of a Select (Radix needs a non-empty value) */
const NONE = '__none__';

interface PickerRow {
  id: string;
  label: string;
  detail: string;
  /** shown on hover; omitted where the id says nothing a person needs (a wire stock's) */
  hint?: string;
}

/**
 * The boards the picker offers: current revisions first, older ones (`legacy`,
 * `retired`) apart, behind a toggle. Part numbers keep the Library's order; one part number's
 * revisions run newest first.
 */
export function boardPickerOrder(pcbas: readonly PcbaDefinition[]): { current: PcbaDefinition[]; older: PcbaDefinition[] } {
  // a pack's board may carry no part number (or revision) at all
  const groupOf = (b: PcbaDefinition): string => ((b.partNumber ?? '').trim() === '' ? `#${b.id}` : (b.partNumber ?? '').trim().toLowerCase());
  const firstSeen = new Map<string, number>();
  pcbas.forEach((b, i) => { if (!firstSeen.has(groupOf(b))) firstSeen.set(groupOf(b), i); });
  const sorted = [...pcbas].sort((a, b) =>
    firstSeen.get(groupOf(a))! - firstSeen.get(groupOf(b))!
    || (b.revision ?? '').localeCompare(a.revision ?? '', undefined, { numeric: true, sensitivity: 'base' })
    || (a.build ?? '').localeCompare(b.build ?? '', undefined, { numeric: true }));
  const old = (b: PcbaDefinition): boolean => b.status === 'legacy' || b.status === 'retired';
  return { current: sorted.filter((b) => !old(b)), older: sorted.filter(old) };
}

/** A searchable list of parts. Every row says what the part is. */
function Picker(props: {
  legend: string;
  say: string;
  rows: PickerRow[];
  /** rows kept behind a "show older" toggle (a board's legacy and retired revisions) */
  older?: PickerRow[];
  value?: string | undefined;
  /** which shared cover to show beside each row, when the host provides covers */
  cover?: CoverSlotKind;
  onPick: (id: string) => void;
}): JSX.Element {
  const cover = useCoverSlot();
  const [query, setQuery] = useState('');
  const older = props.older ?? [];
  // an older revision already chosen stays visible
  const [showOlder, setShowOlder] = useState(() => older.some((row) => row.id === props.value));
  const needle = query.trim().toLowerCase();
  const matches = (row: PickerRow): boolean => needle === '' || `${row.id} ${row.label} ${row.detail}`.toLowerCase().includes(needle);
  const shown = [...props.rows, ...(showOlder ? older : [])].filter(matches);
  const olderHidden = showOlder ? 0 : older.filter(matches).length;
  return (
    <div className="cs-wizard-picker">
      <label className="cs-field" title={props.say}>
        <span>{props.legend}</span>
        <input
          className="cs-input"
          value={query}
          placeholder="search by name, part number or family"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {older.length === 0 ? null : (
        <Checkbox className="cs-wizard-older" checked={showOlder} onCheckedChange={setShowOlder} label={`Show older revisions (${older.length})`} />
      )}
      {shown.length === 0 ? (
        <p className="cs-empty">
          {olderHidden > 0
            ? `No current revision matches “${query}”; ${olderHidden} older one${olderHidden === 1 ? '' : 's'} do.`
            : `Nothing matches “${query}”.`}
        </p>
      ) : (
        <ul className="cs-def-list cs-scroll">
          {shown.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={classes('cs-def-item', props.value === row.id && 'is-active', props.cover !== undefined && cover !== undefined && 'has-cover')}
                aria-pressed={props.value === row.id}
                data-id={row.id}
                {...(row.hint === undefined ? {} : { title: row.hint })}
                onClick={() => props.onPick(row.id)}
              >
                {props.cover === undefined || cover === undefined ? null : <span className="cs-def-cover">{cover(props.cover, row.id, row.label)}</span>}
                <span className="cs-part-label">{row.label}</span>
                <span className="cs-part-detail">{row.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Problem({ problem }: { problem: LifecycleProblem }): JSX.Element {
  return (
    <div className="cs-problem" role="alert">
      <strong>{problem.message}</strong>
      {problem.hint === undefined ? null : <p className="cs-problem-hint">{problem.hint}</p>}
      {problem.details.length === 0 ? null : (
        <ul className="cs-problem-list">
          {problem.details.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One end of the cable: a plug, or a board with optional plugs soldered to it. */
function EndStep(props: {
  side: EndSide;
  state: WizardState;
  dispatch: (action: Parameters<typeof wizardReducer>[1]) => void;
}): JSX.Element {
  const { db } = props.state;
  const chosen = props.state[props.side];
  const [choice, setChoice] = useState<'connector' | 'pcba'>(chosen?.kind ?? 'connector');
  const kind: 'connector' | 'pcba' = choice;

  const boards = useMemo(() => boardPickerOrder(db.pcbas), [db.pcbas]);
  const boardRow = (record: PcbaDefinition): PickerRow => ({
    id: record.id,
    hint: record.id,
    label: record.label,
    detail: [definitionDetail('pcbas', record), record.status === 'legacy' || record.status === 'retired' ? record.status : ''].filter(Boolean).join(' · '),
  });
  const rows: PickerRow[] =
    kind === 'connector'
      ? db.connectors.map((record) => {
          const pins = cavityPins(record, db).length;
          return {
            id: record.id,
            hint: record.id,
            label: record.label,
            detail: [record.family, record.gender, `${pins} pin${pins === 1 ? '' : 's'}${record.pins.length > pins ? ' + shell/key contacts' : ''}`].filter(Boolean).join(' · '),
          };
        })
      : boards.current.map(boardRow);

  const board = chosen?.kind === 'pcba' ? db.pcbas.find((p) => p.id === chosen.def) : undefined;
  const prefixes =
    board === undefined
      ? []
      : plugPrefixes(
          board.terminals
            .filter((terminal) => terminal.id.includes('.'))
            .map((terminal) => ({
              id: terminal.id,
              label: terminal.label ?? terminal.id,
              roles: [],
              cableSide: false,
              plugPrefix: (board.integratedConnectors ?? []).some(
                (entry) => entry.terminalPrefix === terminal.id.slice(0, terminal.id.indexOf('.')),
              )
                ? undefined
                : terminal.id.slice(0, terminal.id.indexOf('.')),
            })),
        );

  return (
    <>
      <RadioGroup
        className="cs-wizard-kind"
        aria-label="What is at this end?"
        orientation="horizontal"
        value={choice}
        onValueChange={(value) => {
          setChoice(value as 'connector' | 'pcba');
          props.dispatch({ type: 'clear-end', end: props.side });
        }}
        options={[
          { value: 'connector', label: 'A connector' },
          { value: 'pcba', label: 'A board' },
        ]}
      />

      <Picker
        legend={kind === 'connector' ? 'Which plug?' : 'Which board?'}
        say={
          kind === 'connector'
            ? 'The connector that mates with the device at this end.'
            : 'The board part number, revision and build. The build decides what is fitted on it.'
        }
        rows={rows}
        {...(kind === 'pcba' ? { cover: 'pcbas' as const, older: boards.older.map(boardRow) } : {})}
        {...(chosen?.kind === kind ? { value: chosen.def } : {})}
        onPick={(def) => props.dispatch({ type: 'set-end', end: props.side, kind, def })}
      />

      {prefixes.length === 0 || chosen === undefined ? null : (
        <div className="cs-form-section">
          <h3 title="This board has pads a connector’s pins solder onto. Say which connector, and the wizard wires pin to pad; leave it blank and the pads stay free for you to wire on the canvas.">
            Plugs on this board
          </h3>
          {prefixes.map((prefix) => (
            <label key={prefix} className="cs-field" title={`The plug whose pins land on the ${prefix} pads.`}>
              <span>The “{prefix}” pads</span>
              <Select
                aria-label={`The ${prefix} pads`}
                value={chosen.plugs[prefix] ?? NONE}
                onValueChange={(value) =>
                  props.dispatch({
                    type: 'set-plug',
                    end: props.side,
                    prefix,
                    def: value === NONE ? '' : value,
                  })
                }
                options={[{ value: NONE, label: '— nothing yet —' }, ...db.connectors.map((connector) => ({ value: connector.id, label: connector.label }))]}
              />
            </label>
          ))}
        </div>
      )}
    </>
  );
}

function LandingCell({ landing }: { landing: PlanLanding | undefined }): JSX.Element {
  return landing === undefined ? <td className="cs-dim">open</td> : <td title={landing.hint}>{landing.name}</td>;
}

/** The left-open ends with one reason each: every reason once, with what it applies to. */
function groupByWhy(entries: readonly { what: string; why: string }[]): { why: string; what: string[] }[] {
  const out: { why: string; what: string[] }[] = [];
  for (const entry of entries) {
    const why = entry.why.charAt(0).toUpperCase() + entry.why.slice(1).replace(/\.$/, ':');
    const group = out.find((g) => g.why === why);
    if (group === undefined) out.push({ why, what: [entry.what] });
    else group.what.push(entry.what);
  }
  return out;
}

/** A bug in the wizard closes nothing but the wizard: the shell behind it stays usable. */
class WizardBoundary extends Component<{ onCancel: () => void; children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[wizard] failed:', error, info.componentStack);
  }
  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="cs-wizard-card" role="alert">
        <div className="cs-problem">
          <strong>The wizard hit a problem: {this.state.error}</strong>
        </div>
        <div className="cs-modal-actions">
          <span className="cs-spacer" />
          <button type="button" className="cs-primary" onClick={this.props.onCancel}>Close</button>
        </div>
      </div>
    );
  }
}

export function NewCableWizard(props: NewCableWizardProps): JSX.Element {
  return (
    <WizardBoundary onCancel={props.onCancel}>
      <WizardFlow {...props} />
    </WizardBoundary>
  );
}

function WizardFlow(props: NewCableWizardProps): JSX.Element {
  const taken = useMemo(
    () => (props.designs ?? []).map((summary) => summary.id),
    [props.designs],
  );
  const [lengthUnits, setLengthUnits] = useState<'metric' | 'imperial'>(() => {
    try { return localStorage.getItem('wirehub:wizard-length-units') === 'imperial' ? 'imperial' : 'metric'; } catch { return 'metric'; }
  });
  const [state, dispatch] = useReducer(wizardReducer, undefined, () =>
    ({ ...initialWizardState(props.db, taken), lengthText: lengthUnits === 'imperial' ? '1830' : '1000' }),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LifecycleProblem | undefined>(undefined);

  const plan = useMemo(
    () => (state.step === 'review' || state.step === 'choices' ? planCable(state) : undefined),
    [state],
  );
  const blockers = stepBlockers(state);
  const last = state.step === 'review';

  const create = async (): Promise<void> => {
    const built = planCable(state);
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await createWiredDesign(props.persistence, built.design);
      if (result.ok) props.onCatalogChange?.(result.change);
      else setProblem(result.problem);
    } finally {
      setBusy(false);
    }
  };

  const wire = state.wireDef === undefined ? undefined : state.db.wires.find((w) => w.id === state.wireDef);
  const lengthMm = parseLengthMm(state.lengthText);

  return (
    <div className="cs-wizard-card" role="document">
      <header className="cs-wizard-head">
        <h2>New design</h2>
      </header>

      <div className="cs-wizard-body">
        <StepRail state={state} onGo={(step) => dispatch({ type: 'go', step })} />

        <section className="cs-wizard-pane">
          <h3 title={STEP_SAY[state.step]}>{STEP_TITLES[state.step]}</h3>

          {state.step === 'name' ? (
            <>
              <label className="cs-field" title="The sentence a builder reads at the top of the build sheet.">
                <span>Name</span>
                <input
                  autoFocus
                  className="cs-input"
                  value={state.label}
                  placeholder="XLR female → XLR male, mic cable, 5 m"
                  onChange={(event) => dispatch({ type: 'set-label', value: event.target.value })}
                />
              </label>
              <details className="cs-wizard-more">
                <summary>Source reference</summary>

                <label className="cs-field" title="Where the information comes from: a datasheet, a measurement, own design.">
                  <span>Reference</span>
                  <input
                    className="cs-input"
                    value={state.src}
                    onChange={(event) => dispatch({ type: 'set-src', value: event.target.value })}
                  />
                </label>
              </details>
            </>
          ) : null}

          {state.step === 'source' ? (
            <EndStep side="source" state={state} dispatch={dispatch} />
          ) : null}

          {state.step === 'destination' ? (
            <EndStep side="destination" state={state} dispatch={dispatch} />
          ) : null}

          {state.step === 'wire' ? (
            <>
              <Picker
                legend="Which wire stock?"
                say="The trunk. Its colour code is what the wizard reads the wiring from."
                rows={state.db.wires.map((record) => ({
                  id: record.id,
                  // never the manufacturer — the maker stays in the Library's wire detail
                  label: wireDisplayName(state.db, record.id),
                  detail: definitionDetail('wires', record),
                }))}
                cover="wires"
                {...(state.wireDef === undefined ? {} : { value: state.wireDef })}
                onPick={(def) => dispatch({ type: 'set-wire', def })}
              />
              <label className="cs-field" title="A whole number of millimetres, greater than zero.">
                <span>Cut length (mm)</span>
                <input
                  className="cs-input"
                  inputMode="numeric"
                  value={state.lengthText}
                  onChange={(event) => dispatch({ type: 'set-length', value: event.target.value })}
                />
                <small className="cs-mono">
                  {lengthMm === undefined
                    ? 'A whole number of millimetres, greater than zero.'
                    : `${lengthMm} mm is ${describeLength(lengthMm)}.`}
                  {wire === undefined || maxLengthOf(wire) === undefined
                    ? ''
                    : ` Max ${String(maxLengthOf(wire))} mm.`}
                </small>
              </label>
              <SegmentedControl aria-label="Length presets" value={lengthUnits} options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Feet and inches' }]} onValueChange={(value) => {
                setLengthUnits(value as 'metric' | 'imperial');
                try { localStorage.setItem('wirehub:wizard-length-units', value); } catch { /* storage may be unavailable */ }
              }} />
              <div className="cs-wizard-presets">
                {(lengthUnits === 'metric' ? LENGTH_PRESETS : IMPERIAL_LENGTH_PRESETS).map((preset) => (
                  <button
                    key={preset.mm}
                    type="button"
                    onClick={() => dispatch({ type: 'set-length', value: String(preset.mm) })}
                  >
                    {preset.label} ({preset.mm} mm)
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {state.step === 'choices' && plan !== undefined ? (
            plan.choices.length === 0 ? (
              <p className="cs-empty">Nothing to decide.</p>
            ) : (
              <div className="cs-wizard-choices">
                {(['source', 'destination'] as const).map((side) => {
                  const mine = plan.choices.filter((choice) => choice.end === side);
                  if (mine.length === 0) return null;
                  return (
                    <section key={side}>
                      <h4>{side === 'source' ? 'Source end' : 'Destination end'}</h4>
                      {mine.map((choice) => (
                        <div key={choice.id} className="cs-wizard-choice">
                          <span className="cs-wizard-choice-what" title={choice.question}>{choice.subject}</span>
                          <Select
                            aria-label={choice.question}
                            value={(state.picks[choice.id] ?? choice.suggested ?? '') === '' ? NONE : (state.picks[choice.id] ?? choice.suggested)!}
                            onValueChange={(value) => dispatch({ type: 'pick', id: choice.id, value: value === NONE ? '' : value })}
                            options={[{ value: NONE, label: 'Leave unconnected' }, ...choice.options]}
                          />
                          <Tooltip content={choice.say}>
                            <Chip tone={choice.weak ? 'warn' : 'neutral'} tabIndex={0}>{choice.chip}</Chip>
                          </Tooltip>
                        </div>
                      ))}
                    </section>
                  );
                })}
              </div>
            )
          ) : null}

          {state.step === 'review' && plan !== undefined ? (
            <div className="cs-wizard-review">
              <section className="cs-wizard-connect">
                <h4 id="cs-wizard-connect-label">Connect</h4>
                <SegmentedControl
                  aria-label="Connect"
                  value={state.connect}
                  onValueChange={(mode) => dispatch({ type: 'set-connect', mode: mode as ConnectMode })}
                  options={CONNECT_MODES.map((m) => ({ value: m.mode, label: m.label }))}
                />
              </section>

              <section>
                <h4>Checks</h4>
                {plan.errors.length + plan.warnings.length === 0 ? (
                  <p className="cs-form-say" data-testid="wizard-verdict">
                    {plan.design.joints.length === 0 ? 'No connections yet.' : 'No problems found.'}
                  </p>
                ) : (
                  <ul className="cs-list" data-testid="wizard-verdict">
                    {plan.errors.map((issue, index) => (
                      <li key={`e${index}`} className="cs-field-bad">{describeIssue(issue)}</li>
                    ))}
                    {plan.warnings.map((issue, index) => (
                      <li key={`w${index}`}>{describeIssue(issue)}</li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h4>Wiring ({plan.rows.length})</h4>
                {plan.rows.length === 0 ? (
                  <p className="cs-empty">Nothing yet.</p>
                ) : (
                  <table className="cs-wizard-pins">
                    <thead>
                      <tr><th>Conductor</th><th>Signal</th><th>Source</th><th /><th>Destination</th></tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((row) => (
                        <tr key={row.key}>
                          <td {...(row.whatHint === undefined ? {} : { title: row.whatHint })}>{row.what}</td>
                          <td className="cs-dim">{row.signal ?? ''}</td>
                          <LandingCell landing={row.from} />
                          <td className="cs-dim">→</td>
                          <LandingCell landing={row.to} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              {plan.unconnected.length === 0 ? null : (
                <section>
                  <h4>Left open ({plan.unconnected.length})</h4>
                  <ul className="cs-list cs-wizard-left">
                    {groupByWhy(plan.unconnected).map(({ why, what }) => (
                      <li key={why}>
                        <span className="cs-dim">{why}</span> <span>{what.join(', ')}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="cs-wizard-preview">
                <h4>How it will draw</h4>
                <PreviewPane
                  design={plan.design}
                  db={state.db}
                  debounceMs={0}
                  {...(props.depictions === undefined ? {} : { depictions: props.depictions })}
                />
              </section>
            </div>
          ) : null}

          {state.blocked.length === 0 ? null : (
            <div className="cs-problem" role="alert">
              <strong>Not quite yet.</strong>
              <ul className="cs-problem-list">
                {state.blocked.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {problem === undefined ? null : <Problem problem={problem} />}
        </section>
      </div>

      <div className="cs-modal-actions">
        <button type="button" className="cs-quiet" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        {props.onBlank === undefined ? null : (
          <button type="button" className="cs-link" onClick={props.onBlank} disabled={busy}>
            Blank design instead
          </button>
        )}
        <span className="cs-spacer" />
        <button
          type="button"
          disabled={state.step === 'name' || busy}
          onClick={() => dispatch({ type: 'back' })}
        >
          Back
        </button>
        {last ? (
          <button
            type="button"
            className="cs-primary"
            disabled={busy || blockers.length > 0}
            {...(blockers.length > 0 ? { title: blockers.join(' ') } : {})}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create design'}
          </button>
        ) : (
          <button
            type="button"
            className="cs-primary"
            disabled={busy}
            onClick={() => dispatch({ type: 'next' })}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
