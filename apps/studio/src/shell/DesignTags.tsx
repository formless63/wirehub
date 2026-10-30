/**
 * A design's free tags (`CableDesign.tags`) as small chips, and the Designs list's bulk tagging bar:
 * the picked designs, "select all matching", and Add tag… / Remove tag…, one request
 * (`POST /api/design-tags`, `server/design-tags.ts`) with a toast that says what happened per design.
 */

import { useState, type JSX } from 'react';
import { toast } from 'sonner';
import { IconTag, IconTagOff } from '@tabler/icons-react';
import { Button, Chip, Input, Popover } from '@wirehub/editor-react';
import { isDesignTag } from '@wirehub/model';

import { retagDesigns, type DesignTagsAnswer } from '../persistence.browser.ts';

/** Up to `max` tags as chips, the rest folded into `+n` (named in its tooltip). */
export function TagChips({ tags, max = 3 }: { tags: readonly string[] | undefined; max?: number }): JSX.Element | null {
  const all = tags ?? [];
  if (all.length === 0) return null;
  const shown = all.slice(0, max);
  const rest = all.slice(max);
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden" aria-label={`Tags: ${all.join(', ')}`} data-testid="design-tags">
      {shown.map((t) => (
        <Chip key={t} className="shrink-0" title={`Tag: ${t}`}>
          {t}
        </Chip>
      ))}
      {rest.length === 0 ? null : (
        <Chip className="shrink-0" title={rest.join(', ')}>
          +{rest.length}
        </Chip>
      )}
    </span>
  );
}

const REASONS: Readonly<Record<string, string>> = {
  'not-found': 'gone',
  locked: 'being edited',
  'read-only': "a pack's, read-only",
  stale: 'changed meanwhile',
  invalid: 'refused',
  refused: 'refused',
};

/** One line for the toast: what was changed, what already was, and what was skipped. */
export function tagSummary(answer: DesignTagsAnswer): { title: string; description?: string } {
  const what = [...answer.add.map((t) => `+${t}`), ...answer.remove.map((t) => `−${t}`)].join(', ');
  const n = (count: number): string => `${count} design${count === 1 ? '' : 's'}`;
  const title = answer.changed === 0 ? `No design changed (${what}).` : `Tagged ${n(answer.changed)}: ${what}.`;
  const lines: string[] = [];
  if (answer.unchanged > 0) lines.push(`${n(answer.unchanged)} already ${answer.unchanged === 1 ? 'was' : 'were'} as asked.`);
  const skipped = answer.results.filter((r) => r.outcome === 'skipped');
  if (skipped.length > 0) {
    const named = skipped.slice(0, 5).map((r) => `${r.id} (${REASONS[r.reason ?? 'refused'] ?? r.reason})`);
    lines.push(`Skipped ${n(skipped.length)}: ${named.join(', ')}${skipped.length > 5 ? `, and ${skipped.length - 5} more` : ''}.`);
  }
  return { title, ...(lines.length === 0 ? {} : { description: lines.join(' ') }) };
}

interface BulkTagBarProps {
  /** the picked design ids */
  picked: readonly string[];
  /** how many of them the current filter hides */
  hidden: number;
  /** how many designs match the filter: "Select all N matching" */
  matching: number;
  onSelectAll: () => void;
  onClear: () => void;
  /** every tag in the list, for Add tag's suggestions */
  knownTags: readonly string[];
  /** the tags the picked designs carry, with how many carry each, for Remove tag */
  pickedTags: readonly { tag: string; count: number }[];
  /** after an answer: refresh the list */
  onDone: () => void;
}

export function BulkTagBar(props: BulkTagBarProps): JSX.Element {
  const [needle, setNeedle] = useState('');
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const typed = needle.trim();
  const valid = typed !== '' && isDesignTag(typed);
  const suggestions = props.knownTags.filter((t) => t.toLowerCase().includes(typed.toLowerCase()) && t !== typed).slice(0, 12);

  const send = async (change: { add?: string[]; remove?: string[] }): Promise<void> => {
    setBusy(true);
    const out = await retagDesigns({ designs: [...props.picked], ...change });
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, out.hint === undefined ? undefined : { description: out.hint });
      return;
    }
    const { title, description } = tagSummary(out.value);
    (out.value.changed === 0 ? toast.warning : toast.success)(title, description === undefined ? undefined : { description });
    setAddOpen(false);
    setRemoveOpen(false);
    setNeedle('');
    props.onDone();
  };

  const n = props.picked.length;
  return (
    <div role="region" aria-label="Selected designs" className="flex flex-wrap items-center gap-2 border-b border-line bg-raised px-4 py-1 text-xs">
      <span className="font-medium text-ink" data-testid="picked-count">
        {n} selected
      </span>
      {props.hidden === 0 ? null : <span className="text-faint">({props.hidden} not shown by the filter)</span>}
      {props.matching > 0 && props.matching !== n ? (
        <Button size="xs" variant="ghost" onClick={props.onSelectAll} title="Select every design the current filter shows">
          Select all {props.matching} matching
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" onClick={props.onClear}>
        Clear
      </Button>
      <span className="grow" />
      <Popover
        align="end"
        aria-label="Add a tag to the selected designs"
        open={addOpen}
        onOpenChange={setAddOpen}
        trigger={
          <Button size="xs" icon={<IconTag size={14} aria-hidden />} disabled={busy}>
            Add tag…
          </Button>
        }
      >
        <form
          className="flex w-64 flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) void send({ add: [typed] });
          }}
        >
          <Input autoFocus aria-label="Tag to add" placeholder="Phase 1" maxLength={40} value={needle} onChange={(event) => setNeedle(event.target.value)} />
          {typed !== '' && !valid ? <p className="text-2xs text-err">Letters, digits, spaces, dash, underscore, dot or slash; up to 40 characters.</p> : null}
          <Button type="submit" size="xs" variant="primary" disabled={!valid || busy}>
            Add “{typed === '' ? '…' : typed}” to {n} design{n === 1 ? '' : 's'}
          </Button>
          {suggestions.length === 0 ? null : (
            <div role="group" aria-label="Existing tags" className="flex flex-wrap gap-1 pt-1">
              {suggestions.map((t) => (
                <Button key={t} size="xs" variant="ghost" disabled={busy} onClick={() => void send({ add: [t] })}>
                  {t}
                </Button>
              ))}
            </div>
          )}
        </form>
      </Popover>
      <Popover
        align="end"
        aria-label="Remove a tag from the selected designs"
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        trigger={
          <Button size="xs" icon={<IconTagOff size={14} aria-hidden />} disabled={busy || props.pickedTags.length === 0}>
            Remove tag…
          </Button>
        }
      >
        <div role="group" aria-label="Tags on the selected designs" className="flex w-64 flex-col gap-1">
          {props.pickedTags.map(({ tag, count }) => (
            <Button key={tag} size="xs" variant="ghost" disabled={busy} onClick={() => void send({ remove: [tag] })} title={`Remove “${tag}” from the ${count} selected design${count === 1 ? '' : 's'} that carry it`}>
              {tag} <span className="text-faint">· {count}</span>
            </Button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
