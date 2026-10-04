/**
 * A kit (data model v2 §7.1): one orderable SKU and the
 * parts it ships. Every part is picked from the library — connectors, boards,
 * shells, fasteners, components, wire — never typed, and a line can be
 * scoped to one stock (the `-00` coax vs `-30` bonded multi-core shell inside one
 * kit SKU, owner question Q11). Kits are informational: a cable BOM lists the
 * parts, never the kit.
 */

import { KIT_PART_KINDS, KIT_SKU, kitPartExists, type Db, type KitPartKind } from '@cable-studio/model';
import { wireDisplayName } from '@cable-studio/docs';
import { useMemo, type JSX } from 'react';

import { classes } from '../context.ts';
import { kitLineRowsReducer, kitOf, type KitDraft, type KitLineRow, type RowAction } from '../library.ts';
import { slugify } from '../persistence.ts';
import type { PickOption } from '../vocab.ts';
import { Field, FormSection, RowTools, SrcField } from './fields.tsx';
import { Pick } from './Pick.tsx';
import { PartNumberField } from './PartNumberField.tsx';

export interface KitEditorProps {
  draft: KitDraft;
  onChange: (next: KitDraft) => void;
  idLocked: boolean;
  /** the library the parts are picked from */
  db: Db;
  /** open a line's part on its own tab */
  onOpenPart?: (kind: KitPartKind, id: string) => void;
}

export const KIT_PART_LABEL: Record<KitPartKind, string> = {
  connector: 'Connector',
  pcba: 'Board',
  mechanical: 'Shell / hardware',
  component: 'Component',
  wire: 'Wire',
};

/** Every record of one kind, as picker options. */
export function kitPartOptions(db: Db, kind: KitPartKind): PickOption[] {
  const records: readonly { id: string; label: string; partNumber?: string }[] =
    kind === 'connector'
      ? db.connectors
      : kind === 'pcba'
        ? db.pcbas
        : kind === 'mechanical'
          ? (db.mechanicals ?? [])
          : kind === 'component'
            ? db.components
            : db.wires;
  return records.map((record) => ({
    value: record.id,
    // never the manufacturer here (owner 2026-09-25/26) — it stays inside the wire's own detail view
    label: kind === 'wire' ? wireDisplayName(db, record.id) : record.label,
    hint: [record.partNumber, record.id].filter((bit) => bit !== undefined && bit !== '').join(' · '),
  }));
}

export function KitEditor(props: KitEditorProps): JSX.Element {
  const { draft, onChange, db } = props;
  const set = <K extends keyof KitDraft>(key: K, value: KitDraft[K]): void => onChange({ ...draft, [key]: value });
  const lines = (action: RowAction<KitLineRow>): void => onChange({ ...draft, lines: kitLineRowsReducer(draft.lines, action) });
  const setLabel = (label: string): void => {
    const follows = !props.idLocked && (draft.id === '' || draft.id === slugify(draft.label));
    onChange({ ...draft, label, ...(follows ? { id: slugify(label) } : {}) });
  };
  const options = useMemo(
    () => Object.fromEntries(KIT_PART_KINDS.map((kind) => [kind, kitPartOptions(db, kind)])) as Record<KitPartKind, PickOption[]>,
    [db],
  );
  const skuProblem = draft.sku.trim() === '' || KIT_SKU.test(draft.sku.trim()) ? undefined : 'A SKU reads like KIT-00101-00.';
  return (
    <>
      <FormSection title="What this kit is">
        <div className="cs-form-grid">
          <Field label="Name" value={draft.label} onChange={setLabel} placeholder="Kit name" autoFocus wide />
          <PartNumberField
            label="SKU"
            say="The orderable identity of the kit — a different stock item from any part in it."
            value={draft.sku}
            onChange={(value) => set('sku', value)}
            placeholder="e.g. KIT-00012"
            {...(skuProblem === undefined ? {} : { problem: skuProblem })}
            kind="kit"
            target={() => ({ kind: 'kit', def: kitOf(draft) })}
          />
          <Field
            label="Id"
            say={props.idLocked ? 'Fixed.' : 'Lowercase words joined by hyphens.'}
            value={draft.id}
            onChange={(value) => set('id', value)}
            placeholder="follows the name"
            mono
          />
        </div>
        <SrcField value={draft.src} onChange={(value) => set('src', value)} />
      </FormSection>

      <FormSection title="Parts" right={<span className="cs-count">{draft.lines.filter((line) => line.def !== '').length}</span>}>
        <table className="cs-rows cs-kit-rows">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Part</th>
              <th scope="col" title="How many of this part the kit ships">Qty</th>
              <th scope="col" title="A line that applies to one stock family only — the coax or the bonded multi-core shell">Stock</th>
              <th scope="col" title="The catalog's inference, for the owner to confirm">Inferred</th>
              <th scope="col">Note</th>
              <th scope="col">
                <span className="cs-visually-hidden">Reorder</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((line, index) => {
              const missing = line.def !== '' && !kitPartExists(db, { kind: line.kind, def: line.def });
              return (
                <tr key={index} className={classes(missing && 'is-bad')}>
                  <td>
                    <select
                      aria-label={`line ${index + 1} kind`}
                      value={line.kind}
                      onChange={(event) => lines({ type: 'update', index, patch: { kind: event.target.value as KitPartKind, def: '' } })}
                    >
                      {KIT_PART_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {KIT_PART_LABEL[kind]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="cs-pick-cell">
                    <span className="cs-kit-part">
                      <Pick
                        ariaLabel={`line ${index + 1} part`}
                        options={options[line.kind]}
                        value={line.def}
                        placeholder="Pick a part"
                        onChange={(value) => lines({ type: 'update', index, patch: { def: value } })}
                      />
                      {props.onOpenPart === undefined || line.def === '' || missing ? null : (
                        <button
                          type="button"
                          className="cs-small cs-icon-btn"
                          aria-label={`open ${line.def}`}
                          title="Open this part"
                          onClick={() => props.onOpenPart!(line.kind, line.def)}
                        >
                          ↗
                        </button>
                      )}
                    </span>
                  </td>
                  <td>
                    <input
                      className="cs-mono cs-qty"
                      inputMode="numeric"
                      aria-label={`line ${index + 1} quantity`}
                      value={line.qty}
                      onChange={(event) => lines({ type: 'update', index, patch: { qty: event.target.value } })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`line ${index + 1} stock`}
                      value={line.stock}
                      onChange={(event) => lines({ type: 'update', index, patch: { stock: event.target.value as KitLineRow['stock'] } })}
                    >
                      <option value="">Any</option>
                      <option value="coax">Coax</option>
                      <option value="bonded">Bonded multi-core</option>
                    </select>
                  </td>
                  <td className="cs-center">
                    <input
                      type="checkbox"
                      aria-label={`line ${index + 1} inferred`}
                      checked={line.inferred}
                      onChange={(event) => lines({ type: 'update', index, patch: { inferred: event.target.checked } })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`line ${index + 1} note`}
                      value={line.note}
                      title={line.src === '' ? undefined : `Source: ${line.src}`}
                      onChange={(event) => lines({ type: 'update', index, patch: { note: event.target.value } })}
                    />
                  </td>
                  <td>
                    <RowTools
                      index={index}
                      count={draft.lines.length}
                      what={`line ${index + 1}`}
                      onMove={(by) => lines({ type: 'move', index, by })}
                      onRemove={() => lines({ type: 'remove', index })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="cs-add" onClick={() => lines({ type: 'add' })}>
          + Add a part
        </button>
      </FormSection>
    </>
  );
}
