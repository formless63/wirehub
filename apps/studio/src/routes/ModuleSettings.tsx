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

import { runtimeSettingsKey, runtimeSettingsQuery, saveModuleSecret, saveModuleSettings, type ModuleFieldView, type ModuleSettingsView, type RuntimeValue } from '../settings.browser.ts';

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
    <span className={`rounded border border-line px-1 text-[11px] ${field.status === 'missing' ? 'text-err' : 'text-faint'}`} data-status={field.status ?? 'restricted'}>
      {text}
    </span>
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
  return (
    <div className="flex flex-col gap-0.5" data-testid={`module-secret-${module}-${field.key}`}>
      <span className="flex flex-wrap items-center gap-2 font-medium">
        {field.label} {field.status === undefined ? null : <Status field={field} />}
      </span>
      {editable && !locked && available ? (
        <div className="flex gap-2">
          {field.multiline === true ? (
            <textarea className="min-h-16 flex-1 rounded border border-line bg-panel px-2 py-1 font-mono text-[11px]" aria-label={field.label} value={value} placeholder={field.set === true ? 'Enter a new value to replace it' : undefined} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
          ) : (
            <input className="flex-1 rounded border border-line bg-panel px-2 py-1" type="password" aria-label={field.label} value={value} placeholder={field.set === true ? 'Enter a new value to replace it' : undefined} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          )}
          <button type="button" className="rounded border border-line px-2 py-1 disabled:opacity-50" disabled={busy || value.trim() === ''} onClick={() => void save(value)}>
            {field.set === true ? 'Replace' : 'Set'}
          </button>
          {field.set === true ? (
            <button type="button" className="rounded border border-line px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => void save(undefined)}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
      {field.help === '' ? null : <span className="text-dim">{field.help}</span>}
    </div>
  );
}

function ValueField({ field, value, disabled, set }: { field: ModuleFieldView; value: string | boolean | string[]; disabled: boolean; set: (v: string | boolean | string[]) => void }): JSX.Element {
  const locked = field.source === 'server';
  const shown = locked ? (field.value ?? '') : value;
  const control =
    field.kind === 'list' && field.options !== undefined ? (
      <span className="flex flex-wrap gap-3" role="group" aria-label={field.label}>
        {field.options.map((option) => {
          const list = Array.isArray(shown) ? shown : [];
          return (
            <label key={option} className="flex items-center gap-1">
              <input type="checkbox" disabled={disabled || locked} checked={list.includes(option)} onChange={(e) => set(e.target.checked ? [...list, option] : list.filter((v) => v !== option))} />
              {option}
            </label>
          );
        })}
      </span>
    ) : field.kind === 'bool' ? (
      <select className="w-fit rounded border border-line bg-panel px-2 py-1" aria-label={field.label} disabled={disabled || locked} value={shown === true ? 'on' : shown === false ? 'off' : ''} onChange={(e) => set(e.target.value === 'on' ? true : e.target.value === 'off' ? false : '')}>
        <option value="">Not set</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    ) : (
      <input className="rounded border border-line bg-panel px-2 py-1" aria-label={field.label} disabled={disabled || locked} value={Array.isArray(shown) ? shown.join(', ') : String(shown)} onChange={(e) => set(e.target.value)} />
    );
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2 font-medium">
        {field.label} {field.status === 'server' || field.status === 'missing' ? <Status field={field} /> : null}
      </span>
      {control}
      {field.help === '' ? null : <span className="text-dim">{field.help}</span>}
    </div>
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
      <h2 className="text-[13px] font-semibold">
        {section.title} <span className="font-normal text-faint">{section.module}</span>
      </h2>
      {section.restricted === true ? (
        <div className="text-dim">Shown to owners: only an owner sees and changes a module&rsquo;s settings.</div>
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
            <div className="text-dim">An owner changes these settings, in a signed-in session.</div>
          ) : plain.some((f) => f.source !== 'server') ? (
            <div>
              <button type="submit" disabled={busy} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
                {busy ? 'Saving…' : `Save ${section.title} settings`}
              </button>
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
  if (query.isError) return <div className="mt-8 border-t border-line pt-4 text-faint">{query.error instanceof Error ? query.error.message : 'The settings could not be read.'}</div>;
  if (query.data === undefined) return <div className="mt-6 text-faint">Loading…</div>;
  const sections = query.data.modules ?? [];
  return (
    <div className="flex max-w-xl flex-col gap-8" data-testid="module-settings">
      <p className="text-dim">
        Credentials and options the installed modules ask for. Secrets are kept encrypted with the hub&rsquo;s settings key and never shown again; a change applies at once, with no
        restart. A value the server&rsquo;s environment sets wins and is shown locked (docs/self-hosting.md, &ldquo;What lives where&rdquo;).
      </p>
      {query.data.secrets.available ? null : <div className="text-dim">{query.data.secrets.note}</div>}
      {sections.length === 0 ? <div className="text-faint">No installed module declares settings.</div> : null}
      {sections.map((section) => (
        <ModuleSection key={section.module} section={section} available={query.data.secrets.available} refetch={refetch} />
      ))}
    </div>
  );
}
