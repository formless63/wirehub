/**
 * "Use in design…" on a generated enclosure's record: pick a design and open its device view with
 * this shell offered in the enclosure picker (`/cables/:id?view=device&enclosure=`). Nothing is
 * changed until the user confirms there, as an ordinary undoable edit of that design.
 */

import { useState, type JSX } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Combobox } from '@wirehub/editor-react';

import { cableListKey, loadCableList } from '../queries.ts';

export function UseInDesign({ shell }: { shell: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const list = useQuery({ queryKey: cableListKey, queryFn: loadCableList, enabled: open, staleTime: 30_000 });
  if (!open) return <Button size="xs" onClick={() => setOpen(true)}>Use in design…</Button>;
  const options = (list.data?.entries ?? []).map((e) => ({ value: e.id, label: e.label, ...(e.boardLabels.length === 0 ? {} : { hint: e.boardLabels.join(', ') }) }));
  return (
    <span className="flex items-center gap-1">
      <Combobox size="xs" className="w-72" aria-label="Design to use this enclosure in" placeholder={list.isLoading ? 'Loading designs…' : 'Find a design…'} options={options} value={null}
        emptyText="No designs match"
        onValueChange={(id) => { void navigate({ to: '/cables/$id', params: { id }, search: { view: 'device', enclosure: shell } }); }} />
      <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}
