/**
 * Settings › People, in the app itself (it used to be the server's page in an iframe): who is in
 * the hub and their role, revoke or give back access, invite by email (the link is shown once),
 * withdraw an open invitation. Owners only; same API: `GET /api/people`, `PATCH /api/people/:id`,
 * `POST /api/people/:id/disable|enable`, `POST /api/invitations`, `DELETE /api/invitations/:id`
 * (`server/auth/gate.ts`).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCopy } from '@tabler/icons-react';
import { Button, Callout, Chip, DataTable, Field, Input, Select, type DataColumn } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import { request } from '../persistence.browser.ts';
import { localDate } from '../when.ts';
import { useStudio } from '../studio-context.tsx';
import { CommissioningOperators } from './CommissioningOperators.tsx';

type Role = 'owner' | 'editor' | 'viewer';
interface PersonView {
  id: string;
  email: string;
  name: string;
  role: Role | 'service';
  disabledAt?: string | null;
}
interface InvitationView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt?: string | null;
}
type Row = { type: 'person'; person: PersonView } | { type: 'invitation'; invitation: InvitationView };

const KEY = ['people'] as const;
const ROLES: { value: Role; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
];
const ROLE_HELP = 'An owner manages people and settings, an editor changes the catalog, a viewer reads.';
const rowId = (r: Row): string => (r.type === 'person' ? r.person.id : `invite:${r.invitation.id}`);

export function PeoplePanel(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const out = await request<{ people: PersonView[]; invitations: InvitationView[] }>('/api/people');
      if (!out.ok) throw new Error(out.message);
      return out.value;
    },
    retry: false,
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string }>();
  const refresh = (): void => void client.invalidateQueries({ queryKey: KEY });
  const act = async (out: Promise<{ ok: boolean; message?: string; hint?: string }>, done?: string): Promise<void> => {
    const answer = await out;
    if (!answer.ok) toast.error(answer.message ?? 'That did not work.', { description: answer.hint });
    else if (done !== undefined) toast.success(done);
    refresh();
  };

  const invite = async (): Promise<void> => {
    if (email.trim() === '') return;
    setBusy(true);
    const out = await request<{ invitation: InvitationView; link: string }>('/api/invitations', { method: 'POST', body: { email: email.trim(), role } });
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setLink({ email: out.value.invitation.email, url: out.value.link });
    setEmail('');
    refresh();
  };

  const rows: Row[] = [
    ...(list.data?.people ?? []).map((person): Row => ({ type: 'person', person })),
    ...(list.data?.invitations ?? []).filter((i) => i.acceptedAt === undefined || i.acceptedAt === null).map((invitation): Row => ({ type: 'invitation', invitation })),
  ];
  const columns: DataColumn<Row>[] = [
    { id: 'name', header: 'Name', fixed: true, width: 160, cell: (r) => (r.type === 'person' ? <span className={r.person.disabledAt ? 'text-faint line-through' : ''}>{r.person.name}</span> : <span className="text-faint">Invited</span>), sortValue: (r) => (r.type === 'person' ? r.person.name : '') },
    { id: 'email', header: 'Email', width: 220, cell: (r) => (r.type === 'person' ? r.person.email : r.invitation.email), sortValue: (r) => (r.type === 'person' ? r.person.email : r.invitation.email) },
    {
      id: 'role',
      header: 'Role',
      title: ROLE_HELP,
      width: 140,
      cell: (r) =>
        r.type === 'invitation' || r.person.role === 'service' ? (
          <span className="text-dim">{r.type === 'invitation' ? ROLES.find((x) => x.value === r.invitation.role)?.label : 'Service'}</span>
        ) : (
          <Select
            aria-label={`Role of ${r.person.name}`}
            className="w-28"
            value={r.person.role}
            options={ROLES}
            onValueChange={(value) => void act(request(`/api/people/${r.person.id}`, { method: 'PATCH', body: { role: value } }), `${r.person.name} is now ${value === 'owner' ? 'an owner' : `an ${value}`}.`)}
          />
        ),
      sortValue: (r) => (r.type === 'person' ? r.person.role : r.invitation.role),
    },
    {
      id: 'state',
      header: 'State',
      width: 110,
      cell: (r) =>
        r.type === 'invitation' ? <span className="text-dim">until {localDate(r.invitation.expiresAt)}</span> : r.person.disabledAt ? <Chip tone="err">access revoked</Chip> : null,
    },
    {
      id: 'act',
      header: 'Actions',
      hideHeader: true,
      fixed: true,
      width: 140,
      cell: (r) =>
        r.type === 'invitation' ? (
          <Button size="xs" variant="ghost" onClick={() => void act(request(`/api/invitations/${r.invitation.id}`, { method: 'DELETE' }), 'Invitation withdrawn.')}>
            Withdraw
          </Button>
        ) : r.person.email === me?.email ? null : (
          <Button size="xs" variant="ghost" onClick={() => void act(request(`/api/people/${r.person.id}/${r.person.disabledAt ? 'enable' : 'disable'}`, { method: 'POST' }), r.person.disabledAt ? `${r.person.name} has access again.` : `${r.person.name} no longer has access.`)}>
            {r.person.disabledAt ? 'Give access back' : 'Revoke access'}
          </Button>
        ),
    },
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-3" data-testid="people-panel">
      <form className="flex flex-wrap items-end gap-3" aria-label="Invite" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <Field label="Invite by email" className="w-64">
          <Input type="email" value={email} placeholder="someone@example.com" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" help={ROLE_HELP} className="w-32">
          <Select value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={email.trim() === ''}>Invite</Button>
      </form>
      {link === undefined ? null : (
        <Callout tone="ok" action={<Button size="xs" icon={<IconCopy size={12} aria-hidden />} onClick={() => { void navigator.clipboard?.writeText(link.url); toast.success('Copied.'); }}>Copy</Button>}>
          <span className="text-dim">Link for {link.email}, shown once:</span> <span className="font-mono text-xs break-all" data-testid="invite-link">{link.url}</span>
        </Callout>
      )}
      {list.isError ? (
        <Callout tone="err">{list.error.message}</Callout>
      ) : (
        <DataTable label="People" rows={rows} columns={columns} getRowId={rowId} loading={list.isPending} empty="Nobody yet." />
      )}
      <CommissioningOperators />
    </div>
  );
}
