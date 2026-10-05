/**
 * The runtime half of `/settings` (`server/runtime-settings-api.ts`): notifications,
 * sign-in, integrations, jobs and limits — what used to need a redeploy, changed here
 * and applied at once. A value the server's environment sets is shown read-only, "set
 * by the server". Secrets are write-only: set or cleared one by one, never shown.
 * Owner-only groups are shown to owners; editors change Jobs & limits.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { runtimeSettingsKey, runtimeSettingsQuery, saveRuntimeGroup, saveRuntimeSecret, type RuntimeFieldView, type RuntimeGroupView, type RuntimeValue } from '../settings.browser.ts';

type Draft = Record<string, Record<string, string | boolean>>;

const textOf = (field: RuntimeFieldView, value: RuntimeValue | undefined): string | boolean => {
  if (field.kind === 'bool') return value === true ? true : value === false ? false : '';
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
};

const draftOf = (groups: RuntimeGroupView[]): Draft =>
  Object.fromEntries(groups.map((g) => [g.id, Object.fromEntries(g.fields.filter((f) => f.secret !== true).map((f) => [f.key, textOf(f, f.source === 'server' ? f.saved : f.value)]))]));

/** The values the PUT takes: empty fields left out; numbers, lists and flags in their own types. */
function valuesOf(group: RuntimeGroupView, draft: Record<string, string | boolean>): Record<string, RuntimeValue> {
  const out: Record<string, RuntimeValue> = {};
  for (const field of group.fields) {
    if (field.secret === true || field.source === 'server') continue;
    const raw = draft[field.key];
    if (raw === undefined || raw === '') continue;
    if (field.kind === 'bool') out[field.key] = raw === true;
    else if (field.kind === 'int') out[field.key] = Number(raw);
    else if (field.kind === 'list') out[field.key] = String(raw).split(/[\s,]+/).filter((v) => v !== '');
    else out[field.key] = String(raw);
  }
  return out;
}

function ServerBadge({ field }: { field: RuntimeFieldView }): JSX.Element {
  return (
    <span className="rounded border border-line px-1 text-[11px] text-faint" title={`The server's ${field.env} sets this; it wins over Settings.`}>
      set by the server ({field.env})
    </span>
  );
}

