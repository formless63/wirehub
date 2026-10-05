/**
 * The connector editor: a name, a family, a gender, and a pin list you build.
 *
 * The pin list is the whole point of the screen, so it gets the room: one row
 * per pin with its number, what the pin carries, the other names it goes by,
 * and a note — added, removed and reordered in place. Order is meaning here
 * (the list is read down the connector), which is why the arrows exist at all.
 *
 * Duplicate numbers are called out on the offending rows *as they are typed*.
 * The host catches them too and is the gate; this copy exists so the answer
 * arrives before a round trip, on the row that is wrong rather than in a list
 * at the bottom.
 */

import type { JSX } from 'react';

import { classes } from '../context.ts';
import {
  connectorOf,
  duplicateRowIds,
  pinRowsReducer,
  type ConnectorDraft,
  type HousingDraft,
  housingDraftOf,
  type PinRow,
  type RowAction,
} from '../library.ts';
import { resolveVocab, type HousingSpec } from '@wirehub/model';

import { signalRefOf, useVocab } from '../vocab.ts';
import { Choice, Field, FormSection, RowTools, SrcField } from './fields.tsx';
import { CostFields, costOfExtra, withExtraCost } from './CostFields.tsx';
import { SourcingFields, sourcingOfExtra, withExtraSourcing } from './SourcingFields.tsx';
import { Pick } from './Pick.tsx';
import { PartNumberField } from './PartNumberField.tsx';

export interface ConnectorEditorProps {
  draft: ConnectorDraft;
  onChange: (next: ConnectorDraft) => void;
  /** an existing record's id cannot change — every design refers to it by that */
  idLocked: boolean;
  /** the housing its body carries, shown read-only while the connector has none of its own (edit it on the body) */
  bodyHousing?: HousingSpec;
}

