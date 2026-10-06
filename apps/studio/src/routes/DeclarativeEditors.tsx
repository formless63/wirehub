/** Form views over the JSON draft. Patches preserve fields the form does not understand. */
import { useEffect, useState, type JSX } from 'react';
import { MAX_SEGMENTS, PN_KINDS, RULE_SUBJECTS } from '@wirehub/model';

type ObjectValue = Record<string, unknown>;
export const objectValue = (value: unknown): ObjectValue | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : undefined;
export function draftObject(text: string): ObjectValue | undefined {
  try { return objectValue(JSON.parse(text)); } catch { return undefined; }
}
const inputClass = 'min-w-0 rounded border border-line bg-panel px-1.5 py-1';
const buttonClass = 'rounded border border-line px-2 py-0.5 text-[11px]';
const strings = (value: unknown): string => Array.isArray(value) ? value.join(', ') : '';
const list = (text: string): string[] => text.split(',').map((x) => x.trim()).filter(Boolean);
function patch(value: ObjectValue, key: string, next: unknown): ObjectValue {
  const out = { ...value };
  if (next === undefined) delete out[key]; else out[key] = next;
  return out;
}
function Text({ label, value, onChange, type = 'text' }: { label: string; value: unknown; onChange: (value: string) => void; type?: string }): JSX.Element {
  return <label className="flex min-w-0 flex-col gap-0.5">
    <span>{label}</span>
    <input aria-label={label} className={inputClass} type={type} value={typeof value === 'string' || typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value)} />
  </label>;
}
function Select({ label, value, options, onChange, labels = {} }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void; labels?: Readonly<Record<string, string>> }): JSX.Element {
  return <label className="flex min-w-0 flex-col gap-0.5">
    <span>{label}</span>
    <select aria-label={label} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>{options.includes(value) ? null : <option value={value}>{value || 'Choose…'}</option>}{options.map((x) => <option key={x} value={x}>{labels[x] ?? x}</option>)}</select>
  </label>;
}
function JsonValue({ label, value, onChange }: { label: string; value: unknown; onChange: (value: unknown) => void }): JSX.Element {
  let canonical = '';
  try { canonical = JSON.stringify(value, null, 2) ?? 'null'; } catch { /* An extreme draft stays in the whole-definition JSON editor. */ }
  const [text, setText] = useState(canonical);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(canonical); setInvalid(false); }, [canonical]);
  if (canonical === '') return <p className="text-faint">This draft is too deeply nested for the form. Edit the whole definition in advanced JSON.</p>;
  return <label className="flex flex-col gap-0.5">
    <span>{label}</span>
    <textarea aria-label={label} data-invalid-json={invalid ? "true" : undefined} className={`${inputClass} h-24 font-mono text-[11px]`} value={text} onChange={(e) => { setText(e.target.value); try { onChange(JSON.parse(e.target.value)); setInvalid(false); } catch { setInvalid(true); } }} />{invalid ? <span role="alert" className="text-err">Invalid JSON. The last valid value is kept; correct this draft before saving.</span> : null}</label>;
}