function SecretField({ field, group, available, onSaved }: { field: RuntimeFieldView; group: RuntimeGroupView; available: boolean; onSaved: () => void }): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = field.source === 'server';
  const editable = group.editable && !locked && available;
  const save = async (next: string | undefined): Promise<void> => {
    setBusy(true);
    const out = await saveRuntimeSecret(field.key, next);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setValue('');
    toast.success(next === undefined ? `${field.label} cleared.` : `${field.label} saved. It is kept encrypted and never shown again.`);
    onSaved();
  };
  const state = locked ? null : field.unreadable === true ? 'Saved, but this server cannot decrypt it: enter it again.' : field.set === true ? `Set${field.setAt === undefined ? '' : ` (${field.setAt.slice(0, 10)})`}.` : 'Not set.';
  return (
    <div className="flex flex-col gap-0.5" data-testid={`secret-${field.key}`}>
      <span className="flex flex-wrap items-center gap-2 font-medium">
        {field.label} {locked ? <ServerBadge field={field} /> : <span className="font-normal text-faint">{state}</span>}
      </span>
      {editable ? (
        <div className="flex gap-2">
          {field.kind === 'multiline' ? (
            <textarea className="min-h-16 flex-1 rounded border border-line bg-panel px-2 py-1 font-mono text-[11px]" aria-label={field.label} value={value} placeholder={field.set === true ? 'Enter a new value to replace it' : field.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
          ) : (
            <input className="flex-1 rounded border border-line bg-panel px-2 py-1" type="password" aria-label={field.label} value={value} placeholder={field.set === true ? 'Enter a new value to replace it' : field.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          )}
          <button type="button" className="rounded border border-line px-2 py-1 disabled:opacity-50" disabled={busy || value.trim() === ''} onClick={() => void save(value)}>
            Set
          </button>
          {field.set === true ? (
            <button type="button" className="rounded border border-line px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => void save(undefined)}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
      <span className="text-faint">{field.help}</span>
    </div>
  );
}

function Field({ field, value, disabled, set }: { field: RuntimeFieldView; value: string | boolean; disabled: boolean; set: (v: string | boolean) => void }): JSX.Element {
  const locked = field.source === 'server';
  const shown = locked ? textOf(field, field.value) : value;
  const placeholder = field.placeholder ?? (field.defaultText === undefined ? undefined : `default: ${field.defaultText}`);
  const control =
    field.kind === 'bool' ? (
      <select className="w-48 rounded border border-line bg-panel px-2 py-1" aria-label={field.label} disabled={disabled || locked} value={shown === true ? 'on' : shown === false ? 'off' : ''} onChange={(e) => set(e.target.value === 'on' ? true : e.target.value === 'off' ? false : '')}>
        <option value="">{`Default${field.defaultText === undefined ? '' : ` (${field.defaultText})`}`}</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    ) : field.kind === 'enum' ? (
      <select className="w-48 rounded border border-line bg-panel px-2 py-1" aria-label={field.label} disabled={disabled || locked} value={String(shown)} onChange={(e) => set(e.target.value)}>
        <option value="">{`Default${field.defaultText === undefined ? '' : ` (${field.defaultText})`}`}</option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    ) : field.kind === 'multiline' ? (
      <textarea className="min-h-16 rounded border border-line bg-panel px-2 py-1 font-mono text-[11px]" aria-label={field.label} disabled={disabled || locked} value={String(shown)} placeholder={placeholder} onChange={(e) => set(e.target.value)} spellCheck={false} />
    ) : (
      <input
        className="rounded border border-line bg-panel px-2 py-1"
        aria-label={field.label}
        disabled={disabled || locked}
        value={String(shown)}
        placeholder={placeholder}
        inputMode={field.kind === 'int' ? 'numeric' : undefined}
        onChange={(e) => set(e.target.value)}
      />
    );
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2 font-medium">
        {field.label} {locked ? <ServerBadge field={field} /> : null}
      </span>
      {control}
      <span className="text-faint">{field.help}</span>
    </label>
  );
}

function Group({ group, draft, setDraft, secretsAvailable, refetch }: { group: RuntimeGroupView; draft: Record<string, string | boolean>; setDraft: (d: Record<string, string | boolean>) => void; secretsAvailable: boolean; refetch: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const plain = group.fields.filter((f) => f.secret !== true);
  const save = async (): Promise<void> => {
    setBusy(true);
    const out = await saveRuntimeGroup(group.id, valuesOf(group, draft), group.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    toast.success(`${group.title} saved. It applies now.`);
    refetch();
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid={`runtime-${group.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-[13px] font-semibold">{group.title}</h2>
      <p className="text-faint">
        {group.intro} {group.applies}
      </p>
      {group.restricted === true ? (
        <div className="text-faint">Shown to owners: only an owner sees and changes these settings.</div>
      ) : (
        <>
          {group.fields.map((field) =>
            field.secret === true ? (
              <SecretField key={field.key} field={field} group={group} available={secretsAvailable} onSaved={refetch} />
            ) : (
              <Field key={field.key} field={field} value={draft[field.key] ?? ''} disabled={!group.editable} set={(v) => setDraft({ ...draft, [field.key]: v })} />
            ),
          )}
          {!group.editable ? (
            <div className="text-faint">{group.role === 'owner' ? 'An owner changes these settings.' : 'Your role can view these settings but not change them.'}</div>
          ) : plain.some((f) => f.source !== 'server') ? (
            <div>
              <button type="submit" disabled={busy} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
                {busy ? 'Saving…' : `Save ${group.title.toLowerCase()}`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </form>
  );
}

export function RuntimeSettings(): JSX.Element {
  const client = useQueryClient();
  const query = useQuery(runtimeSettingsQuery);
  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => {
    if (query.data !== undefined) setDraft(draftOf(query.data.groups));
  }, [query.data]);
  const refetch = (): void => void client.invalidateQueries({ queryKey: runtimeSettingsKey });

  if (query.isError) return <div className="mt-8 border-t border-line pt-4 text-faint">{query.error instanceof Error ? query.error.message : 'The settings could not be read.'}</div>;
  if (query.data === undefined) return <div className="mt-6 text-faint">Loading…</div>;
  const data = query.data;
  return (
    <div className="mt-8 flex max-w-xl flex-col gap-8 border-t border-line pt-4" data-testid="runtime-settings">
      <p className="text-faint">
        The settings below used to be environment variables. They apply at once, with no restart; a value the server&rsquo;s environment sets wins and is shown read-only. Where the
        database, the files, the ports and the install&rsquo;s secrets are stays on the server (docs/self-hosting.md, &ldquo;What lives where&rdquo;).
      </p>
      {data.problems.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 rounded border border-line p-2">
          {data.problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      ) : null}
      {data.secrets.available ? null : <div className="text-faint">{data.secrets.note}</div>}
      {data.groups.map((group) => (
        <Group key={group.id} group={group} draft={draft[group.id] ?? {}} setDraft={(d) => setDraft({ ...draft, [group.id]: d })} secretsAvailable={data.secrets.available} refetch={refetch} />
      ))}
    </div>
  );
}
