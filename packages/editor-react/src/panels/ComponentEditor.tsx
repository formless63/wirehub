/**
 * The component editor: what the part is, what it is worth, and its legs.
 *
 * Small screen, one wrinkle worth the code. A capacitor has a polarity and
 * putting it in backwards destroys it, so the polarity column appears for the
 * kinds where it means something and stays out of the way where it does not —
 * a resistor has no + leg, and offering one invites a wrong answer.
 */

import type { ComponentDefinition } from '@cable-studio/model';
import { useMemo, type JSX } from 'react';

import { classes } from '../context.ts';
import {
  componentOf,
  duplicateRowIds,
  terminalRowsReducer,
  type ComponentDraft,
  type RowAction,
  type TerminalRow,
} from '../library.ts';
import { useCatalogValues } from '../catalog-values.ts';
import {
  isTemplateTerminals,
  standardValues,
  suggestComponentId,
  suggestComponentLabel,
  terminalTemplate,
  valueAliases,
} from '../standard-values.ts';
import type { PickOption } from '../vocab.ts';
import { Field, FormSection, RowTools, SrcField } from './fields.tsx';
import { Pick } from './Pick.tsx';
import { PartNumberField } from './PartNumberField.tsx';

export interface ComponentEditorProps {
  draft: ComponentDraft;
  onChange: (next: ComponentDraft) => void;
  idLocked: boolean;
}

/** The kinds whose legs are not interchangeable. */
const POLARISED: ReadonlySet<ComponentDefinition['kind']> = new Set(['capacitor', 'ic']);

/** a kind added to the list in-app (hdy.9): it starts from the generic two-leg preset */
const NEW_KIND_SAY = 'A kind added to the list: it starts with two legs — add, rename or mark them as the part needs.';

const KIND_SAY: Partial<Record<ComponentDefinition['kind'], string>> = {
  resistor: 'Two legs, no polarity — either way round.',
  capacitor: 'Polarised: the + leg has to face the higher voltage.',
  ic: 'A chip. Its legs are numbered, and the numbering matters.',
  switch: 'A switch or jumper. Its positions are described in the note.',
  other: 'Anything else soldered into the build.',
};