export function SchemeEditor({ value, onChange, disabled }: { value: ObjectValue; onChange: (next: ObjectValue) => void; disabled: boolean }): JSX.Element | null {
  if (value['type'] !== 'declarative' || !Array.isArray(value['segments'])) return null;
  const segments = value['segments'] as unknown[];
  const change = (index: number, next: ObjectValue): void => onChange({ ...value, segments: segments.map((s, i) => i === index ? next : s) });
  return <fieldset disabled={disabled} className="space-y-2" aria-label="Scheme form">
    <div className="grid grid-cols-2 gap-2">
      <Text label="Scheme name" value={value['label']} onChange={(x) => onChange(patch(value, 'label', x))} />
      <Text label="Number template" value={value['template']} onChange={(x) => onChange(patch(value, 'template', x))} />
    </div>
    <label className="flex gap-1">
      <input type="checkbox" aria-label="Existing numbers never change" checked={value['immutable'] === true} onChange={(e) => onChange(patch(value, 'immutable', e.target.checked))} />Existing numbers never change</label>
    {segments.slice(0, MAX_SEGMENTS).map((raw, index) => {
      const segment = objectValue(raw);
      const prefix = `Segment ${index + 1}`;
      if (segment === undefined || !['choice', 'counter', 'variant'].includes(String(segment['type']))) return <JsonValue key={index} label={`${prefix} JSON`} value={raw} onChange={(x) => onChange({ ...value, segments: segments.map((s, i) => i === index ? x : s) })} />;
      const set = (key: string, next: unknown): void => change(index, patch(segment, key, next));
      return <fieldset key={index} className="space-y-2 rounded border border-line p-2">
        <legend>{prefix} · {String(segment['type'])}</legend>
        <div className="grid grid-cols-2 gap-2">
          <Text label={`${prefix} id`} value={segment['id']} onChange={(x) => onChange({ ...value, template: String(value['template'] ?? '').split(`{${String(segment['id'])}}`).join(`{${x}}`), segments: segments.map((s, i) => i === index ? { ...segment, id: x } : s) })} />
          <Text label={`${prefix} name`} value={segment['label']} onChange={(x) => set('label', x || undefined)} />
        </div>
        {segment['type'] === 'choice' ? <>
          {(Array.isArray(segment['values']) ? segment['values'] : []).slice(0, 200).map((rawChoice: unknown, i: number) => {
            const choice = objectValue(rawChoice);
            if (choice === undefined) return null;
            const choices = segment['values'] as unknown[];
            const update = (key: string, next: unknown): void => set('values', choices.map((v, at) => at === i ? patch(choice, key, next) : v));
            return <div key={i} className="grid grid-cols-3 gap-1">
              <Text label={`${prefix} value ${i + 1}`} value={choice['value']} onChange={(x) => update('value', x)} />
              <Text label={`${prefix} value ${i + 1} name`} value={choice['label']} onChange={(x) => update('label', x || undefined)} />
              <Text label={`${prefix} value ${i + 1} kinds`} value={strings(choice['kinds'])} onChange={(x) => update('kinds', x.trim() ? list(x) : undefined)} />
              <button className={buttonClass} type="button" onClick={() => set('values', choices.filter((_, at) => at !== i))}>Remove value {i + 1}</button>
            </div>;
          })}
          <button className={buttonClass} type="button" disabled={Array.isArray(segment['values']) && segment['values'].length >= 200} onClick={() => set('values', [...(Array.isArray(segment['values']) ? segment['values'] : []), { value: 'NEW' }])}>Add value to {String(segment['id'])}</button>
          <Text label={`${prefix} default value`} value={segment['default']} onChange={(x) => set('default', x || undefined)} />
          <p className="text-faint">Kinds (comma separated; empty means any): {PN_KINDS.join(', ')}.</p>
        </> : <>
          <Text label={`${prefix} width`} type="number" value={segment['width']} onChange={(x) => set('width', x === '' ? undefined : Number(x))} />
          {segment['type'] === 'counter' ? <>
            <Text label={`${prefix} count per choices`} value={strings(segment['per'])} onChange={(x) => set('per', x.trim() ? list(x) : undefined)} />
            {(Array.isArray(segment['ranges']) ? segment['ranges'] : []).slice(0, 100).map((rawRange: unknown, i: number) => {
              const range = objectValue(rawRange);
              const ranges = segment['ranges'] as unknown[];
              if (range === undefined) return null;
              const update = (key: string, next: unknown): void => set('ranges', ranges.map((r, at) => at === i ? patch(range, key, next) : r));
              return <div key={i} className="rounded border border-line p-1">
                {range['spans'] === undefined ? <div className="grid grid-cols-2 gap-1">
                  <Text label={`${prefix} range ${i + 1} from`} type="number" value={range['from']} onChange={(x) => update('from', x === '' ? undefined : Number(x))} />
                  <Text label={`${prefix} range ${i + 1} to`} type="number" value={range['to']} onChange={(x) => update('to', x === '' ? undefined : Number(x))} />
                </div> : <span className="text-faint">Multiple spans; edit in advanced range JSON.</span>}
                <details>
                  <summary>Advanced range (matches, spans, exclusions)</summary>
                  <JsonValue label={`${prefix} range ${i + 1} JSON`} value={range} onChange={(x) => set('ranges', ranges.map((r, at) => at === i ? x : r))} />
                </details>
                <button className={buttonClass} type="button" onClick={() => set('ranges', ranges.filter((_, at) => at !== i))}>Remove range {i + 1}</button>
              </div>;
            })}
            <button className={buttonClass} type="button" disabled={Array.isArray(segment['ranges']) && segment['ranges'].length >= 100} onClick={() => set('ranges', [...(Array.isArray(segment['ranges']) ? segment['ranges'] : []), { from: 1, to: 999 }])}>Add range to {String(segment['id'])}</button>
          </> : <>
            <Select label={`${prefix} style`} value={String(segment['style'])} options={['numeric', 'alpha']} onChange={(x) => set('style', x)} />
            <div className="grid grid-cols-2 gap-1">
              <Text label={`${prefix} first`} value={segment['first']} onChange={(x) => set('first', x || undefined)} />
              <Text label={`${prefix} maximum`} value={segment['max']} onChange={(x) => set('max', x || undefined)} />
            </div>
            <Text label={`${prefix} variant kinds`} value={strings(segment['kinds'])} onChange={(x) => set('kinds', x.trim() ? list(x) : undefined)} />
            <label className="flex gap-1">
              <input type="checkbox" aria-label={`${prefix} optional`} checked={segment['optional'] === true} onChange={(e) => set('optional', e.target.checked)} />Optional in template</label>
          </>}
        </>}
        <button className={buttonClass} type="button" onClick={() => onChange({ ...value, segments: segments.filter((_, i) => i !== index), template: String(value['template'] ?? '').split(`{${String(segment['id'])}}`).join('') })}>Remove {prefix.toLowerCase()}</button>
      </fieldset>;
    })}
    <div className="flex gap-1">{['choice', 'counter', 'variant'].map((type) => <button type="button" key={type} className={buttonClass} disabled={segments.length >= MAX_SEGMENTS} onClick={() => {
      let id = `${type}-${segments.length + 1}`;
      while (segments.some((s) => objectValue(s)?.['id'] === id)) id += '-new';
      const segment = type === 'choice' ? { id, type, values: [{ value: 'A' }] } : type === 'counter' ? { id, type, width: 5 } : { id, type, width: 2, style: 'numeric' };
      onChange({ ...value, template: `${String(value['template'] ?? '')}{${id}}`, segments: [...segments, segment] });
    }}>Add {type} segment</button>)}</div>
  </fieldset>;
}

