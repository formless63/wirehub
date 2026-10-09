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

import { adoptServerValues, rotateSettingsKey, engineeringKey, runtimeSettingsKey, runtimeSettingsQuery, saveRuntimeGroup, saveRuntimeSecret, type RuntimeFieldView, type RuntimeGroupView, type RuntimeValue } from '../settings.browser.ts';
import { Button, HelpTip, Input, Select, Textarea } from '@wirehub/editor-react';

const DEFAULT = '__default__';

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
    <span className="rounded border border-line px-1 text-2xs text-faint" title={`The server's ${field.env} sets this; it wins over Settings.`}>
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
            <Textarea aria-label={field.label} value={value} placeholder={field.set === true ? 'Enter a new value to replace it' : field.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} mono className="min-h-16 flex-1" />
          ) : (
            <Input type="password" aria-label={field.label} value={value} placeholder={field.set === true ? 'Enter a new value to replace it' : field.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" className="flex-1" />
          )}
          <Button type="button" disabled={busy || value.trim() === ''} onClick={() => void save(value)}>
            Set
          </Button>
          {field.set === true ? (
            <Button type="button" disabled={busy} onClick={() => void save(undefined)}>
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}
      <span className="text-dim">{field.help}</span>
    </div>
  );
}

function Field({ field, value, disabled, set }: { field: RuntimeFieldView; value: string | boolean; disabled: boolean; set: (v: string | boolean) => void }): JSX.Element {
  const locked = field.source === 'server';
  const shown = locked ? textOf(field, field.value) : value;
  const placeholder = field.placeholder ?? (field.defaultText === undefined ? undefined : `default: ${field.defaultText}`);
  const control =
    field.kind === 'bool' ? (
      <Select
        className="w-fit max-w-full"
        aria-label={field.label}
        disabled={disabled || locked}
        value={shown === true ? 'on' : shown === false ? 'off' : DEFAULT}
        options={[{ value: DEFAULT, label: `Default${field.defaultText === undefined ? '' : ` (${field.defaultText})`}` }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        onValueChange={(v) => set(v === 'on' ? true : v === 'off' ? false : '')}
      />
    ) : field.kind === 'enum' ? (
      <Select
        className="w-48"
        aria-label={field.label}
        disabled={disabled || locked}
        value={String(shown) === '' ? DEFAULT : String(shown)}
        options={[{ value: DEFAULT, label: `Default${field.defaultText === undefined ? '' : ` (${field.defaultText})`}` }, ...(field.options ?? []).map((o) => ({ value: o, label: o }))]}
        onValueChange={(v) => set(v === DEFAULT ? '' : v)}
      />
    ) : field.kind === 'multiline' ? (
      <Textarea aria-label={field.label} disabled={disabled || locked} value={String(shown)} placeholder={placeholder} onChange={(e) => set(e.target.value)} spellCheck={false} mono className="min-h-16" />
    ) : (
      <Input
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
      <span className="text-dim">{field.help}</span>
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
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        {group.title}
        <HelpTip label={`About ${group.title}`}>{group.intro} {group.applies}</HelpTip>
      </h2>
      {group.restricted === true ? (
        <div className="text-dim">Shown to owners: only an owner sees and changes these settings.</div>
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
            <div className="text-dim">{group.role === 'owner' ? 'An owner changes these settings.' : 'Your role can view these settings but not change them.'}</div>
          ) : plain.some((f) => f.source !== 'server') ? (
            <div>
              <Button type="submit" disabled={busy} variant="primary">
                {busy ? 'Saving…' : `Save ${group.title.toLowerCase()}`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </form>
  );
}

function AdoptServerValues({ items, onDone }: { items: { key: string; env: string; label: string }[]; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const adopt = async (): Promise<void> => {
    setBusy(true);
    const out = await adoptServerValues();
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    const skipped = out.value.skipped.map((s) => `${s.label} ${s.why}`);
    toast.success(`Adopted ${out.value.adopted.length} setting${out.value.adopted.length === 1 ? '' : 's'} from the server.`, skipped.length === 0 ? undefined : { description: `Not copied: ${skipped.join(' ')}` });
    onDone();
  };
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3" data-testid="adopt-server-values">
      <span className="font-medium">The server still sets {items.length} of these</span>
      <span className="text-faint">{items.map((i) => i.label).join(', ')}.</span>
      <span className="text-dim">
        Adopting copies them into Settings (secrets into the encrypted store), so you can then delete the variables from your deployment and nothing changes. While a variable is set it still wins.
      </span>
      <div>
        <Button type="button" disabled={busy} onClick={() => void adopt()}>
          {busy ? 'Adopting…' : 'Adopt the server’s values'}
        </Button>
      </div>
    </div>
  );
}

function RotateKey({ keyRing, onDone }: { keyRing: { previousKeys: number; stale: number; unreadable: number }; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const rotate = async (): Promise<void> => {
    setBusy(true);
    const out = await rotateSettingsKey();
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    const { rotated, unreadable } = out.value;
    toast.success(`Re-encrypted ${rotated.length} secret${rotated.length === 1 ? '' : 's'} under the current key.`, unreadable.length === 0 ? undefined : { description: `Could not be read, enter again: ${unreadable.join(', ')}.` });
    onDone();
  };
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3" data-testid="rotate-key">
      <span className="font-medium">Settings key rotation</span>
      <span className="text-dim">
        {keyRing.stale > 0
          ? `${keyRing.stale} stored secret${keyRing.stale === 1 ? ' is' : 's are'} still under a previous key.`
          : keyRing.previousKeys > 0
            ? 'Every stored secret is under the current key; the previous key can now be removed from the server.'
            : 'Every stored secret is under the current key.'}{' '}
        To rotate, give the server a new <code>WIREHUB_SETTINGS_KEY</code> and the old one as <code>WIREHUB_SETTINGS_KEY_PREVIOUS</code> then re-encrypt here.
        {keyRing.unreadable > 0 ? ` ${keyRing.unreadable} secret${keyRing.unreadable === 1 ? '' : 's'} cannot be read with any key and must be entered again.` : ''}
      </span>
      <div>
        <Button type="button" disabled={busy || (keyRing.stale === 0 && keyRing.previousKeys === 0)} onClick={() => void rotate()}>
          {busy ? 'Re-encrypting…' : 'Rotate key'}
        </Button>
      </div>
    </div>
  );
}

export function RuntimeSettings({ section }: { section?: 'authentication' | 'runtime' } = {}): JSX.Element {
  const client = useQueryClient();
  const query = useQuery(runtimeSettingsQuery);
  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => {
    if (query.data !== undefined) setDraft(draftOf(query.data.groups));
  }, [query.data]);
  const refetch = (): void => {
    void client.invalidateQueries({ queryKey: runtimeSettingsKey });
    void client.invalidateQueries({ queryKey: engineeringKey });
  };

  if (query.isError) return <div className="mt-8 border-t border-line pt-4 text-faint">{query.error instanceof Error ? query.error.message : 'The settings could not be read.'}</div>;
  if (query.data === undefined) return <div className="mt-6 text-faint">Loading…</div>;
  const data = query.data;
  const groups = data.groups.filter((group) => section === undefined || (section === 'authentication' ? group.id === 'sign-in' : group.id !== 'sign-in'));
  const adoptable = data.adoptable?.filter((item) => groups.some((group) => group.fields.some((field) => field.key === item.key)));
  return (
    <div className="flex max-w-xl flex-col gap-8" data-testid={`runtime-settings${section === undefined ? '' : `-${section}`}`}>
      {data.problems.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 rounded border border-line p-2">
          {data.problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      ) : null}
      {data.secrets.available ? null : <div className="text-dim">{data.secrets.note}</div>}
      {section !== 'authentication' && data.secrets.keyRing !== undefined ? <RotateKey keyRing={data.secrets.keyRing} onDone={refetch} /> : null}
      {adoptable !== undefined && adoptable.length > 0 ? <AdoptServerValues items={adoptable} onDone={refetch} /> : null}
      {groups.map((group) => (
        <Group key={group.id} group={group} draft={draft[group.id] ?? {}} setDraft={(d) => setDraft({ ...draft, [group.id]: d })} secretsAvailable={data.secrets.available} refetch={refetch} />
      ))}
    </div>
  );
}
