/** Ordinary product authoring uses fields. Advanced JSON remains an optional interchange tool. */
import { useState, type JSX } from 'react';
import type { ProductFamily, ProductVariant } from '@wirehub/model';
import { Button, Field, Input, NumberInput, Select, Textarea } from '@wirehub/editor-react';
import { newRecordId } from '../display.ts';

const statuses = [{ value: 'active', label: 'Active' }, { value: 'development', label: 'In development' }, { value: 'legacy', label: 'Legacy' }, { value: 'retired', label: 'Retired' }];
const split = (text: string): string[] => text.split(',').map((x) => x.trim()).filter(Boolean);
export function ProductForm({ text, onChange, designs }: { text: string; onChange: (text: string) => void; designs: readonly { id: string; label: string }[] }): JSX.Element {
  const [advanced, setAdvanced] = useState(false);
  let record: ProductFamily | undefined;
  try {
    const parsed = JSON.parse(text) as ProductFamily;
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
    const named = (v: unknown): boolean => object(v) && typeof v.id === 'string' && typeof v.label === 'string';
    if (object(parsed) && Array.isArray(parsed.variants) && parsed.variants.every((v) => object(v) && typeof v.id === 'string') &&
      (parsed.aliases === undefined || strings(parsed.aliases)) && (parsed.tags === undefined || strings(parsed.tags)) &&
      (parsed.options === undefined || (Array.isArray(parsed.options) && parsed.options.every((a) => named(a) && Array.isArray(a.values) && a.values.every(named))))) record = parsed;
  } catch { /* Keep an invalid advanced draft editable. */ }
  const value = record;
  const save = (next: ProductFamily): void => onChange(JSON.stringify(next, null, 2));
  const field = (key: 'label' | 'partNumber' | 'description' | 'src', label: string): JSX.Element => <Field label={label}><Input aria-label={label} value={value?.[key] ?? ''} onChange={(e) => value && save({ ...value, [key]: e.target.value })} /></Field>;
  const variant = (index: number, next: ProductVariant): void => { if (value) save({ ...value, variants: value.variants.map((v, i) => i === index ? next : v) }); };
  const removeOption = (axisId: string, choiceId?: string): void => {
    if (!value) return;
    save({ ...value,
      options: choiceId === undefined ? value.options?.filter((axis) => axis.id !== axisId) : value.options?.map((axis) => axis.id === axisId ? { ...axis, values: axis.values.filter((choice) => choice.id !== choiceId) } : axis),
      variants: value.variants.map((v) => {
        if (v.options?.[axisId] === undefined || (choiceId !== undefined && v.options[axisId] !== choiceId)) return v;
        const options = { ...v.options }; delete options[axisId];
        return { ...v, options };
      }),
    });
  };
  return <div className="flex flex-col gap-3" data-testid="product-form">
    {value === undefined ? <p role="alert">The advanced draft is invalid. Correct it below to return to the form.</p> : <>
      <div className="grid grid-cols-2 gap-2">{field('label', 'Product name')}{field('partNumber', 'Product number')}{field('description', 'Description')}{field('src', 'Source')}
        <Field label="Status"><Select aria-label="Product status" value={value.status ?? 'active'} options={statuses} onValueChange={(v) => save({ ...value, status: v as ProductFamily['status'] })} /></Field>
        <Field label="Also known as" hint="Separate names or numbers with commas"><Input aria-label="Product aliases" key={(value.aliases ?? []).join(",")} defaultValue={(value.aliases ?? []).join(', ')} onBlur={(e) => save({ ...value, aliases: split(e.target.value) })} /></Field>
        <Field label="Tags"><Input aria-label="Product tags" key={(value.tags ?? []).join(",")} defaultValue={(value.tags ?? []).join(', ')} onBlur={(e) => save({ ...value, tags: split(e.target.value) })} /></Field>
      </div>
      <fieldset className="flex flex-col gap-2 rounded border border-line p-2"><legend>Options</legend>
        {(value.options ?? []).map((axis, index) => {
          const change = (next: typeof axis): void => save({ ...value, options: value.options!.map((a, i) => i === index ? next : a) });
          return <div key={axis.id} className="flex flex-col gap-2 rounded border border-line p-2">
            <Field label="Option name"><Input aria-label={`Option ${index + 1} name`} value={axis.label} onChange={(e) => change({ ...axis, label: e.target.value })} /></Field>
            {axis.values.map((choice, at) => <div key={choice.id} className="flex gap-2"><Input aria-label={`Option ${index + 1} value ${at + 1}`} value={choice.label} onChange={(e) => change({ ...axis, values: axis.values.map((v, i) => i === at ? { ...v, label: e.target.value } : v) })} /><Button size="xs" onClick={() => removeOption(axis.id, choice.id)}>Remove value</Button></div>)}
            <div className="flex gap-2"><Button size="xs" onClick={() => change({ ...axis, values: [...axis.values, { id: newRecordId('value', axis.values.map((v) => v.id)), label: '' }] })}>Add value</Button><Button size="xs" onClick={() => removeOption(axis.id)}>Remove option</Button></div>
          </div>;
        })}
        <Button size="xs" onClick={() => save({ ...value, options: [...(value.options ?? []), { id: newRecordId('option', (value.options ?? []).map((a) => a.id)), label: '', values: [] }] })}>Add option</Button>
      </fieldset>
      {value.variants.map((v, index) => <fieldset key={v.id} className="grid grid-cols-2 gap-2 rounded border border-line p-2"><legend>Variant {index + 1}</legend>
        <Field label="Name"><Input aria-label={`Variant ${index + 1} name`} value={v.label ?? ''} onChange={(e) => variant(index, { ...v, label: e.target.value })} /></Field>
        <Field label="Design"><Select aria-label={`Variant ${index + 1} design`} value={v.design || undefined} placeholder="Choose a design…" options={designs.map((d) => ({ value: d.id, label: d.label }))} onValueChange={(design) => variant(index, { ...v, design })} /></Field>
        <Field label="Part number"><Input aria-label={`Variant ${index + 1} number`} value={v.partNumber ?? ''} onChange={(e) => variant(index, { ...v, partNumber: e.target.value })} /></Field>
        <Field label="Length"><NumberInput aria-label={`Variant ${index + 1} length`} value={v.lengthMm ?? null} unit="mm" min={0} onChange={(lengthMm) => { const { lengthMm: _old, ...rest } = v; variant(index, lengthMm === null ? rest : { ...rest, lengthMm }); }} /></Field>
        <Field label="Status"><Select aria-label={`Variant ${index + 1} status`} value={v.status ?? 'active'} options={statuses} onValueChange={(status) => variant(index, { ...v, status: status as ProductVariant['status'] })} /></Field>
        <Field label="Note"><Input aria-label={`Variant ${index + 1} note`} value={v.note ?? ''} onChange={(e) => variant(index, { ...v, note: e.target.value })} /></Field>
        {(value.options ?? []).map((axis) => <Field key={axis.id} label={axis.label || 'Option'}><Select aria-label={`Variant ${index + 1} ${axis.label || 'option'}`} value={v.options?.[axis.id] ?? '__none__'} options={[{ value: '__none__', label: 'Not specified' }, ...axis.values.map((x) => ({ value: x.id, label: x.label || 'Unnamed value' }))]} onValueChange={(selected) => { const options = { ...v.options }; if (selected === '__none__') delete options[axis.id]; else options[axis.id] = selected; variant(index, { ...v, options }); }} /></Field>)}
        <Button size="xs" onClick={() => save({ ...value, variants: value.variants.filter((_, i) => i !== index) })}>Remove variant</Button>
      </fieldset>)}
      <Button className="self-start" onClick={() => save({ ...value, variants: [...value.variants, { id: newRecordId('variant', value.variants.map((v) => v.id)), design: '', label: '' }] })}>Add variant</Button>
    </>}
    <details open={advanced || value === undefined} onToggle={(e) => setAdvanced(e.currentTarget.open)}><summary className="cursor-pointer text-faint">Advanced: edit JSON</summary><Textarea mono rows={14} aria-label="Product record" value={text} spellCheck={false} onChange={(e) => onChange(e.target.value)} /></details>
  </div>;
}
