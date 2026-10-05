/**
 * Shells, housings and fasteners: the parts with no
 * terminals that a cable's BOM still carries. A name, a kind, the part
 * number and revision the shop orders by, and where the facts come from.
 * A crimp contact, seal, cavity plug or crimp tool also says what it fits
 * and the wire it takes (`crimp.ts` in the model).
 */

import type { JSX } from 'react';

import {
  MECHANICAL_KINDS,
  blankTerminationDraft,
  isTerminationKind,
  mechanicalOf,
  terminationFormIssues,
  type MechanicalDraft,
  type TerminationDraft,
} from '../library.ts';
import { slugify } from '../persistence.ts';
import { Choice, Field, FormSection, SrcField } from './fields.tsx';
import { CostFields, costOfExtra, withExtraCost } from './CostFields.tsx';
import { PartNumberField } from './PartNumberField.tsx';

export interface MechanicalEditorProps {
  draft: MechanicalDraft;
  onChange: (next: MechanicalDraft) => void;
  idLocked: boolean;
  /** the library's crimp tools, offered for a contact's tool */
  tools?: readonly { id: string; label: string }[];
  /** contact systems already named in the library, offered as suggestions */
  systems?: readonly string[];
}

const KIND_LABEL: Record<MechanicalDraft['kind'], string> = {
  shell: 'Shell / housing',
  fastener: 'Fastener',
  other: 'Other',
  contact: 'Crimp contact',
  seal: 'Wire / cavity seal',
  plug: 'Cavity plug',
  tool: 'Crimp tool / applicator',
};

export function MechanicalEditor(props: MechanicalEditorProps): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof MechanicalDraft>(key: K, value: MechanicalDraft[K]): void => onChange({ ...draft, [key]: value });
  const setLabel = (label: string): void => {
    // a new record's id follows its name until the id is typed
    const follows = !props.idLocked && (draft.id === '' || draft.id === slugify(draft.label));
    onChange({ ...draft, label, ...(follows ? { id: slugify(label) } : {}) });
  };
  const termination = isTerminationKind(draft.kind) ? (draft.termination ?? blankTerminationDraft()) : undefined;
  const problems = termination === undefined ? [] : terminationFormIssues(termination);
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
    {termination === undefined ? null : (
      <TerminationSection
        kind={draft.kind}
        value={termination}
        problems={problems}
        tools={props.tools ?? []}
        systems={props.systems ?? []}
        onChange={(value) => set('termination', value)}
      />
    )}
    </>
  );
}

function TerminationSection(props: {
  kind: MechanicalDraft['kind'];
  value: TerminationDraft;
  problems: readonly { where: string; message: string }[];
  tools: readonly { id: string; label: string }[];
  systems: readonly string[];
  onChange: (next: TerminationDraft) => void;
}): JSX.Element {
  const { value, kind } = props;
  const set = (key: keyof TerminationDraft, next: string): void => props.onChange({ ...value, [key]: next });
  const problem = (where: string): string | undefined => props.problems.find((p) => p.where === where)?.message;
  const contact = kind === 'contact';
  const takesInsulation = kind === 'contact' || kind === 'seal';
  return (
    <FormSection title="What it fits" say="The housings it goes into and the wire it takes. Leave a value blank when no source states it.">
      <div className="cs-form-grid">
        <Field
          label="Contact systems"
          say="The contact system ids a housing names (comma-separated) — how a part says which housing family it fits."
          value={value.systems}
          onChange={(next) => set('systems', next)}
          placeholder="sealed-1-5"
          options={props.systems}
          mono
        />
        <Field label="Also fits" say="Connector or body ids it fits outright, comma-separated." value={value.housings} onChange={(next) => set('housings', next)} mono />
        {contact ? (
          <>
            <Field label="Wire from (mm²)" value={value.wireMinMm2} onChange={(next) => set('wireMinMm2', next)} problem={problem('smallest wire') ?? problem('wire range')} mono />
            <Field label="Wire to (mm²)" value={value.wireMaxMm2} onChange={(next) => set('wireMaxMm2', next)} problem={problem('largest wire')} mono />
          </>
        ) : null}
        {takesInsulation ? (
          <>
            <Field label="Insulation Ø from (mm)" value={value.insulationMinMm} onChange={(next) => set('insulationMinMm', next)} problem={problem('smallest insulation') ?? problem('insulation range')} mono />
            <Field label="Insulation Ø to (mm)" value={value.insulationMaxMm} onChange={(next) => set('insulationMaxMm', next)} problem={problem('largest insulation')} mono />
          </>
        ) : null}
        {contact ? (
          <>
            <Choice
              label="Contact"
              value={value.gender}
              onChange={(next) => set('gender', next)}
              choices={[
                { value: '', label: 'not stated' },
                { value: 'male', label: 'Pin (male)' },
                { value: 'female', label: 'Socket (female)' },
              ]}
            />
            <Field label="Plating" value={value.plating} onChange={(next) => set('plating', next)} options={['tin', 'gold', 'silver']} />
            <Field label="Strip length (mm)" value={value.stripMm} onChange={(next) => set('stripMm', next)} problem={problem('strip length')} mono />
            <Field label="Rated current (A)" say="Per contact. The electrical rules use it over the housing's contact rating." value={value.ratedCurrentA} onChange={(next) => set('ratedCurrentA', next)} problem={problem('rated current')} mono />
            <Choice
              label="Crimp tool"
              value={value.tool}
              onChange={(next) => set('tool', next)}
              choices={[{ value: '', label: 'none recorded' }, ...props.tools.map((t) => ({ value: t.id, label: t.label }))]}
            />
            <label className="cs-field is-wide" title="Further applicators that crimp this contact, one per line: the tool id, then its own heights (mm² height [width]) separated by semicolons. A cavity picks one; without a pick the crimp tool above is used.">
              <span>Other tools (tool-id: mm² height; …)</span>
              <textarea
                className="cs-mono"
                aria-label="other crimp tools"
                rows={2}
                value={value.tools}
                placeholder={'xh-applicator-b: 0.5 1.2; 0.75 1.35'}
                onChange={(event) => set('tools', event.target.value)}
              />
            </label>
            <label className="cs-field is-wide" title="One wire size per line: cross-section in mm², crimp height in mm, and optionally the crimp width.">
              <span>Crimp heights (mm² height [width])</span>
              <textarea
                className="cs-mono"
                aria-label="crimp heights"
                rows={3}
                value={value.crimpHeights}
                placeholder={'0.5 1.15 1.7\n0.75 1.3 1.7'}
                onChange={(event) => set('crimpHeights', event.target.value)}
              />
            </label>
          </>
        ) : null}
      </div>
      <Field label="Where these values come from" wide value={value.src} onChange={(next) => set('src', next)} placeholder="the datasheet, its table and revision" />
    </FormSection>
  );
}