export function ComponentEditor(props: ComponentEditorProps): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof ComponentDraft>(key: K, value: ComponentDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const terminals = (action: RowAction<TerminalRow>): void =>
    onChange({ ...draft, terminals: terminalRowsReducer(draft.terminals, action) });

  const duplicates = new Set(duplicateRowIds(draft.terminals));
  const polarised = POLARISED.has(draft.kind);
  const values = useCatalogValues();

  // the journey (data model v2 §8 J4): the kind decides the legs and the
  // value list, and a new part's name and id follow the value until typed over
  const valueOptions = useMemo((): PickOption[] => {
    const standard = standardValues(draft.kind);
    const known = new Set(standard.map((entry) => entry.value));
    const inCatalog = values.componentValues
      .filter((value) => !known.has(value) && (standard.length === 0 || standard.some((s) => value.endsWith(s.unit))))
      .map((value) => ({ value, label: value, group: 'In the catalog' }));
    return [
      ...inCatalog.map((option) => ({ ...option, aliases: valueAliases(option.value) })),
      ...standard.map((entry) => ({
        value: entry.value,
        label: entry.value,
        group: entry.unit,
        aliases: valueAliases(entry.value),
      })),
    ];
  }, [draft.kind, values.componentValues]);

  const follow = (next: ComponentDraft): ComponentDraft => {
    if (props.idLocked) return next;
    const before = { label: suggestComponentLabel(draft.kind, draft.value), id: suggestComponentId(draft.kind, draft.value) };
    const after = { label: suggestComponentLabel(next.kind, next.value), id: suggestComponentId(next.kind, next.value) };
    return {
      ...next,
      ...(draft.label.trim() === '' || draft.label === before.label ? { label: after.label } : {}),
      ...(draft.id.trim() === '' || draft.id === before.id ? { id: after.id } : {}),
    };
  };

  const pickKind = (kind: ComponentDefinition['kind']): void => {
    if (kind === draft.kind) return;
    const template = terminalTemplate(kind);
    const standardBefore = new Set(standardValues(draft.kind).map((entry) => entry.value));
    onChange(
      follow({
        ...draft,
        kind,
        // a value picked from the old kind's series means nothing for the new one
        ...(standardBefore.has(draft.value) ? { value: '' } : {}),
        ...(template !== undefined && isTemplateTerminals(draft.terminals)
          ? { terminals: template.map((row) => ({ ...row })) }
          : {}),
      }),
    );
  };

  return (
    <>
      <FormSection title="What this part is">
        <div className="cs-form-grid">
          <Field
            label="Name"
            say="How it reads on the build sheet and in the BOM."
            value={draft.label}
            onChange={(value) => set('label', value)}
            placeholder="Value, type (role)"
            autoFocus
            wide
          />
          <Field
            label="Id"
            say={
              props.idLocked
                ? 'Fixed: every design that uses this part refers to it by this id.'
                : 'Short name used in files and links. Lowercase words joined by hyphens.'
            }
            value={draft.id}
            onChange={(value) => set('id', value)}
            placeholder="follows the name"
          />
          <Pick
            label="Kind"
            say={`${KIND_SAY[draft.kind] ?? NEW_KIND_SAY} Picking a kind sets its terminals and its value list. Add a kind the list lacks by typing its name.`}
            list="component-kinds"
            value={draft.kind}
            onChange={(value) => {
              // open list (hdy.9): a kind added here is as good as a built-in one
              if (value !== '') pickKind(value);
            }}
          />
          <Pick
            label="Value"
            say={
              standardValues(draft.kind).length === 0
                ? 'Written the way it is spoken, with its unit. Type a value and pick “Use”.'
                : 'Picked from the standard series for this kind (E24 resistors, E12 capacitors). Type to filter — 4.7k, 220u; a value off the series can still be used.'
            }
            options={valueOptions}
            allowCustom
            allowAdd={false}
            clearable
            noneLabel="no value"
            value={draft.value}
            onChange={(value) => {
              // a capacitor's legs follow its value: µF polarised, pF/nF not
              const template = terminalTemplate(draft.kind, value);
              onChange(
                follow({
                  ...draft,
                  value,
                  ...(draft.kind === 'capacitor' && template !== undefined && isTemplateTerminals(draft.terminals)
                    ? { terminals: template.map((row) => ({ ...row })) }
                    : {}),
                }),
              );
            }}
            placeholder="Pick a value"
          />
          <PartNumberField
            say="What you would order. Leave blank if the value is the whole specification."
            value={draft.partNumber}
            onChange={(value) => set('partNumber', value)}
            placeholder="Maker part no. (supplier no.)"
            wide
            kind="component"
            target={() => ({ kind: 'component', def: componentOf(draft) })}
          />
        </div>
        <SrcField value={draft.src} onChange={(value) => set('src', value)} />
      </FormSection>

      <FormSection
        title="Terminals"
        say={
          polarised
            ? 'The legs, and which way round they go. Mark the + leg — a polarised part soldered backwards is a dead part.'
            : 'The legs. For a two-legged part these are simply `a` and `b`.'
        }
        right={<span className="cs-count">{draft.terminals.length}</span>}
      >
        <table className="cs-rows">
          <thead>
            <tr>
              <th scope="col">Terminal</th>
              <th scope="col">Called</th>
              {polarised ? <th scope="col">Polarity</th> : null}
              <th scope="col">
                <span className="cs-visually-hidden">Reorder</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.terminals.map((terminal, index) => {
              const clash = terminal.id.trim() !== '' && duplicates.has(terminal.id.trim());
              return (
                <tr key={index} className={classes(clash && 'is-bad')}>
                  <td>
                    <input
                      className="cs-mono"
                      value={terminal.id}
                      aria-label={`terminal ${index + 1} id`}
                      placeholder="a"
                      onChange={(event) =>
                        terminals({ type: 'update', index, patch: { id: event.target.value } })
                      }
                    />
                    {clash ? (
                      <small className="cs-field-bad">
                        ‘{terminal.id.trim()}’ is already in this list.
                      </small>
                    ) : null}
                  </td>
                  <td>
                    <input
                      value={terminal.label}
                      aria-label={`terminal ${index + 1} label`}
                      placeholder="+"
                      onChange={(event) =>
                        terminals({ type: 'update', index, patch: { label: event.target.value } })
                      }
                    />
                  </td>
                  {polarised ? (
                    <td>
                      <select
                        value={terminal.polarity}
                        aria-label={`terminal ${index + 1} polarity`}
                        onChange={(event) =>
                          terminals({
                            type: 'update',
                            index,
                            patch: { polarity: event.target.value as TerminalRow['polarity'] },
                          })
                        }
                      >
                        <option value="">not polarised</option>
                        <option value="+">+ (positive)</option>
                        <option value="-">− (negative)</option>
                      </select>
                    </td>
                  ) : null}
                  <td>
                    <RowTools
                      index={index}
                      count={draft.terminals.length}
                      what={`terminal ${index + 1}`}
                      onMove={(by) => terminals({ type: 'move', index, by })}
                      onRemove={() => terminals({ type: 'remove', index })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="cs-add" onClick={() => terminals({ type: 'add' })}>
          + Add a terminal
        </button>
      </FormSection>
    </>
  );
}
