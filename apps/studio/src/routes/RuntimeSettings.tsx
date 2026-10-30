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
import { IconCopy } from '@tabler/icons-react';
import { Button, HelpTip, Input, Select, Textarea } from '@wirehub/editor-react';
import { localDate } from '../when.ts';

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
      Set by deployment
    </span>
  );
}

/** A setting's label column: the name (shortened inside its sub-group), the server badge and the `(?)` with its help. */
function RowLabel({ field, prefix, after }: { field: RuntimeFieldView; prefix?: string; after?: JSX.Element | null }): JSX.Element {
  const shown = shortLabel(field.label, prefix);
  return (
    <span className="settings-row-label">
      <span>{shown}</span>
      {field.help === '' ? null : <HelpTip label={`About ${field.label}`}>{field.help}</HelpTip>}
      {field.source === 'server' ? <ServerBadge field={field} /> : null}
      {after}
    </span>
  );
}

function SecretField({ field, group, available, onSaved, prefix }: { field: RuntimeFieldView; group: RuntimeGroupView; available: boolean; onSaved: () => void; prefix?: string }): JSX.Element {
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
  const state = locked ? null : field.unreadable === true ? 'Cannot be decrypted: enter it again.' : field.set === true ? `Set${field.setAt === undefined ? '' : ` (${localDate(field.setAt)})`}.` : 'Not set.';
  return (
    <div className="settings-row" data-testid={`secret-${field.key}`}>
      <RowLabel field={field} {...(prefix === undefined ? {} : { prefix })} after={state === null ? null : <span className={`text-2xs ${field.unreadable === true ? 'text-err' : 'text-faint'}`}>{state}</span>} />
      {editable ? (
        <div className="flex min-w-0 gap-2">
          {field.kind === 'multiline' ? (
            <Textarea aria-label={field.label} value={value} placeholder={field.set === true ? 'New value replaces it' : field.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} mono className="min-h-16 flex-1" />
          ) : (
            <Input type="password" aria-label={field.label} value={value} placeholder={field.set === true ? 'New value replaces it' : field.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" className="min-w-0 flex-1" />
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
      ) : (
        <span />
      )}
    </div>
  );
}

function Field({ field, value, disabled, set, prefix }: { field: RuntimeFieldView; value: string | boolean; disabled: boolean; set: (v: string | boolean) => void; prefix?: string }): JSX.Element {
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
        className={field.kind === 'int' ? 'w-32' : undefined}
        onChange={(e) => set(e.target.value)}
      />
    );
  return (
    <div className="settings-row">
      <RowLabel field={field} {...(prefix === undefined ? {} : { prefix })} />
      {control}
    </div>
  );
}

/**
 * The fields of a group, in sub-groups by their key's area (`github.*`, `mirror.*`): a sign-in
 * provider or an integration reads as one collapsible row, its fields named without the
 * repeated prefix. A provider's callback URL is shown once, as a copyable value.
 */
const AREAS: Readonly<Record<string, { title: string; prefix?: string; collapsed?: boolean; callback?: (values: Record<string, string | boolean>) => string }>> = {
  auth: { title: 'Accounts' },
  github: { title: 'GitHub', prefix: 'GitHub', collapsed: true, callback: () => 'github' },
  google: { title: 'Google', prefix: 'Google', collapsed: true, callback: () => 'google' },
  oidc: { title: 'Single sign-on (OIDC)', prefix: 'OIDC', collapsed: true, callback: (v) => (typeof v['oidc.providerId'] === 'string' && v['oidc.providerId'] !== '' ? v['oidc.providerId'] : 'oidc') },
  smtp: { title: 'Magic link (email)', prefix: 'SMTP', collapsed: true },
  limits: { title: 'API token limits', prefix: 'API token', collapsed: true },
  store: { title: 'Catalog store', prefix: 'Store:' },
  pdf: { title: 'PDF engine', prefix: 'PDF engine' },
  mirror: { title: 'Git mirror', prefix: 'Git mirror', collapsed: true },
};

function shortLabel(label: string, prefix: string | undefined): string {
  if (prefix === undefined || !label.toLowerCase().startsWith(prefix.toLowerCase())) return label;
  const rest = label.slice(prefix.length).trim();
  return rest === '' ? label : rest[0]!.toUpperCase() + rest.slice(1);
}

function Callback({ id }: { id: string }): JSX.Element {
  const url = `${window.location.origin}/api/auth/callback/${id}`;
  return (
    <div className="settings-row">
      <span className="settings-row-label">
        <span>Callback URL</span>
        <HelpTip label="About the callback URL">Register this address with the provider.</HelpTip>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 break-all text-xs" data-testid={`callback-${id}`}>{url}</code>
        <Button type="button" size="xs" variant="ghost" icon={<IconCopy size={12} aria-hidden />} onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Copied.'); }}>
          Copy
        </Button>
      </span>
    </div>
  );
}

function areaState(fields: readonly RuntimeFieldView[], draft: Record<string, string | boolean>): string | undefined {
  const enabled = fields.find((f) => f.kind === 'bool' && f.key.endsWith('.enabled'));
  if (enabled !== undefined) {
    const v = enabled.source === 'server' ? enabled.value : draft[enabled.key];
    return v === true ? 'On' : 'Off';
  }
  const configured = fields.some((f) => (f.secret === true ? f.set === true || f.source === 'server' : f.source === 'server' || (draft[f.key] !== undefined && draft[f.key] !== '')));
  return configured ? 'Configured' : 'Not set up';
}

function Group({ group, draft, setDraft, secretsAvailable, refetch, heading = true }: { group: RuntimeGroupView; draft: Record<string, string | boolean>; setDraft: (d: Record<string, string | boolean>) => void; secretsAvailable: boolean; refetch: () => void; heading?: boolean }): JSX.Element {
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
  const areas: { id: string; fields: RuntimeFieldView[] }[] = [];
  for (const field of group.fields) {
    const id = field.key.split('.')[0] ?? field.key;
    const last = areas[areas.length - 1];
    if (last?.id === id) last.fields.push(field);
    else areas.push({ id, fields: [field] });
  }
  const sub = areas.length > 1;
  const row = (field: RuntimeFieldView, prefix: string | undefined): JSX.Element =>
    field.secret === true ? (
      <SecretField key={field.key} field={field} group={group} available={secretsAvailable} onSaved={refetch} {...(prefix === undefined ? {} : { prefix })} />
    ) : (
      <Field key={field.key} field={field} value={draft[field.key] ?? ''} disabled={!group.editable} set={(v) => setDraft({ ...draft, [field.key]: v })} {...(prefix === undefined ? {} : { prefix })} />
    );
  return (
    <form
      className="flex flex-col gap-1"
      data-testid={`runtime-${group.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {heading ? (
        <h3 className="settings-group-title">
          {group.title}
          <HelpTip label={`About ${group.title}`}>{group.intro} {group.applies}</HelpTip>
        </h3>
      ) : null}
      {group.restricted === true ? (
        <div className="text-dim">Only an owner sees and changes these settings.</div>
      ) : (
        <>
          {areas.map((area) => {
            const meta = sub ? AREAS[area.id] : undefined;
            const rows = (
              <>
                {area.fields.map((f) => row(f, meta?.prefix))}
                {meta?.callback === undefined ? null : <Callback id={meta.callback(draft)} />}
              </>
            );
            if (meta === undefined) return <div key={area.id} className="flex flex-col">{rows}</div>;
            if (meta.collapsed !== true) {
              return (
                <div key={area.id} className="flex flex-col" data-area={area.id}>
                  <div className="settings-subgroup-title">{meta.title}</div>
                  {rows}
                </div>
              );
            }
            return (
              <details key={area.id} className="settings-subgroup" data-area={area.id}>
                <summary>
                  <span>{meta.title}</span>
                  <span className="text-2xs font-normal text-faint">{areaState(area.fields, draft)}</span>
                </summary>
                <div className="flex flex-col pb-2">{rows}</div>
              </details>
            );
          })}
          {!group.editable ? (
            <div className="text-dim">{group.role === 'owner' ? 'An owner changes these settings.' : 'Your role can view these settings but not change them.'}</div>
          ) : plain.some((f) => f.source !== 'server') ? (
            <div className="pt-2">
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
    <div className="settings-row" data-testid="adopt-server-values">
      <span className="settings-row-label">
        <span>Server values</span>
        <HelpTip label="About adopting the server's values">
          Copies these into Settings (secrets into the encrypted store), so the variables can then be deleted from the deployment and nothing changes. While a variable is set it still wins.
        </HelpTip>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-dim">{items.map((i) => i.label).join(', ')}</span>
        <Button type="button" size="xs" disabled={busy} onClick={() => void adopt()}>
          {busy ? 'Adopting…' : 'Adopt the server’s values'}
        </Button>
      </span>
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
  const state =
    keyRing.stale > 0 ? `${keyRing.stale} secret${keyRing.stale === 1 ? '' : 's'} under a previous key` : keyRing.previousKeys > 0 ? 'All under the current key; the previous key can go' : 'All under the current key';
  return (
    <div className="settings-row" data-testid="rotate-key">
      <span className="settings-row-label">
        <span>Settings key</span>
        <HelpTip label="About settings key rotation">
          To rotate, give the server a new WIREHUB_SETTINGS_KEY and the old one as WIREHUB_SETTINGS_KEY_PREVIOUS, then re-encrypt here.
        </HelpTip>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-dim">
          {state}
          {keyRing.unreadable > 0 ? `; ${keyRing.unreadable} cannot be read and must be entered again` : ''}.
        </span>
        <Button type="button" size="xs" disabled={busy || (keyRing.stale === 0 && keyRing.previousKeys === 0)} onClick={() => void rotate()}>
          {busy ? 'Re-encrypting…' : 'Rotate key'}
        </Button>
      </span>
    </div>
  );
}

/** Which runtime groups a Settings section shows: sign-in; alerts (beside the event webhooks); the rest under System. */
const inSection = (section: RuntimeSection | undefined, id: string): boolean =>
  section === undefined ? true : section === 'authentication' ? id === 'sign-in' : section === 'alerts' ? id === 'notifications' : id !== 'sign-in' && id !== 'notifications';

export type RuntimeSection = 'authentication' | 'runtime' | 'alerts';

export function RuntimeSettings({ section }: { section?: RuntimeSection } = {}): JSX.Element {
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

  if (query.isError) return <div className="text-faint">{query.error instanceof Error ? query.error.message : 'The settings could not be read.'}</div>;
  if (query.data === undefined) return <div className="text-faint">Loading…</div>;
  const data = query.data;
  const groups = data.groups.filter((group) => inSection(section, group.id));
  const adoptable = data.adoptable?.filter((item) => groups.some((group) => group.fields.some((field) => field.key === item.key)));
  const rotation = section !== 'authentication' && section !== 'alerts' ? data.secrets.keyRing : undefined;
  const server = rotation !== undefined || (adoptable !== undefined && adoptable.length > 0);
  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid={`runtime-settings${section === undefined ? '' : `-${section}`}`}>
      {data.problems.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 text-err">
          {data.problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      ) : null}
      {data.secrets.available ? null : (
        <div className="text-xs text-warn" title={data.secrets.note}>
          Secrets cannot be saved here: the server has no settings key.
        </div>
      )}
      {groups.map((group) => (
        <Group key={group.id} heading={section !== 'authentication'} group={group} draft={draft[group.id] ?? {}} setDraft={(d) => setDraft({ ...draft, [group.id]: d })} secretsAvailable={data.secrets.available} refetch={refetch} />
      ))}
      {!server ? null : (
        <details className="settings-subgroup" data-testid="runtime-server">
          <summary>
            <span>Server</span>
          </summary>
          <div className="flex flex-col pb-2">
            {rotation === undefined ? null : <RotateKey keyRing={rotation} onDone={refetch} />}
            {adoptable !== undefined && adoptable.length > 0 ? <AdoptServerValues items={adoptable} onDone={refetch} /> : null}
          </div>
        </details>
      )}
    </div>
  );
}
