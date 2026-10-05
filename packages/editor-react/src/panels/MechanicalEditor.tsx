/**
 * Shells, housings and fasteners: the parts with no
 * terminals that a cable's BOM still carries. A name, a kind, the part
 * number and revision the shop orders by, and where the facts come from.
 */

import type { JSX } from 'react';

import { MECHANICAL_KINDS, mechanicalOf, type MechanicalDraft } from '../library.ts';
import { slugify } from '../persistence.ts';
import { Choice, Field, FormSection, SrcField } from './fields.tsx';
import { CostFields, costOfExtra, withExtraCost } from './CostFields.tsx';
import { PartNumberField } from './PartNumberField.tsx';

export interface MechanicalEditorProps {
  draft: MechanicalDraft;
  onChange: (next: MechanicalDraft) => void;
  idLocked: boolean;
}

const KIND_LABEL: Record<MechanicalDraft['kind'], string> = {
  shell: 'Shell / housing',
  fastener: 'Fastener',
  other: 'Other',
};

export function MechanicalEditor(props: MechanicalEditorProps): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof MechanicalDraft>(key: K, value: MechanicalDraft[K]): void => onChange({ ...draft, [key]: value });
  const setLabel = (label: string): void => {
    // a new record's id follows its name until the id is typed
    const follows = !props.idLocked && (draft.id === '' || draft.id === slugify(draft.label));
    onChange({ ...draft, label, ...(follows ? { id: slugify(label) } : {}) });
  };
  return (
    <>
    <FormSection title="What this part is">
      <div className="cs-form-grid">
        <Field label="Name" value={draft.label} onChange={setLabel} placeholder="Part name" autoFocus wide />
        <Field
          label="Id"
          say={props.idLocked ? 'Fixed: designs and kits refer to this part by its id.' : 'Lowercase words joined by hyphens.'}
          value={draft.id}
          onChange={(value) => set('id', value)}
          placeholder="follows the name"
          mono
        />
        <Choice
          label="Kind"
          value={draft.kind}
          onChange={(value) => set('kind', value as MechanicalDraft['kind'])}
          choices={MECHANICAL_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))}
        />
        <PartNumberField
          value={draft.partNumber}
          onChange={(value) => set('partNumber', value)}
          placeholder="e.g. MEC-00012"
          kind={draft.kind === 'shell' ? 'shell' : draft.kind === 'fastener' ? 'fastener' : 'mechanical-other'}
          target={() => ({ kind: 'mechanical', def: mechanicalOf(draft) })}
        />
        <Field label="Revision" say="The released revision this record tracks." value={draft.revision} onChange={(value) => set('revision', value)} placeholder="Rev 3" />
      </div>
      <SrcField value={draft.src} onChange={(value) => set('src', value)} />
    </FormSection>
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
    </>
  );
}
