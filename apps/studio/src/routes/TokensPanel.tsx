/**
 * Account → API tokens, in the app itself (it used to be the server's account page in an iframe):
 * create a token for a script or an agent (shown once), see yours, revoke one. Same API:
 * `GET/POST /api/account/tokens`, `DELETE /api/account/tokens/:id` (`server/auth/gate.ts`).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCopy } from '@tabler/icons-react';
import { Button, Callout, Checkbox, Chip, DataTable, Field, Input, NumberInput, SegmentedControl, Select, type DataColumn } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import { request } from '../persistence.browser.ts';
import { localDateTime } from '../when.ts';

interface TokenView {
  id: string;
  name: string;
  env: string;
  prefix: string;
  scopes: string[];
  /** the API sends `null` for "none" (no cap, never used, not revoked) */
  writeBudget: number | null;
  writesUsed: number;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const KEY = ['account', 'tokens'] as const;
const LIFETIMES = [
  { value: 'h1', label: '1 hour' }, { value: 'h8', label: '8 hours' }, { value: '1', label: '1 day' },
  { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' },
];
const SCOPES = [
  { id: 'catalog:write', label: 'Change the catalog', hint: 'catalog:write' },
  { id: 'imports', label: 'Write imported documents', hint: 'imports' },
  { id: 'drafts:write', label: 'Draft work (agents)', hint: 'drafts:write: creates and edits designs and library items; never deletes, releases or publishes' },
] as const;
const stamp = (iso: string | null | undefined): string => (iso === null || iso === undefined ? '' : localDateTime(iso));
const revoked = (t: TokenView): boolean => t.revokedAt !== null && t.revokedAt !== undefined;

const copy = (text: string): void => {
  void navigator.clipboard?.writeText(text);
  toast.success('Copied.');
};

/** The MCP client config for this hub, with the new token filled in: Claude Code's command, or the JSON server list most clients take. */
export function mcpConfig(kind: 'claude' | 'json', url: string, secret: string): string {
  return kind === 'claude'
    ? `claude mcp add --transport http wirehub ${url} \\\n  --header "Authorization: Bearer ${secret}"`
    : JSON.stringify({ mcpServers: { wirehub: { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
}

/** A token just created: its secret (shown once), the MCP endpoint, and a client config to copy. */
function CreatedToken({ secret }: { secret: string }): JSX.Element {
  const [kind, setKind] = useState<'claude' | 'json'>('claude');
  const url = `${window.location.origin}/api/mcp`;
  const config = mcpConfig(kind, url, secret);
  return (
    <Callout tone="ok" className="mx-4 mt-3" action={<Button size="xs" icon={<IconCopy size={12} aria-hidden />} onClick={() => copy(secret)}>Copy</Button>}>
      <span className="font-mono text-xs break-all" data-testid="token-secret">{secret}</span> <span className="text-dim">shown once</span>
      <span className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-dim">MCP</span>
        <code className="font-mono" data-testid="mcp-url">{url}</code>
        <SegmentedControl aria-label="Client" value={kind} onValueChange={(v) => setKind(v as 'claude' | 'json')} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'json', label: 'JSON' }]} />
        <Button size="xs" variant="ghost" icon={<IconCopy size={12} aria-hidden />} onClick={() => copy(config)} data-testid="mcp-config-copy">Copy config</Button>
      </span>
      <pre className="m-0 mt-1 overflow-x-auto rounded border border-line bg-bg p-2 font-mono text-2xs" data-testid="mcp-config">{config}</pre>
    </Callout>
  );
}

export function TokensPanel(): JSX.Element {
  const client = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: async () => { const out = await request<{ tokens: TokenView[] }>('/api/account/tokens'); if (!out.ok) throw new Error(out.message); return out.value.tokens; }, retry: false });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const [life, setLife] = useState('7');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();

  const create = async (): Promise<void> => {
    if (name.trim() === '') { setError('Name what the token is for.'); return; }
    setBusy(true); setError(undefined);
    const hours = life.startsWith('h') ? Number(life.slice(1)) : undefined;
    const out = await request<{ secret: string }>('/api/account/tokens', { method: 'POST', body: { name: name.trim(), scopes: ['read', ...scopes], days: hours === undefined ? Number(life) : 1, ...(hours === undefined ? {} : { hours }), ...(budget === null ? {} : { writeBudget: budget }) } });
    setBusy(false);
    if (!out.ok) { setError(out.message); return; }
    setSecret(out.value.secret);
    setName(''); setScopes([]); setBudget(null);
    void client.invalidateQueries({ queryKey: KEY });
  };
  const revoke = async (token: TokenView): Promise<void> => {
    const out = await request(`/api/account/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
    if (!out.ok) toast.error(out.message); else toast.success(`Revoked ${token.name}.`);
    void client.invalidateQueries({ queryKey: KEY });
  };

  const columns: DataColumn<TokenView>[] = [
    { id: 'name', header: 'Name', fixed: true, width: 160, cell: (t) => <span className={revoked(t) ? 'text-faint line-through' : ''}>{t.name}</span> },
    { id: 'token', header: 'Token', width: 150, cell: (t) => <span className="font-mono text-2xs text-dim">cst_{t.env}_{t.prefix}…</span> },
    { id: 'scopes', header: 'Scopes', width: 200, cell: (t) => <span className="flex flex-wrap gap-1">{t.scopes.map((s) => <Chip key={s} mono>{s}</Chip>)}</span> },
    { id: 'writes', header: 'Writes', width: 70, cell: (t) => (t.writeBudget === null || t.writeBudget === undefined ? <span className="text-faint" title="No write budget: writes are not capped or counted">no cap</span> : `${t.writesUsed ?? 0}/${t.writeBudget}`) },
    { id: 'expires', header: 'Expires', width: 120, cell: (t) => <span className="text-dim" title={t.expiresAt}>{stamp(t.expiresAt)}</span> },
    { id: 'used', header: 'Last used', width: 120, cell: (t) => <span className="text-dim" title={t.lastUsedAt ?? 'Never used'}>{stamp(t.lastUsedAt) || 'never'}</span> },
    { id: 'act', header: 'Actions', hideHeader: true, fixed: true, width: 80, cell: (t) => (revoked(t) ? <Chip>revoked</Chip> : <Button size="xs" variant="ghost" onClick={() => void revoke(t)}>Revoke</Button>) },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tokens-panel">
      <form className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3" aria-label="New token" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <Field label="For" className="w-56"><Input value={name} maxLength={80} placeholder="laptop scripts" onChange={(e) => setName(e.target.value)} /></Field>
        <div className="flex flex-col gap-1.5 pb-1" role="group" aria-label="Scopes">
          {SCOPES.map((s) => (
            <span key={s.id} title={s.hint}>
              <Checkbox label={s.label} checked={scopes.includes(s.id)} onCheckedChange={(on) => setScopes((cur) => (on ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} />
            </span>
          ))}
        </div>
        <Field label="Write budget" className="w-32"><NumberInput value={budget} onChange={setBudget} min={1} max={10000} step={1} precision={0} placeholder="none" /></Field>
        <Field label="Expires after" className="w-32"><Select value={life} onValueChange={setLife} options={LIFETIMES} /></Field>
        <Button type="submit" variant="primary" loading={busy}>Create token</Button>
        {error === undefined ? null : <span role="alert" className="text-xs text-err">{error}</span>}
      </form>
      {secret === undefined ? null : <CreatedToken secret={secret} />}
      <div className="min-h-0 flex-1 overflow-auto">
        {list.isError ? <Callout tone="err" className="m-4">{list.error.message}</Callout> : (
          <DataTable label="API tokens" rows={list.data ?? []} columns={columns} getRowId={(t) => t.id} loading={list.isPending} empty="No tokens yet." />
        )}
      </div>
    </div>
  );
}
