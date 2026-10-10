/**
 * The printed sheets' options row: paper, document
 * number / revision / status, and whether to stamp today's date — above the
 * build sheet, BOM and continuity spec. Stored per design in the drawing
 * sidecar's `sheet` field through the same Save as the drawing's title block.
 * Labels live in tooltips and placeholders, per the UX rules.
 */

import type { CableDesign } from '@wirehub/model';
import { PAPERS, PAPER_IDS, isPaperId, type DrawingMeta, type PaperId, type SheetSettings } from '@wirehub/docs';
import type { JSX } from 'react';
import { Select, Checkbox, Button, Combobox } from '../ui/index.ts';

export interface SheetOptionsProps {
  design: CableDesign;
  meta: DrawingMeta;
  onMeta: (meta: DrawingMeta) => void;
  /** the host's paper when the sidecar names none */
  defaultPaper: PaperId;
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
      <Select className="cs-sheet-paper" aria-label="Paper" value={sheet.paper ?? props.defaultPaper}
        onValueChange={(value) => set('paper', isPaperId(value) && value !== props.defaultPaper ? value : undefined)}
        options={PAPER_IDS.map((id) => ({ value: id, label: PAPERS[id].label }))} />
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
      <Combobox aria-label="Status" className="cs-sheet-status" value={sheet.status ?? null} placeholder="Status"
        onValueChange={(value) => set('status', value === 'none' ? undefined : value)} onCreate={(value) => set('status', value)}
        options={[{ value: 'none', label: 'No status' }, ...[...new Set([...STATUSES, ...(sheet.status ? [sheet.status] : [])])].map((value) => ({ value, label: value }))]} />
      <Checkbox checked={sheet.stampDate === true} onCheckedChange={(checked) => set('stampDate', checked)} label="Date" />
      {props.onSave === undefined ? null : (
        <Button
          disabled={!props.dirty || props.saving}
          title="Save these options beside the design — every print of it uses them"
          onClick={props.onSave}
        >
          {props.saving ? 'saving…' : 'Save'}
        </Button>
      )}
      {props.dirty ? <span className="cs-chip is-draft">unsaved</span> : null}
      {props.status === undefined ? null : <small className="cs-drawing-status">{props.status}</small>}
    </div>
  );
}