// Limit the form's total nodes as well as its depth; oversized trees remain editable as JSON.
function tooManyNodes(value: unknown): boolean {
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (++count > 100) return true;
    const children = Array.isArray(node) ? node : Object.values(node);
    if (children.length > 100 || pending.length + children.length > 200) return true;
    pending.push(...children);
  }
  return false;
}

const comparisons = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'endsWith'];
const operators = ['all', 'any', 'not', ...comparisons, 'exists', 'empty', 'some', 'every', 'none'];
const quantifiers = ['some', 'every', 'none'];
const operationLabels = { all: 'All conditions', any: 'Any condition', not: 'Not', eq: 'Equals', ne: 'Does not equal', gt: 'Greater than', gte: 'At least', lt: 'Less than', lte: 'At most', in: 'Is in list', contains: 'Contains', startsWith: 'Starts with', endsWith: 'Ends with', exists: 'Is present', empty: 'Is empty', some: 'Some list items', every: 'Every list item', none: 'No list items' };
const operandLabels = { text: 'Text', number: 'Number', boolean: 'True or false', null: 'No value', list: 'Literal list', path: 'Subject field', outer: 'Outer subject field', length: 'List or text length', count: 'Count list items', sum: 'Sum item values', min: 'Smallest item value', max: 'Largest item value' };
const initialCondition = (op: string): ObjectValue => op === 'all' || op === 'any' ? { [op]: [{ exists: { path: 'id' } }] } : op === 'not' ? { not: { exists: { path: 'id' } } } : quantifiers.includes(op) ? { [op]: { in: 'components' } } : op === 'exists' || op === 'empty' ? { [op]: { path: 'id' } } : { [op]: [{ path: 'id' }, ''] };

