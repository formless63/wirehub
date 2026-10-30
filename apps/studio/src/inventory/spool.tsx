/**
 * "+ New spool…": a filament spool (weighed) or a resin bottle (by volume) that is not in the
 * library yet. One action makes the part (a mechanical record, kind `other`) and receives its first
 * lot; with no location on the hub yet, a "Workshop" location too. Used by Record a print and by
 * Receive stock.
 */

import { Field, Input } from '@wirehub/editor-react';
import type { JSX } from 'react';

import { createLocation, DIM_UNITS, receiveStock, type Dimension, type Location, type Lot } from '../inventory.browser.ts';
import { useStudio } from '../studio-context.tsx';
import { LocationSelect, QtyRow } from './dialogs.tsx';

/** The picker value that stands for "+ New spool…". */
export const NEW_SPOOL = '__new-spool';
export const NEW_SPOOL_OPTION = { value: NEW_SPOOL, label: '+ New spool…' };

export interface SpoolDraft {
  name: string;
  qty: number | null;
  unit: string;
  location: string | undefined;
}

/** A fresh draft: a 1 kg spool, or a 1 l bottle of resin. */
export function newSpool(dim: Dimension, location: string | undefined): SpoolDraft {
  return { name: '', qty: 1, unit: dim === 'volume' ? 'l' : dim === 'mass' ? 'kg' : DIM_UNITS[dim][0]!, location };
}

const slug = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'spool';

/** Make the part and receive the spool: the new lot, or a sentence saying what stopped it. */
export function useCreateSpool(): (draft: SpoolDraft, locations: readonly Location[], extra?: { lotCode?: string; supplier?: string; supplierRef?: string; unitCost?: number }) => Promise<{ lot: Lot } | { error: string }> {
  const { db, definitions, onDefinitionsChange } = useStudio();
  return async (draft, locations, extra = {}) => {
    const label = draft.name.trim();
    if (label === '') return { error: 'Name the spool.' };
    if (draft.qty === null || draft.qty <= 0) return { error: 'Say how much is on the spool.' };
    let location = draft.location;
    if (location === undefined) {
      if (locations.length > 0) return { error: 'Choose where the spool goes.' };
      const made = await createLocation('Workshop');
      if (!made.ok) return { error: made.message };
      location = made.value.location.id;
    }
    const taken = new Set((db.mechanicals ?? []).map((m) => m.id));
    let id = slug(label);
    for (let n = 2; taken.has(id); n += 1) id = `${slug(label)}-${n}`;
    const created = await definitions.create('mechanicals', { id, label, kind: 'other', src: 'Entered by a user when receiving it into inventory.' });
    if (!created.ok) return { error: `${created.message}${created.hint === undefined ? '' : ` ${created.hint}`}` };
    onDefinitionsChange();
    const received = await receiveStock({ ...extra, item: { kind: 'mechanicals', id }, qty: draft.qty, unit: draft.unit, location });
    if (!received.ok) return { error: `${label} was added to the library, but receiving it failed: ${received.message}` };
    return { lot: received.value.lot };
  };
}

/** Name, amount and (when the hub has locations) where it goes. */
export function SpoolFields({ draft, onChange, dim, locations, placeholder }: { draft: SpoolDraft; onChange: (next: SpoolDraft) => void; dim: Dimension; locations: readonly Location[]; placeholder: string }): JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_12rem] gap-2" data-testid="new-spool">
      <Field label="New spool"><Input autoFocus value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder={placeholder} /></Field>
      <QtyRow dim={dim} qty={draft.qty} unit={draft.unit} onQty={(qty) => onChange({ ...draft, qty })} onUnit={(unit) => onChange({ ...draft, unit })} label="On the spool" />
      {locations.length === 0 ? null : <Field label="Kept in"><LocationSelect locations={locations} value={draft.location} onChange={(location) => onChange({ ...draft, location })} label="Kept in" /></Field>}
    </div>
  );
}
