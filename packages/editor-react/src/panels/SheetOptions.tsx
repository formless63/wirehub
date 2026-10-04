/**
 * The printed sheets' options row: paper, document
 * number / revision / status, and whether to stamp today's date — above the
 * build sheet, BOM and continuity spec. Stored per design in the drawing
 * sidecar's `sheet` field through the same Save as the drawing's title block.
 * Labels live in tooltips and placeholders, per the UX rules.
 */

import type { CableDesign } from '@wirehub/model';
import type { DrawingMeta, SheetSettings } from '@wirehub/docs';
import type { JSX } from 'react';

export interface SheetOptionsProps {
  design: CableDesign;
  meta: DrawingMeta;
  onMeta: (meta: DrawingMeta) => void;
  /** the host's paper when the sidecar names none */
  defaultPaper: 'A4' | 'letter';
  /** absent: the host cannot store them — they shape the preview and the print only */
  onSave?: () => void;
  dirty: boolean;
  saving: boolean;
  status?: string;
  /** the saved-version target's revision — shown read-only */
  revisionFixed?: string;
}

const STATUSES = ['DRAFT', 'PRELIMINARY', 'RELEASED', 'OBSOLETE'];

/** `meta` with one sheet option set — empty text and a false stamp are removed, not stored. */
export function withSheetOption<K extends keyof SheetSettings>(meta: DrawingMeta, key: K, value: SheetSettings[K] | undefined): DrawingMeta {
  const sheet: SheetSettings = { ...(meta.sheet ?? {}) };
  if (value === undefined || value === false || (typeof value === 'string' && value.trim() === '')) delete sheet[key];
  else sheet[key] = value;
  const next = { ...meta };
  if (Object.keys(sheet).length === 0) delete next.sheet;
  else next.sheet = sheet;
  return next;
}

export function SheetOptions(props: SheetOptionsProps): JSX.Element {
  const { meta, design } = props;
  const sheet = meta.sheet ?? {};
  const set = <K extends keyof SheetSettings>(key: K, value: SheetSettings[K] | undefined): void =>
    props.onMeta(withSheetOption(meta, key, value));
  const partNumber = meta.partNumber ?? design.productRef;

  return (
    <div className="cs-sheet-options" role="group" aria-label="Sheet options">
      <select
        className="cs-input cs-sheet-paper"
        aria-label="Paper"
        title="Paper size"
        value={sheet.paper ?? props.defaultPaper}
        onChange={(e) => set('paper', e.target.value === 'letter' ? 'letter' : e.target.value === props.defaultPaper ? undefined : 'A4')}
      >
        <option value="A4">A4</option>
        <option value="letter">Letter</option>
      </select>
      <input
        aria-label="Document number"
        title="Document number — blank uses the part number"
        className="cs-input cs-sheet-number"
        value={sheet.number ?? ''}
        placeholder={partNumber ?? 'Doc no.'}
        onChange={(e) => set('number', e.target.value)}
      />
      {props.revisionFixed === undefined ? (
        <input
          aria-label="Revision"
          title="Document revision — blank uses the drawing's revision"
          className="cs-input cs-sheet-short"
          value={sheet.revision ?? ''}
          placeholder={meta.revision ?? 'Rev'}
          onChange={(e) => set('revision', e.target.value)}
        />
      ) : (
        <input
          aria-label="Revision"
          title="Set by the saved version"
          className="cs-input cs-sheet-short"
          value={props.revisionFixed}
          readOnly
        />
      )}
      <input
        aria-label="Status"
        title="Document status, printed beside the number"
        className="cs-input cs-sheet-status"
        list="cs-sheet-statuses"
        value={sheet.status ?? ''}
        placeholder="Status"
        onChange={(e) => set('status', e.target.value)}
      />
      <datalist id="cs-sheet-statuses">
        {STATUSES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <label className="cs-sheet-stamp" title="Print the date the sheet is rendered in the title block">
        <input type="checkbox" checked={sheet.stampDate === true} onChange={(e) => set('stampDate', e.target.checked)} />
        Date
      </label>
      {props.onSave === undefined ? null : (
        <button
          type="button"
          disabled={!props.dirty || props.saving}
          title="Save these options beside the design — every print of it uses them"
          onClick={props.onSave}
        >
          {props.saving ? 'saving…' : 'Save'}
        </button>
      )}
      {props.dirty ? <span className="cs-chip is-draft">unsaved</span> : null}
      {props.status === undefined ? null : <small className="cs-drawing-status">{props.status}</small>}
    </div>
  );
}