export function ConnectorEditor(props: ConnectorEditorProps): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof ConnectorDraft>(key: K, value: ConnectorDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const pins = (action: RowAction<PinRow>): void =>
    onChange({ ...draft, pins: pinRowsReducer(draft.pins, action) });

  const duplicates = new Set(duplicateRowIds(draft.pins));
  const { vocab } = useVocab();
  // `family` is still stored as the words (the BOM and the drawings print it);
  // the picker holds the entry those words resolve to, and a pick keeps the
  // record's spelling when it already names that entry
  const familyEntry = resolveVocab(vocab, 'families', draft.family)?.entry;
  const pickFamily = (id: string, picked?: { label: string }): void => {
    if (id === '' || id === familyEntry?.id) return;
    set('family', picked?.label ?? vocab?.['families']?.entries.find((entry) => entry.id === id)?.label ?? id);
  };
  const pickSignal = (index: number, pin: PinRow, id: string, picked?: { label: string }): void => {
    const patch: Partial<PinRow> = { signal: id };
    // a pin with no words of its own reads as its signal
    if (pin.label.trim() === '' && signalRefOf(id) !== undefined && picked !== undefined) patch.label = picked.label;
    pins({ type: 'update', index, patch });
  };

  return (
    <>
      <FormSection title="What this connector is">
        <div className="cs-form-grid">
          <Field
            label="Name"
            say="What a builder would call it — this is what the schematic prints."
            value={draft.label}
            onChange={(value) => set('label', value)}
            placeholder="Connector name"
            autoFocus
            wide
          />
          <Field
            label="Id"
            say={
              props.idLocked
                ? 'Fixed: every design that uses this connector refers to it by this id.'
                : 'Short name used in files and links. Lowercase words joined by hyphens.'
            }
            value={draft.id}
            onChange={(value) => set('id', value)}
            placeholder="follows the name"
            {...(props.idLocked ? { problem: undefined } : {})}
          />
          <Pick
            label="Family"
            say="The connector standard it belongs to."
            list="families"
            value={familyEntry?.id ?? draft.family}
            onChange={pickFamily}
            placeholder="Pick a family"
          />
          <Pick
            label="Gender"
            say="The half you are describing — the plug (male) or the socket (female)."
            list="genders"
            clearable
            noneLabel="not stated"
            value={draft.gender}
            onChange={(value) => set('gender', value as ConnectorDraft['gender'])}
          />
          <PartNumberField
            say="The bare plug or socket as a stock item. Leave blank where there is nothing to order — a board's own edge fingers are not a purchasable connector."
            value={draft.partNumber}
            onChange={(value) => set('partNumber', value)}
            placeholder="e.g. CON-00012"
            kind="connector"
            target={() => ({ kind: 'connector', def: connectorOf(draft) })}
          />
        </div>
        <SrcField value={draft.src} onChange={(value) => set('src', value)} />
      </FormSection>

      <HousingSection
        value={draft.housing}
        {...(props.bodyHousing === undefined ? {} : { inherited: housingDraftOf(props.bodyHousing) })}
        onChange={(housing) => {
          const { housing: _old, ...rest } = draft;
          onChange(housing === undefined ? rest : { ...rest, housing });
        }}
      />

      <FormSection title="Cost" say="Optional. The BOM shows a cost only where parts are priced.">
        <CostFields
          key={draft.id}
          cost={costOfExtra(draft.extra)}
          onChange={(cost) => {
            const extra = withExtraCost(draft.extra, cost);
            const { extra: _drop, ...rest } = draft;
            onChange({ ...rest, ...(extra === undefined ? {} : { extra }) });
          }}
        />
      </FormSection>

      <FormSection title="Sourcing" say="Optional. Made in house, by a contract manufacturer, or bought in.">
        <SourcingFields
          value={sourcingOfExtra(draft.extra)}
          onChange={(sourcing) => {
            const extra = withExtraSourcing(draft.extra, sourcing);
            const { extra: _drop, ...rest } = draft;
            onChange({ ...rest, ...(extra === undefined ? {} : { extra }) });
          }}
        />
      </FormSection>

      <FormSection
        title="Pins"
        say="One row per pin, in the order they are numbered on the connector. A pin with no number is left out."
        right={<span className="cs-count">{draft.pins.length}</span>}
      >
        <table className="cs-rows">
          <thead>
            <tr>
              <th scope="col">Pin</th>
              <th scope="col" title="What the pin carries — picked from the signals list; the tools read this, not the label.">
                Signal
              </th>
              <th scope="col" title="The words printed for this pin. Optional — filled from the signal when blank.">
                Label
              </th>
              <th scope="col" title="Comma-separated — the other names this pin goes by in the sources you work from.">
                Also called
              </th>
              <th scope="col">Note</th>
              <th scope="col">
                <span className="cs-visually-hidden">Reorder</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.pins.map((pin, index) => {
              const clash = pin.id.trim() !== '' && duplicates.has(pin.id.trim());
              return (
                <tr key={index} className={classes(clash && 'is-bad')}>
                  <td>
                    <input
                      className="cs-mono"
                      value={pin.id}
                      aria-label={`pin ${index + 1} number`}
                      placeholder="15"
                      onChange={(event) => pins({ type: 'update', index, patch: { id: event.target.value } })}
                    />
                    {clash ? (
                      <small className="cs-field-bad">
                        Pin ‘{pin.id.trim()}’ is already in this list.
                      </small>
                    ) : null}
                  </td>
                  <td className="cs-pick-cell">
                    <Pick
                      list="signals"
                      ariaLabel={`pin ${index + 1} signal`}
                      value={pin.signal}
                      clearable
                      noneLabel="untagged"
                      placeholder="—"
                      onChange={(id, picked) => pickSignal(index, pin, id, picked)}
                    />
                  </td>
                  <td>
                    <input
                      value={pin.label}
                      aria-label={`pin ${index + 1} label`}
                      placeholder="Red"
                      onChange={(event) =>
                        pins({ type: 'update', index, patch: { label: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={pin.aliases}
                      aria-label={`pin ${index + 1} other names`}
                      placeholder="R, Video R"
                      onChange={(event) =>
                        pins({ type: 'update', index, patch: { aliases: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={pin.note}
                      aria-label={`pin ${index + 1} note`}
                      placeholder="carries +12 V on PAL consoles"
                      onChange={(event) =>
                        pins({ type: 'update', index, patch: { note: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <RowTools
                      index={index}
                      count={draft.pins.length}
                      what={`pin ${index + 1}`}
                      onMove={(by) => pins({ type: 'move', index, by })}
                      onRemove={() => pins({ type: 'remove', index })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="cs-add" onClick={() => pins({ type: 'add' })}>
          + Add a pin
        </button>
      </FormSection>
    </>
  );
}

export const BLANK_HOUSING: HousingDraft = { systems: '', sealing: '', plugUnused: false, cavities: '', src: '' };

const SEALING_WORDS: Readonly<Record<string, string>> = { none: 'unsealed', 'per-wire': 'a seal on each wire', mat: 'mat seal in the housing' };

/** A housing in a sentence, for the read-only view of the one a body carries. */
export function housingSummary(housing: HousingDraft): string {
  const parts = [
    housing.systems.trim() === '' ? undefined : `contact systems ${housing.systems}`,
    housing.sealing === '' ? undefined : SEALING_WORDS[housing.sealing],
    housing.plugUnused ? 'unused cavities plugged' : undefined,
    housing.cavities.trim() === '' ? undefined : `cavities ${housing.cavities}`,
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? 'a crimp housing (nothing more stated)' : parts.join('; ');
}

/**
 * A crimp housing's cavities: the contact systems they take, how wires are
 * sealed and whether unused cavities are plugged. Off for a solder-cup or PCB
 * connector. On a connector, the housing its body carries (`inherited`) is
 * shown while the connector has none of its own; on a body it is the record's
 * own, and the usual place for it.
 */
export function HousingSection(props: {
  value: HousingDraft | undefined;
  onChange: (next: HousingDraft | undefined) => void;
  inherited?: HousingDraft;
  /** the section's owner, for its words: a `connector` (default) or a `body` */
  of?: 'connector' | 'body';
}): JSX.Element {
  const value = props.value;
  const of = props.of ?? 'connector';
  const set = <K extends keyof HousingDraft>(key: K, next: HousingDraft[K]): void => props.onChange({ ...(value ?? BLANK_HOUSING), [key]: next });
  return (
    <FormSection
      title="Crimp housing"
      say={
        of === 'body'
          ? 'For a crimp housing: which contacts, seals and plugs its cavities take. Every connector on this body takes it, unless it states its own; a design then picks them per cavity, and the BOM counts them.'
          : 'For a crimp housing: which contacts, seals and plugs its cavities take. A design then picks them per cavity, and the BOM counts them.'
      }
      right={
        <label className="cs-check-label">
          <input
            type="checkbox"
            aria-label="crimp housing"
            checked={value !== undefined}
            onChange={(event) => props.onChange(event.target.checked ? BLANK_HOUSING : undefined)}
          />{' '}
          takes crimp contacts
        </label>
      }
    >
      {value === undefined ? (
        props.inherited === undefined ? (
          <p className="cs-empty">{of === 'body' ? 'Not a crimp housing.' : 'Not a crimp housing of its own (its body may still say it is).'}</p>
        ) : (
          <p className="cs-empty" data-testid="body-housing">
            Its body says it is a crimp housing: {housingSummary(props.inherited)}. Edit that on the body (the connector journey); tick the box to state a housing of this connector's own instead.
          </p>
        )
      ) : (
        <div className="cs-form-grid">
          <Field label="Contact systems" say="The contact system ids its contacts, seals and plugs name, comma-separated." value={value.systems} onChange={(next) => set('systems', next)} placeholder="sealed-1-5" mono />
          <Choice
            label="Sealing"
            value={value.sealing}
            onChange={(next) => set('sealing', next as HousingDraft['sealing'])}
            choices={[
              { value: '', label: 'not stated' },
              { value: 'none', label: 'Unsealed' },
              { value: 'per-wire', label: 'A seal on each wire' },
              { value: 'mat', label: 'Mat seal in the housing' },
            ]}
          />
          <label className="cs-field" title="A sealed housing closes each unused cavity with a plug.">
            <span>Unused cavities</span>
            <span>
              <input type="checkbox" aria-label="plug unused cavities" checked={value.plugUnused} onChange={(event) => set('plugUnused', event.target.checked)} /> take a plug
            </span>
          </label>
          <Field label="Cavities" say="The pins that are crimp cavities, comma-separated. Blank: every pin but the shell." value={value.cavities} onChange={(next) => set('cavities', next)} mono />
          <Field label="Where this comes from" wide value={value.src} onChange={(next) => set('src', next)} />
        </div>
      )}
    </FormSection>
  );
}