function OperandEditor({ value, onChange, label, depth }: { value: unknown; onChange: (next: unknown) => void; label: string; depth: number }): JSX.Element {
  const obj = objectValue(value);
  const key = obj === undefined ? Array.isArray(value) ? 'list' : value === null ? 'null' : typeof value : Object.keys(obj)[0] ?? 'JSON';
  const supported = ['text', 'number', 'boolean', 'null', 'list', 'path', 'outer', 'length', 'count', 'sum', 'min', 'max'];
  const type = key === 'string' ? 'text' : key;
  if (!supported.includes(type) || (obj !== undefined && Object.keys(obj).length !== 1) || depth >= 6) return <JsonValue label={`${label} JSON`} value={value} onChange={onChange} />;
  return <div className="space-y-1 border-l border-line pl-2">
    <Select label={`${label} type`} value={type} options={supported} labels={operandLabels} onChange={(x) => onChange(x === 'text' ? '' : x === 'number' ? 0 : x === 'boolean' ? true : x === 'null' ? null : x === 'list' ? [] : ['count', 'sum', 'min', 'max'].includes(x) ? { [x]: { in: 'components', ...(x === 'count' ? {} : { field: 'qty' }) } } : { [x]: 'id' })} />
    {['path', 'outer', 'length'].includes(type) ? <Text label={`${label} field`} value={obj?.[type]} onChange={(x) => onChange({ ...obj, [type]: x })} /> : type === 'list' ? <JsonValue label={`${label} list`} value={value} onChange={onChange} /> : type === 'boolean' ? <Select label={`${label} value`} value={String(value)} options={['true', 'false']} onChange={(x) => onChange(x === 'true')} /> : type === 'null' ? null : type === 'text' || type === 'number' ? <Text label={`${label} value`} type={type === 'number' ? 'number' : 'text'} value={value} onChange={(x) => onChange(type === 'number' ? Number(x) : x)} /> : <SelectorEditor value={objectValue(obj?.[type]) ?? {}} onChange={(x) => onChange({ ...obj, [type]: x })} label={label} depth={depth + 1} aggregate={type !== 'count'} />}
  </div>;
}
function SelectorEditor({ value, onChange, label, depth, aggregate = false }: { value: ObjectValue; onChange: (next: ObjectValue) => void; label: string; depth: number; aggregate?: boolean }): JSX.Element {
  return <div className="space-y-1">
    <Text label={`${label} list field`} value={value['in']} onChange={(x) => onChange(patch(value, 'in', x))} />{aggregate ? <Text label={`${label} item field`} value={value['field']} onChange={(x) => onChange(patch(value, 'field', x))} /> : null}
    {value['where'] === undefined ? <button type="button" className={buttonClass} onClick={() => onChange(patch(value, 'where', { exists: { path: 'id' } }))}>Filter {label.toLowerCase()} items</button> : <>
    <ConditionEditor value={value['where']} onChange={(x) => onChange(patch(value, 'where', x))} label={`${label} item filter`} depth={depth + 1} />
    <button type="button" className={buttonClass} onClick={() => onChange(patch(value, 'where', undefined))}>Remove {label.toLowerCase()} item filter</button>
  </>}
  </div>;
}
export function ConditionEditor({ value, onChange, label, depth = 0 }: { value: unknown; onChange: (next: unknown) => void; label: string; depth?: number }): JSX.Element {
  const obj = objectValue(value);
  const op = obj === undefined ? '' : Object.keys(obj)[0] ?? '';
  if (obj === undefined || Object.keys(obj).length !== 1 || !operators.includes(op) || depth >= 6 || (depth === 0 && tooManyNodes(value)) || ((op === 'all' || op === 'any' || comparisons.includes(op)) && !Array.isArray(obj[op])) || (comparisons.includes(op) && (obj[op] as unknown[]).length !== 2) || (quantifiers.includes(op) && objectValue(obj[op]) === undefined)) return <JsonValue label={`${label} JSON`} value={value} onChange={onChange} />;
  const body = obj[op];
  return <fieldset className="space-y-1 rounded border border-line p-2">
    <legend>{label}</legend>
    <Select label={`${label} operation`} value={op} options={operators} labels={operationLabels} onChange={(x) => onChange(initialCondition(x))} />
    {op === 'all' || op === 'any' ? <>
      {(Array.isArray(body) ? body : []).slice(0, 20).map((child: unknown, i: number) => <div key={i}>
        <ConditionEditor value={child} label={`${label} condition ${i + 1}`} depth={depth + 1} onChange={(x) => onChange({ ...obj, [op]: (body as unknown[]).map((c, at) => at === i ? x : c) })} />
        <button type="button" className={buttonClass} onClick={() => onChange({ ...obj, [op]: (body as unknown[]).filter((_, at) => at !== i) })}>Remove {label.toLowerCase()} condition {i + 1}</button>
      </div>)}
      <button type="button" className={buttonClass} disabled={Array.isArray(body) && body.length >= 20} onClick={() => onChange({ ...obj, [op]: [...(Array.isArray(body) ? body : []), { exists: { path: 'id' } }] })}>Add {label.toLowerCase()} condition</button>
      {Array.isArray(body) && body.length > 20 ? <p className="text-faint">Remaining conditions are preserved in advanced JSON.</p> : null}
    </> : op === 'not' ? <ConditionEditor value={body} label={`${label} negated`} depth={depth + 1} onChange={(x) => onChange({ ...obj, not: x })} /> : quantifiers.includes(op) ? <SelectorEditor value={objectValue(body) ?? {}} onChange={(x) => onChange({ ...obj, [op]: x })} label={label} depth={depth + 1} /> : comparisons.includes(op) ? <div className="grid grid-cols-2 gap-2">{[0, 1].map((i) => <OperandEditor key={i} label={`${label} ${i === 0 ? 'left' : 'right'}`} depth={depth + 1} value={Array.isArray(body) ? body[i] : undefined} onChange={(x) => onChange({ ...obj, [op]: [i === 0 ? x : (body as unknown[])?.[0], i === 1 ? x : (body as unknown[])?.[1]] })} />)}</div> : <OperandEditor value={body} label={`${label} operand`} depth={depth + 1} onChange={(x) => onChange({ ...obj, [op]: x })} />}
  </fieldset>;
}
export function RuleEditor({ value, onChange }: { value: ObjectValue; onChange: (next: ObjectValue) => void }): JSX.Element {
  return <div className="space-y-2" aria-label="Rule form">
    <div className="grid grid-cols-2 gap-2">
      <Text label="Rule id" value={value['id']} onChange={(x) => onChange(patch(value, 'id', x))} />
      <Text label="Rule name" value={value['label']} onChange={(x) => onChange(patch(value, 'label', x || undefined))} />
      <Select label="Rule subject" value={String(value['each'] ?? '')} options={RULE_SUBJECTS} onChange={(x) => onChange(patch(value, 'each', x))} />
      <Select label="Rule severity" value={String(value['severity'] ?? '')} options={['error', 'warning']} onChange={(x) => onChange(patch(value, 'severity', x))} />
    </div>
    <Text label="Rule message" value={value['message']} onChange={(x) => onChange(patch(value, 'message', x))} />
    <Text label="Rule source" value={value['src']} onChange={(x) => onChange(patch(value, 'src', x))} />
    {value['where'] === undefined ? <button type="button" className={buttonClass} onClick={() => onChange(patch(value, 'where', { exists: { path: 'id' } }))}>Add subject filter</button> : <>
    <ConditionEditor label="Applies when" value={value['where']} onChange={(x) => onChange(patch(value, 'where', x))} />
    <button type="button" className={buttonClass} onClick={() => onChange(patch(value, 'where', undefined))}>Apply to every subject</button>
  </>}
    <ConditionEditor label="Require" value={value['require']} onChange={(x) => onChange(patch(value, 'require', x))} />
  </div>;
}
