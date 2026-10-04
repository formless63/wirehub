/**
 * The drawing sheet's title block, as a form above the sheet.
 *
 * Everything typed here drives the preview immediately (the pane re-renders on
 * a debounce, as for every document) and is written to the design's drawing
 * sidecar only when the user presses Save — the same "draft until saved" rule
 * as the design itself. The form never touches the cable model: part number,
 * revision and lengths are facts about the *drawing*.
 */

import type { CableDesign, Db } from '@wirehub/model';
import type { DrawingMeta } from '@wirehub/docs';
import { useState, type ChangeEvent, type JSX } from 'react';

import type { AssetsAdapter } from '../assets.ts';
import { formatLengths, parseLengths } from '../documents.ts';
import { AssetPicker } from './AssetPicker.tsx';
import { Field } from './fields.tsx';
import { PartNumberField } from './PartNumberField.tsx';

export interface DrawingFormProps {
  design: CableDesign;
  db: Db;
  meta: DrawingMeta;
  photo: string | undefined;
  onMeta: (next: DrawingMeta) => void;
  onPhoto: (next: string | undefined) => void;
  /** absent: the host cannot store sidecars; the form only drives the preview */
  onSave?: () => void;
  /**
   * The shared photo library. Given one, "Choose
   * from library…" opens it beside the file input — picking hands the same
   * `onPhoto` callback a fresh upload would, so Save dedups it exactly like
   * any other photo. Without one, only uploading works.
   */
  assets?: AssetsAdapter;
  /** a sentence about the last load/save, or what went wrong */
  status?: string;
  dirty: boolean;
  saving: boolean;
  /**
   * The revision the saved-version target fixes — the
   * field shows it read-only instead of taking a typed one.
   */
  revisionFixed?: string;
}

/** The drawing photo's stored-size ceiling — `server/drawings.ts`'s `readPhoto` refuses over this. */
export const PHOTO_SIZE_LIMIT = 2.5 * 1024 * 1024;
/** The floor the downscale never re-encodes below (quality over squeezing). */
export const PHOTO_MIN_QUALITY = 0.9;

/**
 * How much to shrink an oversized photo so its *re-encoded* bytes fit the
 * limit (replacing the old flat refusal): assuming JPEG
 * bytes scale roughly with pixel area at a fixed quality, the scale that
 * would just fit `limitBytes` is `sqrt(limitBytes / bytes)` — backed off 8%
 * because that assumption is a heuristic, not a promise, so the first
 * re-encode usually clears the limit instead of landing just over it.
 * `undefined` when the photo is already small enough. Never taken below
 * 200px on the long edge, so a very low limit does not shrink an enormous
 * source to a postage stamp trying to satisfy it in one jump —
 * `downscalePhoto` re-checks the real encoded size and calls this again if
 * that still is not enough.
 */
export function downscaleTarget(
  width: number,
  height: number,
  bytes: number,
  limitBytes: number,
): { width: number; height: number } | undefined {
  if (bytes <= limitBytes || width <= 0 || height <= 0) return undefined;
  const long = Math.max(width, height);
  const minScale = Math.min(1, 200 / long);
  const scale = Math.max(minScale, Math.min(1, Math.sqrt(limitBytes / bytes) * 0.92));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A data URI's decoded byte length, without decoding it — base64 is 4 bytes per 3, minus padding. */
export function dataUriBytes(dataUri: string): number {
  const comma = dataUri.indexOf(',');
  const body = comma === -1 ? dataUri : dataUri.slice(comma + 1);
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/**
 * Shrink an oversized photo to fit `limitBytes`, in place of refusing it.
 * The long edge first, then JPEG at `quality` or
 * higher — re-checking the actual encoded size and shrinking a little
 * further, up to a few tries, if the first pass is still over. `undefined`
 * when this browser cannot do it (no canvas) or it still would not fit.
 */
export async function downscalePhoto(
  file: File,
  limitBytes = PHOTO_SIZE_LIMIT,
  quality = PHOTO_MIN_QUALITY,
): Promise<{ dataUri: string; bytes: number } | undefined> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return undefined;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return undefined;
  }
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    let bytesGuess = file.size;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const target = downscaleTarget(width, height, bytesGuess, limitBytes) ?? { width, height };
      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return undefined;
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      const dataUri = canvas.toDataURL('image/jpeg', quality);
      const bytes = dataUriBytes(dataUri);
      if (bytes <= limitBytes || attempt === 5) return { dataUri, bytes };
      width = target.width;
      height = target.height;
      bytesGuess = bytes;
    }
    return undefined;
  } finally {
    bitmap.close?.();
  }
}

