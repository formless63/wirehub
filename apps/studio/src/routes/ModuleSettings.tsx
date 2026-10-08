/**
 * Settings → Module settings (`server/module-settings.ts`, module API 1.5): one section per
 * installed module that declares settings — mostly credentials (a supplier's API key) that
 * used to be deployment variables. A secret is write-only: set, replaced or cleared, never
 * shown; its status says configured, set by the server (locked) or missing. A value the
 * server's environment sets wins and is shown locked. Owners change them, in a signed-in
 * session; everyone else sees that the section is the owner's.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { Button, Callout, Checkbox, Chip, Field, HelpTip, Input, Select, Textarea } from '@wirehub/editor-react';

import { runtimeSettingsKey, runtimeSettingsQuery, saveModuleSecret, saveModuleSettings, type ModuleFieldView, type ModuleSettingsView, type RuntimeValue } from '../settings.browser.ts';

const ABOUT =
  'Credentials and options this module asks for. Secrets are kept encrypted with the hub\u2019s settings key and never shown again; a change applies at once, with no restart. A value the server\u2019s environment sets wins and is shown locked.';

type Draft = Record<string, string | boolean | string[]>;

function draftOf(section: ModuleSettingsView): Draft {
  const out: Draft = {};
  for (const field of section.fields) {
    if (field.secret === true) continue;
    const value = field.source === 'server' ? field.saved : field.value;
    out[field.key] = field.kind === 'list' ? (Array.isArray(value) ? value : []) : field.kind === 'bool' ? (typeof value === 'boolean' ? value : '') : typeof value === 'string' ? value : '';
  }
  return out;
}

function Status({ field }: { field: ModuleFieldView }): JSX.Element {
  const gate = field.gates === undefined ? '' : ` for ${field.gates}`;
  const text =
    field.status === 'server'
      ? `set by the server (${field.env ?? ''}), locked`
      : field.unreadable === true
        ? 'saved, but this server cannot decrypt it: enter it again'
        : field.status === 'configured'
          ? `configured${field.setAt === undefined ? '' : ` (${field.setAt.slice(0, 10)})`}`
          : field.status === 'missing'
            ? `missing: required${gate}`
            : 'not set';
  return (
    <Chip tone={field.status === 'missing' ? 'err' : field.status === 'configured' ? 'ok' : 'neutral'} data-status={field.status ?? 'restricted'}>
      {text}
    </Chip>
  );
}

function SecretField({ module, field, editable, available, onSaved }: { module: string; field: ModuleFieldView; editable: boolean; available: boolean; onSaved: () => void }): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = field.source === 'server';
  const save = async (next: string | undefined): Promise<void> => {
    setBusy(true);
    const out = await saveModuleSecret(module, field.key, next);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setValue('');
    toast.success(next === undefined ? `${field.label} cleared.` : `${field.label} saved. It is kept encrypted and never shown again.`);
    onSaved();
  };
  const placeholder = field.set === true ? 'Enter a new value to replace it' : undefined;
  return (
    <div data-testid={`module-secret-${module}-${field.key}`}>
      {editable && !locked && available ? (
        <Field label={field.label} {...(field.status === undefined ? {} : { meta: <Status field={field} /> })} {...(field.help === '' ? {} : { hint: field.help })}>
          <div className="flex gap-2">
            {field.multiline === true ? (
              <Textarea mono value={value} {...(placeholder === undefined ? {} : { placeholder })} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
            ) : (
              <Input type="password" value={value} {...(placeholder === undefined ? {} : { placeholder })} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
            )}
            <Button disabled={busy || value.trim() === ''} onClick={() => void save(value)}>
              {field.set === true ? 'Replace' : 'Set'}
            </Button>
            {field.set === true ? (
              <Button disabled={busy} onClick={() => void save(undefined)}>
                Clear
              </Button>
            ) : null}
          </div>
        </Field>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs font-medium text-dim">
            {field.label} {field.status === undefined ? null : <Status field={field} />}
          </div>
          {field.help === '' ? null : <p className="m-0 text-xs text-faint">{field.help}</p>}
        </div>
      )}
    </div>
  );
}

function ValueField({ field, value, disabled, set }: { field: ModuleFieldView; value: string | boolean | string[]; disabled: boolean; set: (v: string | boolean | string[]) => void }): JSX.Element {
  const locked = field.source === 'server';
  const shown = locked ? (field.value ?? '') : value;
  const meta = field.status === 'server' || field.status === 'missing' ? <Status field={field} /> : undefined;
  const hint = field.help === '' ? {} : { hint: field.help };
  if (field.kind === 'list' && field.options !== undefined) {
    const list = Array.isArray(shown) ? shown : [];
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-xs font-medium text-dim">
          {field.label} {meta}
        </div>
        <div className="flex flex-wrap gap-3" role="group" aria-label={field.label}>
          {field.options.map((option) => (
            <Checkbox key={option} label={option} disabled={disabled || locked} checked={list.includes(option)} onCheckedChange={(on) => set(on ? [...list, option] : list.filter((v) => v !== option))} />
          ))}
        </div>
        {field.help === '' ? null : <p className="m-0 text-xs text-faint">{field.help}</p>}
      </div>
    );
  }
  return (
    <Field label={field.label} {...(meta === undefined ? {} : { meta })} {...hint}>
      {field.kind === 'bool' ? (
        <Select
          className="w-fit"
          value={shown === true ? 'on' : shown === false ? 'off' : 'unset'}
          disabled={disabled || locked}
          onValueChange={(v) => set(v === 'on' ? true : v === 'off' ? false : '')}
          options={[{ value: 'unset', label: 'Not set' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        />
      ) : (
        <Input disabled={disabled || locked} value={Array.isArray(shown) ? shown.join(', ') : String(shown)} onChange={(e) => set(e.target.value)} />
      )}
    </Field>
  );
}

function valuesOf(section: ModuleSettingsView, draft: Draft): Record<string, RuntimeValue> {
  const out: Record<string, RuntimeValue> = {};
  for (const field of section.fields) {
    if (field.secret === true || field.source === 'server') continue;
    const raw = draft[field.key];
    if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    out[field.key] = field.kind === 'list' && typeof raw === 'string' ? raw.split(/[\s,]+/).filter((v) => v !== '') : raw;
  }
  return out;
}

function ModuleSection({ section, available, refetch }: { section: ModuleSettingsView; available: boolean; refetch: () => void }): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftOf(section));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(draftOf(section)), [section]);
  const plain = section.fields.filter((f) => f.secret !== true);
  const save = async (): Promise<void> => {
    setBusy(true);
    const out = await saveModuleSettings(section.module, valuesOf(section, draft), section.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    toast.success(`${section.title} settings saved. They apply now.`);
    refetch();
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid={`module-settings-${section.module}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="m-0 flex items-center gap-2 text-sm font-semibold">
        {section.title} <span className="font-normal text-faint">{section.module}</span>
        <HelpTip label={`About ${section.title} settings`}>{ABOUT}</HelpTip>
      </h2>
      {section.restricted === true ? (
        <Callout>Shown to owners: only an owner sees and changes a module&rsquo;s settings.</Callout>
      ) : (
        <>
          {section.fields.map((field) =>
            field.secret === true ? (
              <SecretField key={field.key} module={section.module} field={field} editable={section.editable} available={available} onSaved={refetch} />
            ) : (
              <ValueField key={field.key} field={field} value={draft[field.key] ?? ''} disabled={!section.editable} set={(v) => setDraft({ ...draft, [field.key]: v })} />
            ),
          )}
          {!section.editable ? (
            <Callout>An owner changes these settings, in a signed-in session.</Callout>
          ) : plain.some((f) => f.source !== 'server') ? (
            <div>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Saving…' : `Save ${section.title} settings`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </form>
  );
}

export function ModuleSettings(): JSX.Element {
  const client = useQueryClient();
  const query = useQuery(runtimeSettingsQuery);
  const refetch = (): void => void client.invalidateQueries({ queryKey: runtimeSettingsKey });
  if (query.isError) return <Callout tone="err">{query.error instanceof Error ? query.error.message : 'The settings could not be read.'}</Callout>;
  if (query.data === undefined) return <div className="mt-6 text-faint">Loading…</div>;
  const sections = query.data.modules ?? [];
  return (
    <div className="flex max-w-xl flex-col gap-8" data-testid="module-settings">
      {query.data.secrets.available ? null : <Callout tone="warn">{query.data.secrets.note}</Callout>}
      {sections.length === 0 ? <div className="text-faint">No installed module declares settings.</div> : null}
      {sections.map((section) => (
        <ModuleSection key={section.module} section={section} available={query.data.secrets.available} refetch={refetch} />
      ))}
    </div>
  );
}
