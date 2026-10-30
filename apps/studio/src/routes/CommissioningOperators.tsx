/**
 * Settings › People: who besides owners may record firmware commissioning, as one row
 * (`GET|PUT /api/firmware/commissioning-authority`, `server/firmware/commission.ts`).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input } from '@wirehub/editor-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import { commissioningAuthorityKey, fetchAuthority, saveAuthority } from '../firmware-commission.browser.ts';
import { unwrap } from '../products.browser.ts';

export function CommissioningOperators(): JSX.Element | null {
  const client = useQueryClient();
  const authority = useQuery({ queryKey: commissioningAuthorityKey, queryFn: () => unwrap(fetchAuthority()), retry: false });
  const [text, setText] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (authority.data === undefined) return null;
  const current = text ?? authority.data.operators.join(', ');
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const operators = current.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s !== '');
      const out = await saveAuthority(operators, authority.data.etag);
      if (!out.ok) return void toast.error(out.message, { description: out.hint });
      client.setQueryData(commissioningAuthorityKey, out.value);
      setText(undefined);
      toast.success('Saved the commissioning operators.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-wrap items-end gap-3" aria-label="Commissioning operators" data-testid="commissioning-operators" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Commissioning operators" help="Sign-in emails, besides owners, who may record a unit's firmware commissioning. Owners always may; compiling does not grant it." className="w-96">
        <Input mono value={current} placeholder="none besides owners" onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button type="submit" loading={busy} disabled={text === undefined}>Save</Button>
    </form>
  );
}