/** Title-block date in the house style: 2026.08.02. */
export function drawingDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

function withField<K extends keyof DrawingMeta>(meta: DrawingMeta, key: K, value: DrawingMeta[K] | undefined): DrawingMeta {
  const next = { ...meta };
  if (value === undefined || (typeof value === 'string' && value === '')) delete next[key];
  else next[key] = value;
  return next;
}

/** Instances whose BOM wording purchasing may want to override. */
function overridable(design: CableDesign, db: Db): { id: string; hint: string }[] {
  const out: { id: string; hint: string }[] = [];
  for (const instance of design.instances.pcbas) {
    const pcba = db.pcbas.find((p) => p.id === instance.def);
    out.push({ id: instance.id, hint: pcba === undefined ? instance.def : `${pcba.partNumber} ${pcba.revision}` });
  }
  for (const instance of design.instances.components) {
    const component = db.components.find((c) => c.id === instance.def);
    out.push({ id: instance.id, hint: component?.label ?? instance.def });
  }
  return out;
}

export function DrawingForm(props: DrawingFormProps): JSX.Element {
  const { meta } = props;
  const [lengthsText, setLengthsText] = useState(() => formatLengths(meta.lengths));
  const [photoProblem, setPhotoProblem] = useState<string>();
  const [photoNote, setPhotoNote] = useState<string>();
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const parsed = parseLengths(lengthsText);
  const set = <K extends keyof DrawingMeta>(key: K, value: DrawingMeta[K] | undefined): void =>
    props.onMeta(withField(meta, key, value));

  const onLengths = (text: string): void => {
    setLengthsText(text);
    const next = parseLengths(text);
    if (next.problems.length === 0) set('lengths', next.lengths.length === 0 ? undefined : next.lengths);
  };

  const onMaterial = (id: string, value: string): void => {
    const materials = { ...(meta.materials ?? {}) };
    if (value.trim() === '') delete materials[id];
    else materials[id] = value;
    set('materials', Object.keys(materials).length === 0 ? undefined : materials);
  };

  const onPhotoFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setPhotoProblem(`${file.name} is not a PNG or JPEG photo.`);
      setPhotoNote(undefined);
      return;
    }
    setPhotoProblem(undefined);
    const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (file.size <= PHOTO_SIZE_LIMIT) {
      setPhotoNote(undefined);
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') props.onPhoto(reader.result);
      };
      reader.readAsDataURL(file);
      return;
    }
    // over the limit: shrink it to fit instead of refusing it
    void downscalePhoto(file).then((result) => {
      if (result === undefined) {
        setPhotoProblem(`${file.name} is ${mb(file.size)} and this browser could not shrink it — try a smaller photo.`);
        setPhotoNote(undefined);
        return;
      }
      props.onPhoto(result.dataUri);
      setPhotoNote(`${file.name} was ${mb(file.size)} — shrunk to ${mb(result.bytes)} to fit.`);
    });
  };

  const remarksText = (meta.remarks ?? []).join('\n');

  return (
    <details className="cs-drawing-form" open>
      <summary>
        Title block, lengths &amp; photo
        {props.dirty ? <span className="cs-chip is-draft">unsaved</span> : null}
      </summary>
      <div className="cs-drawing-grid">
        <Field
          label="Title"
          wide
          value={meta.title ?? ''}
          placeholder={props.design.label}
          say="As printed in the title block — e.g. XLR Microphone Cable, 5 m."
          onChange={(v) => set('title', v)}
        />
        <PartNumberField
          label="Part number"
          value={meta.partNumber ?? ''}
          placeholder={props.design.productRef ?? 'e.g. CBL-00001'}
          say="The drawing's part number. A drawing covering several lengths may write the family (-3X); each length is its own PN. Suggest proposes one from the numbering in use."
          onChange={(v) => set('partNumber', v)}
          kind="design"
          target={() => ({ kind: 'design', def: props.design, ...(meta.partNumber === undefined ? {} : { partNumber: meta.partNumber }) })}
        />
        {props.revisionFixed === undefined ? (
          <Field label="Revision" value={meta.revision ?? ''} placeholder="0" say="Bump it when the drawing changes." onChange={(v) => set('revision', v)} />
        ) : (
          <Field
            label="Revision"
            value={props.revisionFixed}
            readOnly
            say="Set by the saved version — Save version releases the next number."
            onChange={() => undefined}
          />
        )}
        <Field label="Designer" value={meta.designer ?? ''} placeholder="Designer" say="Who drew it." onChange={(v) => set('designer', v)} />
        <label className="cs-field">
          <span>Date</span>
          <span className="cs-inline">
            <input value={meta.date ?? ''} placeholder="YYYY.MM.DD" onChange={(e) => set('date', e.target.value)} />
            <button type="button" onClick={() => set('date', drawingDate(new Date()))}>
              today
            </button>
          </span>
          <small>Printed as typed; the house style is YYYY.MM.DD.</small>
        </label>
        <label className={parsed.problems.length > 0 ? 'cs-field is-bad' : 'cs-field'}>
          <span>Lengths (mm)</span>
          <textarea rows={4} value={lengthsText} placeholder={'-34 = 1220\n-36 = 1830\n-38 = 2440'} onChange={(e) => onLengths(e.target.value)} />
          {parsed.problems.length > 0 ? (
            <small className="cs-field-bad">{parsed.problems[0]}</small>
          ) : (
            <small>One orderable length per line: -36 = 1830. Blank uses the trunk length from the design.</small>
          )}
        </label>
        <label className="cs-field">
          <span>Extra remarks</span>
          <textarea
            rows={3}
            value={remarksText}
            onChange={(e) => {
              const lines = e.target.value.split('\n');
              set('remarks', lines.every((l) => l.trim() === '') ? undefined : lines);
            }}
          />
          <small>Added after the standard remarks, one per line.</small>
        </label>
        {overridable(props.design, props.db).map(({ id, hint }) => (
          <Field
            key={id}
            label={`BOM wording for ${id}`}
            value={meta.materials?.[id] ?? ''}
            placeholder={hint}
            say="What purchasing orders — e.g. the assembled board PCA-00001. Blank prints the catalog part number."
            onChange={(v) => onMaterial(id, v)}
          />
        ))}
        <label className="cs-field">
          <span>Cable illustration</span>
          <select
            value={meta.cutaway ?? 'art'}
            onChange={(e) => set('cutaway', e.target.value === 'drawn' ? 'drawn' : undefined)}
          >
            <option value="art">Hand-drawn art (where there is some)</option>
            <option value="drawn">Generated from the cable spec</option>
          </select>
          <small>Stocks with no hand-drawn art always use the generated one.</small>
        </label>
        <label className={photoProblem === undefined ? 'cs-field' : 'cs-field is-bad'}>
          <span>Product photo</span>
          <span className="cs-inline">
            <input type="file" accept="image/png,image/jpeg" onChange={onPhotoFile} />
            {props.assets === undefined ? null : (
              <button type="button" onClick={() => setPickingPhoto(true)}>
                Choose from library…
              </button>
            )}
            {props.photo === undefined ? null : (
              <button type="button" onClick={() => props.onPhoto(undefined)}>
                remove
              </button>
            )}
          </span>
          {photoProblem !== undefined ? (
            <small className="cs-field-bad">{photoProblem}</small>
          ) : photoNote !== undefined ? (
            <small>{photoNote}</small>
          ) : (
            <small>
              {props.photo === undefined
                ? 'Optional. Printed top-left, as on the hand-drawn sheets. Uploading the same photo again reuses it — nothing is duplicated.'
                : 'A photo is on the sheet.'}
            </small>
          )}
        </label>
      </div>
      {pickingPhoto && props.assets !== undefined ? (
        <AssetPicker
          assets={props.assets}
          title="Choose a product photo"
          onClose={() => setPickingPhoto(false)}
          onPick={(asset) => {
            props.onPhoto(asset.dataUri);
            setPickingPhoto(false);
          }}
        />
      ) : null}
      <div className="cs-drawing-actions">
        {props.onSave === undefined ? (
          <small>This host cannot store drawing details — they shape the preview and the print only.</small>
        ) : (
          <button type="button" disabled={!props.dirty || props.saving || parsed.problems.length > 0} onClick={props.onSave}>
            {props.saving ? 'saving…' : 'Save drawing details'}
          </button>
        )}
        {props.status === undefined ? null : <small className="cs-drawing-status">{props.status}</small>}
      </div>
    </details>
  );
}
