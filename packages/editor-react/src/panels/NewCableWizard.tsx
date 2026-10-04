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

import type { Db } from '@cable-studio/model';
import { wireDisplayName } from '@cable-studio/docs';
import type { DepictionSource } from '@cable-studio/render-svg';
import { useMemo, useReducer, useState, type JSX } from 'react';

import { classes } from '../context.ts';
import { definitionDetail } from '../library.ts';
import { createWiredDesign, type CatalogChange, type LifecycleProblem } from '../lifecycle.ts';
import type { DesignSummary, PersistenceAdapter } from '../persistence.ts';
import { describeIssue } from '../store.ts';
import {
  BARE_SCART_DEF,
  BARE_SCART_NOTE,
  LENGTH_PRESETS,
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
  type EndSide,
  type WizardState,
  type WizardStep,
} from '../wizard.ts';
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

interface PickerRow {
  id: string;
  label: string;
  detail: string;
}

/** A searchable list of parts. Every row says what the part is. */
function Picker(props: {
  legend: string;
  say: string;
  rows: PickerRow[];
  value?: string | undefined;
  onPick: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = props.rows.filter(
    (row) =>
      needle === '' || `${row.id} ${row.label} ${row.detail}`.toLowerCase().includes(needle),
  );
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
      {shown.length === 0 ? (
        <p className="cs-empty">
          Nothing here matches “{query}”. Clear the search, or add the part in the Library first.
        </p>
      ) : (
        <ul className="cs-def-list cs-scroll">
          {shown.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={classes('cs-def-item', props.value === row.id && 'is-active')}
                aria-pressed={props.value === row.id}
                onClick={() => props.onPick(row.id)}
              >
                <span className="cs-def-id">{row.id}</span>
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
  const bareChosen = chosen?.kind === 'connector' && chosen.def === BARE_SCART_DEF;
  const [choice, setChoice] = useState<'connector' | 'pcba' | 'bare-scart'>(
    bareChosen && props.side === 'destination' ? 'bare-scart' : (chosen?.kind ?? 'pcba'),
  );
  const kind: 'connector' | 'pcba' = choice === 'pcba' ? 'pcba' : 'connector';

  const rows: PickerRow[] =
    kind === 'connector'
      ? db.connectors.map((record) => ({
          id: record.id,
          label: record.label,
          detail: definitionDetail('connectors', record),
        }))
      : db.pcbas.map((record) => ({
          id: record.id,
          label: record.label,
          detail: definitionDetail('pcbas', record),
        }));

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
      <fieldset className="cs-wizard-kind">
        <legend>What is at this end?</legend>
        {(
          [
            ['pcba', 'A board', 'The cable is soldered to a board (PCBA) from the library.'],
            ['connector', 'A plug on its own', 'The cable is soldered straight into the plug’s hood.'],
            ...(props.side === 'destination'
              ? ([
                  [
                    'bare-scart',
                    'A SCART head with no board',
                    'A SCART male soldered straight to the cable, wired the way the SCART destination board would be.',
                  ],
                ] as const)
              : []),
          ] as const
        ).map(([value, title, say]) => (
          <label key={value} className="cs-wizard-radio" title={say}>
            <input
              type="radio"
              name={`end-${props.side}`}
              checked={choice === value}
              onChange={() => {
                setChoice(value);
                props.dispatch({ type: 'clear-end', end: props.side });
                if (value === 'bare-scart') {
                  props.dispatch({ type: 'set-end', end: props.side, kind: 'connector', def: BARE_SCART_DEF });
                }
              }}
            />
            <span>
              <strong>{title}</strong>
            </span>
          </label>
        ))}
      </fieldset>

      {choice === 'bare-scart' ? (
        <p className="cs-form-say">{BARE_SCART_NOTE}</p>
      ) : (
        <Picker
          legend={kind === 'connector' ? 'Which plug?' : 'Which board?'}
          say={
            kind === 'connector'
              ? 'The connector that mates with the source device or display.'
              : 'The board part number, revision and build. The build decides which sync path is fitted.'
          }
          rows={rows}
          {...(chosen?.kind === kind ? { value: chosen.def } : {})}
          onPick={(def) => props.dispatch({ type: 'set-end', end: props.side, kind, def })}
        />
      )}

      {prefixes.length === 0 || chosen === undefined ? null : (
        <div className="cs-form-section">
          <h3 title="This board has pads a connector’s pins solder onto. Say which connector, and the wizard wires pin to pad; leave it blank and the pads stay free for you to wire on the canvas.">
            Plugs on this board
          </h3>
          {prefixes.map((prefix) => (
            <label key={prefix} className="cs-field" title={`The plug whose pins land on the ${prefix} pads.`}>
              <span>The “{prefix}” pads</span>
              <select
                value={chosen.plugs[prefix] ?? ''}
                onChange={(event) =>
                  props.dispatch({
                    type: 'set-plug',
                    end: props.side,
                    prefix,
                    def: event.target.value,
                  })
                }
              >
                <option value="">— nothing yet —</option>
                {db.connectors.map((connector) => (
                  <option key={connector.id} value={connector.id}>
                    {connector.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

export function NewCableWizard(props: NewCableWizardProps): JSX.Element {
  const taken = useMemo(
    () => (props.designs ?? []).map((summary) => summary.id),
    [props.designs],
  );
  const [state, dispatch] = useReducer(wizardReducer, undefined, () =>
    initialWizardState(props.db, taken),
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
        <h2 title="Six questions. At the end you get a cable that is already wired, already checked, and already drawn — not an empty canvas.">
          New cable
        </h2>
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
              <label
                className="cs-field"
                title="Short name used for the file and in links. Lowercase words joined by hyphens; suggested from the name until you change it."
              >
                <span>Id</span>
                <input
                  className="cs-input"
                  value={state.id}
                  placeholder="xlr-mic-cable-5-m"
                  onChange={(event) => dispatch({ type: 'set-id', value: event.target.value })}
                />
              </label>
              <label
                className="cs-field"
                title="The document, board or measurement behind this cable. Every record in the catalog carries its source; the wizard adds a line saying which joints it worked out for you."
              >
                <span>Source</span>
                <input
                  className="cs-input"
                  required
                  value={state.src}
                  placeholder="ground-truth.md §4, measured on the bench, …"
                  onChange={(event) => dispatch({ type: 'set-src', value: event.target.value })}
                />
              </label>
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
                  // never the manufacturer (owner 2026-09-25/26) — the maker stays in the Library's wire detail
                  label: wireDisplayName(state.db, record.id),
                  detail: definitionDetail('wires', record),
                }))}
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
              <div className="cs-wizard-presets">
                {LENGTH_PRESETS.map((preset) => (
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
              <p className="cs-empty">
                Nothing to decide — every conductor found exactly one landing at both ends. Go on to
                the review.
              </p>
            ) : (
              <>
                {plan.choices.map((choice) => (
                  <label key={choice.id} className={classes('cs-field', choice.weak && 'is-weak')}>
                    <span>{choice.question}</span>
                    <select
                      value={state.picks[choice.id] ?? ''}
                      onChange={(event) =>
                        dispatch({ type: 'pick', id: choice.id, value: event.target.value })
                      }
                    >
                      <option value="">— leave it unconnected —</option>
                      {choice.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <small>{choice.say}</small>
                  </label>
                ))}
              </>
            )
          ) : null}

          {state.step === 'review' && plan !== undefined ? (
            <div className="cs-wizard-review">
              <section>
                <h4>What it will solder ({plan.lines.length})</h4>
                {plan.lines.length === 0 ? (
                  <p className="cs-empty">
                    Nothing yet — go back and choose the ends and the wire.
                  </p>
                ) : (
                  <ul className="cs-list">
                    {plan.lines.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h4>What it left alone ({plan.unconnected.length})</h4>
                {plan.unconnected.length === 0 ? (
                  <p className="cs-empty">
                    Every conductor found a home. Nothing was left hanging.
                  </p>
                ) : (
                  <ul className="cs-list">
                    {plan.unconnected.map((entry, index) => (
                      <li key={index}>
                        <strong>{entry.what}</strong> — {entry.why}
                      </li>
                    ))}
                  </ul>
                )}
                {plan.unconnected.length === 0 ? null : (
                  <p className="cs-form-say">
                    These are deliberate: the wizard never guesses a joint. Add them on the canvas
                    once the cable is open, or go back and answer the questions on the previous
                    step.
                  </p>
                )}
              </section>

              <section>
                <h4>Checks</h4>
                {plan.errors.length === 0 ? (
                  <p className="cs-form-say">
                    Nothing is wrong with this design
                    {plan.warnings.length === 0
                      ? '.'
                      : `, but there ${plan.warnings.length === 1 ? 'is 1 thing' : `are ${plan.warnings.length} things`} to look at:`}
                  </p>
                ) : (
                  <ul className="cs-list">
                    {plan.errors.map((issue, index) => (
                      <li key={index} className="cs-field-bad">
                        {describeIssue(issue)}
                      </li>
                    ))}
                  </ul>
                )}
                {plan.warnings.length === 0 ? null : (
                  <ul className="cs-list">
                    {plan.warnings.map((issue, index) => (
                      <li key={index}>{describeIssue(issue)}</li>
                    ))}
                  </ul>
                )}
              </section>

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
            Start from a blank cable instead
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
            title={blockers.length > 0 ? blockers.join(' ') : 'Write this cable to the catalog'}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create this cable'}
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
