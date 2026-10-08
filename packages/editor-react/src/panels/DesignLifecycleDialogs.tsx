/**
 * The three lifecycle dialogs (New/Duplicate/Rename's
 * shared name form, Delete's confirm, and the save-with-warnings gate) plus
 * the wizard — split out of `DesignActions.tsx` so `CableEditor`'s host
 * chrome can mount exactly this, unmodified, while the host's own top bar
 * supplies the buttons that open it (`useDesignLifecycle`'s `openLifecycle`).
 *
 * UX rules this file exists to keep (specs/studio-workbench.md) — see the
 * original header this was lifted from: no raw JSON, nothing dead-ends,
 * every field explains itself.
 */

import type { CableDesign, Db } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';
import { useMemo, useState, type FormEvent, type JSX } from 'react';

import type { LifecycleProblem } from '../lifecycle.ts';
import type { DesignSummary, PersistenceAdapter } from '../persistence.ts';
import { suggestDesignId } from '../persistence.ts';
import { previewTrunkStock, swappableStocks } from '../stock-swap.ts';
import { NewCableWizard } from './NewCableWizard.tsx';
import {
  createDesign,
  deleteDesign,
  duplicateDesign,
  renameDesign,
  variantDesign,
  type DesignLifecycleApi,
  type DialogKind,
} from './useDesignLifecycle.ts';

const DIALOG_TITLE: Record<DialogKind, string> = {
  wizard: 'New design',
  new: 'New design',
  duplicate: 'Save a copy',
  variant: 'Make a variant',
  rename: 'Rename this design',
  delete: 'Delete this design',
};

/** What each dialog says before it asks for anything. */
const DIALOG_SAY: Record<DialogKind, string> = {
  wizard: '',
  new: 'Starts an empty design. You add the connectors, wire and board on the canvas afterwards.',
  duplicate:
    'Copies this design — every part and every joint — under a new name. The original is left exactly as it is.',
  variant:
    'Copies this design onto another wire stock. The trunk moves across by conductor colour; everything else is copied as it is, and this design is left exactly as it is.',
  rename: 'Changes this design’s name and id. The design itself is not altered.',
  delete: '',
};

export function Problem({ problem }: { problem: LifecycleProblem }): JSX.Element {
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

interface DialogProps {
  kind: Exclude<DialogKind, 'wizard'>;
  design: CableDesign;
  taken: string[];
  busy: boolean;
  /** there are unsaved changes — Duplicate and Rename act on the stored design */
  dirty: boolean;
  problem: LifecycleProblem | undefined;
  onCancel: () => void;
  onSubmit: (fields: { id: string; label: string; src: string }) => void;
}

/**
 * The name/id form the three creating dialogs share.
 *
 * The id follows the name until the moment someone edits the id themselves —
 * after that it is theirs and the suggestion stops, because silently
 * overwriting what a user typed is how a form loses their trust.
 */
function NameDialog(props: DialogProps): JSX.Element {
  const initialLabel =
    props.kind === 'rename'
      ? props.design.label
      : props.kind === 'duplicate'
        ? `${props.design.label} (copy)`
        : '';
  const [label, setLabel] = useState(initialLabel);
  const [id, setId] = useState(
    props.kind === 'rename' ? props.design.id : suggestDesignId(initialLabel, props.taken),
  );
  const [ownId, setOwnId] = useState(props.kind === 'rename');
  const [src, setSrc] = useState('');

  const onLabel = (next: string): void => {
    setLabel(next);
    if (!ownId) setId(suggestDesignId(next, props.taken));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    props.onSubmit({ id, label, src });
  };

  return (
    <form className="cs-modal-card" onSubmit={submit}>
      <h2>{DIALOG_TITLE[props.kind]}</h2>
      <p className="cs-modal-say">{DIALOG_SAY[props.kind]}</p>
      {props.dirty && props.kind !== 'new' ? (
        <p className="cs-modal-warn">
          This works from the <strong>saved</strong> version of the design, and you have changes
          that are not saved yet. Cancel and press Save first if you want them included.
        </p>
      ) : null}

      <label className="cs-field">
        <span>Name</span>
        <input
          autoFocus
          value={label}
          onChange={(event) => onLabel(event.target.value)}
          placeholder="XLR female → XLR male, mic cable, 5 m"
        />
        <small>The sentence a builder reads at the top of the build sheet.</small>
      </label>

      <label className="cs-field">
        <span>Id</span>
        <input
          value={id}
          onChange={(event) => {
            setOwnId(true);
            setId(event.target.value);
          }}
          placeholder="xlr-mic-cable-5-m"
        />
        <small>
          Short name used for the file and in links. Lowercase words joined by hyphens; suggested
          from the name until you change it.
        </small>
      </label>

      {props.kind === 'new' ? (
        <label className="cs-field">
          <span>Where does this information come from?</span>
          <input
            value={src}
            onChange={(event) => setSrc(event.target.value)}
            placeholder="datasheet §4, measured on the bench, …"
          />
          <small>
            The document, board or measurement behind this design. Say so here if any of it is
            inferred — every record in the catalog carries its source.
          </small>
        </label>
      ) : null}

      {props.problem === undefined ? null : <Problem problem={props.problem} />}

      <div className="cs-modal-actions">
        <button type="button" className="cs-quiet" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
        <button type="submit" className="cs-primary" disabled={props.busy}>
          {props.busy ? 'Working…' : DIALOG_TITLE[props.kind]}
        </button>
      </div>
    </form>
  );
}

/**
 * "Make variant": pick a stock the trunk can move to (only the ones
 * `canSwapTrunkStock` accepts), see which conductors go where, name the copy.
 */
function VariantDialog(props: {
  design: CableDesign;
  db: Db;
  taken: string[];
  busy: boolean;
  dirty: boolean;
  problem: LifecycleProblem | undefined;
  onCancel: () => void;
  onSubmit: (variant: CableDesign, fields: { id: string; label: string }) => void;
}): JSX.Element {
  const stocks = useMemo(() => swappableStocks(props.design, props.db), [props.design, props.db]);
  const [stockId, setStockId] = useState(stocks[0]?.id ?? '');
  const stock = stocks.find((w) => w.id === stockId);
  const shortLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const suggestedLabel = stock === undefined ? '' : `${props.design.label} (on ${shortLabel(stock.label)})`;
  const [label, setLabel] = useState<string | undefined>(undefined);
  const [id, setId] = useState<string | undefined>(undefined);
  const shownLabel = label ?? suggestedLabel;
  const shownId = id ?? suggestDesignId(shownLabel, props.taken);
  const preview = useMemo(() => (stock === undefined ? undefined : previewTrunkStock(props.design, props.db, stock.id)), [props.design, props.db, stock]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (preview === undefined) return;
    props.onSubmit(preview.design, { id: shownId, label: shownLabel });
  };

  return (
    <form className="cs-modal-card" onSubmit={submit}>
      <h2>{DIALOG_TITLE.variant}</h2>
      <p className="cs-modal-say">{DIALOG_SAY.variant}</p>
      {props.dirty ? (
        <p className="cs-modal-warn">You have changes that are not saved yet; the variant includes them. This design itself stays as it is saved.</p>
      ) : null}
      {stocks.length === 0 ? (
        <p className="cs-modal-say">There is no other wire stock in the library this design’s trunk could move to.</p>
      ) : (
        <>
          <label className="cs-field">
            <span>Wire stock</span>
            <select value={stockId} aria-label="Wire stock" onChange={(event) => setStockId(event.target.value)}>
              {stocks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <small>Only stocks the trunk can move to are listed.</small>
          </label>
          {preview === undefined ? null : (
            <div className="cs-variant-preview" aria-label="What moves">
              <table>
                <thead>
                  <tr>
                    <th>Conductor</th>
                    <th>Now</th>
                    <th>On {stock === undefined ? 'the new stock' : shortLabel(stock.label)}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.moves.map((m) => (
                    <tr key={m.colour} data-colour={m.colour}>
                      <td>{m.colour}</td>
                      <td>
                        <code>{m.from}</code>
                      </td>
                      <td>{m.to === undefined ? <em>no such core — not carried across</em> : <code>{m.to}</code>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.spare.length === 0 ? null : <p className="cs-modal-say">New cores left unconnected at both ends: {preview.spare.join(', ')}.</p>}
              {preview.lost.length === 0 ? null : (
                <ul className="cs-problem-list" aria-label="Not carried across">
                  {preview.lost.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <label className="cs-field">
            <span>Name</span>
            <input value={shownLabel} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="cs-field">
            <span>Id</span>
            <input value={shownId} onChange={(event) => setId(event.target.value)} />
            <small>Lowercase words joined by hyphens; suggested from the name until you change it.</small>
          </label>
        </>
      )}
      {props.problem === undefined ? null : <Problem problem={props.problem} />}
      <div className="cs-modal-actions">
        <button type="button" className="cs-quiet" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
        <button type="submit" className="cs-primary" disabled={props.busy || stock === undefined}>
          {props.busy ? 'Working…' : 'Make variant'}
        </button>
      </div>
    </form>
  );
}

function DeleteDialog(props: {
  design: CableDesign;
  busy: boolean;
  problem: LifecycleProblem | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="cs-modal-card">
      <h2>{DIALOG_TITLE.delete}</h2>
      <p className="cs-modal-say">
        Delete <strong>{props.design.label}</strong> (<code>{props.design.id}</code>)?
      </p>
      <p className="cs-modal-say">
        This removes it from the catalog for good — the drawings, build sheet and BOM that come
        from it go with it. Nothing else in the catalog refers to a design, so no other design is
        affected.
      </p>
      {props.problem === undefined ? null : <Problem problem={props.problem} />}
      <div className="cs-modal-actions">
        <button type="button" className="cs-quiet" onClick={props.onCancel} disabled={props.busy}>
          Keep it
        </button>
        <button
          type="button"
          className="cs-destructive"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy ? 'Deleting…' : `Delete ${props.design.id}`}
        </button>
      </div>
    </div>
  );
}

/**
 * "There are things to look at" — the confirmation a save with warnings gets.
 *
 * Warnings never block a save, and that is deliberate: a cable being built up
 * is legitimately incomplete, and refusing to store work in progress would push
 * the user back to a text editor. But a warning that passes silently at the one
 * moment it matters is a warning nobody reads. So the save still happens — the
 * user just has to have seen the list first, in sentences, and said yes to it.
 */
function WarningsDialog(props: {
  design: CableDesign;
  lines: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const count = props.lines.length;
  return (
    <div className="cs-modal-card">
      <h2>Save {props.design.label}?</h2>
      <p className="cs-modal-say">
        Nothing here stops this design being saved — {count === 1 ? 'this is a' : 'these are'} thing
        {count === 1 ? '' : 's'} to look at, not {count === 1 ? 'a mistake' : 'mistakes'}. A design
        you are still building up will have {count === 1 ? 'one' : 'some'}.
      </p>
      <ul className="cs-problem-list">
        {props.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      <p className="cs-modal-say">
        They stay in the issues panel either way, so you can come back to them.
      </p>
      <div className="cs-modal-actions">
        <button type="button" className="cs-quiet" onClick={props.onCancel} disabled={props.busy}>
          Let me fix {count === 1 ? 'it' : 'them'} first
        </button>
        <button
          type="button"
          className="cs-primary"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy ? 'Saving…' : 'Save anyway'}
        </button>
      </div>
    </div>
  );
}

export interface DesignLifecycleDialogsProps {
  api: DesignLifecycleApi;
  design: CableDesign;
  persistence: PersistenceAdapter;
  db?: Db;
  designs?: DesignSummary[];
  depictions?: boolean | DepictionSource;
}

/**
 * Every dialog the lifecycle can open, driven entirely by `api`
 * (`useDesignLifecycle`) — the save-with-warnings confirm, the problem line a
 * closed dialog leaves behind, and the New/Duplicate/Rename/Delete modal
 * itself. Neither `DesignActions` (the button row)
 * nor `CableEditor`'s host chrome duplicates any of this; they only decide
 * *how* `api.setDialog`/`api.openLifecycle` gets called.
 */
export function DesignLifecycleDialogs(props: DesignLifecycleDialogsProps): JSX.Element {
  const { api } = props;
  // a local binding, not `api.dialog` repeated: TypeScript narrows a `const`
  // through the ternary chain below by control flow, but not a property read
  // off an object it cannot prove is unaliased between reads
  const { dialog } = api;

  return (
    <>
      {api.problem === undefined || dialog !== undefined ? null : <Problem problem={api.problem} />}

      {!api.confirming || dialog !== undefined ? null : (
        <div className="cs-modal" role="dialog" aria-modal="true" aria-label="Save with warnings">
          <WarningsDialog
            design={props.design}
            lines={api.warningLines}
            busy={api.busy}
            onCancel={() => api.setConfirming(false)}
            onConfirm={() => void api.save()}
          />
        </div>
      )}

      {dialog === undefined ? null : (
        <div className="cs-modal" role="dialog" aria-modal="true" aria-label={DIALOG_TITLE[dialog]}>
          {dialog === 'wizard' && props.db !== undefined ? (
            <NewCableWizard
              db={props.db}
              persistence={props.persistence}
              {...(props.designs === undefined ? {} : { designs: props.designs })}
              {...(props.depictions === undefined ? {} : { depictions: props.depictions })}
              onCancel={api.close}
              onBlank={() => api.setDialog('new')}
              onCatalogChange={api.finishWizard}
            />
          ) : dialog === 'variant' && props.db !== undefined ? (
            <VariantDialog
              key="variant"
              design={props.design}
              db={props.db}
              taken={api.taken}
              busy={api.busy}
              dirty={api.dirty}
              problem={api.problem}
              onCancel={api.close}
              onSubmit={(variant, fields) => void api.run(() => variantDesign(props.persistence, props.design.id, variant, fields))}
            />
          ) : dialog === 'delete' ? (
            <DeleteDialog
              design={props.design}
              busy={api.busy}
              problem={api.problem}
              onCancel={api.close}
              onConfirm={() =>
                void api.run(() => deleteDesign(props.persistence, props.design.id, props.design.id))
              }
            />
          ) : (
            <NameDialog
              key={dialog}
              kind={dialog as Exclude<DialogKind, 'wizard'>}
              design={props.design}
              taken={api.taken}
              busy={api.busy}
              dirty={api.dirty}
              problem={api.problem}
              onCancel={api.close}
              onSubmit={(fields) =>
                void api.run(() => {
                  if (dialog === 'new') return createDesign(props.persistence, fields);
                  if (dialog === 'duplicate') {
                    return duplicateDesign(props.persistence, props.design.id, fields);
                  }
                  return renameDesign(props.persistence, props.design.id, fields);
                })
              }
            />
          )}
        </div>
      )}
    </>
  );
}
