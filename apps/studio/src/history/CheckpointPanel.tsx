/**
 * One agent checkpoint: every change an API token made — an
 * agent's grant — as one piece of work: what it changed, what undoing it
 * would do to each record, and **Undo this agent's work**, which brings them
 * all back in one new change (or, when any one cannot be undone cleanly,
 * nothing). Shown above the History list when it is filtered to a token.
 */

import { Button, Chip, ConfirmDialog, type Tone } from '@wirehub/editor-react';
import { IconArrowBackUp, IconRobot } from '@tabler/icons-react';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { fetchCheckpoint, historyTime, restoreCheckpoint } from '../history.browser.ts';
import { historyTouchLabel } from './labels.ts';
import { parseSubject, type CheckpointDetail, type CheckpointSubject } from './types.ts';
import { useStudio } from '../studio-context.tsx';

const ACTION: Readonly<Record<CheckpointSubject['action'], { label: string; tone: Tone }>> = {
  restore: { label: 'restore', tone: 'info' },
  remove: { label: 'remove', tone: 'warn' },
  none: { label: 'already back', tone: 'neutral' },
};

export function CheckpointPanel(props: { token: string; onUndone?: () => void }): JSX.Element {
  const [detail, setDetail] = useState<CheckpointDetail>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { designs } = useStudio();
  /** a design by its title as it is now (what undo acts on); anything else readably, never a raw key */
  const subjectName = (s: CheckpointSubject): string => {
    const subject = parseSubject(s.subject);
    const design = subject?.type === 'design' ? designs.find((d) => d.id === subject.id) : undefined;
    return design?.label !== undefined && design.label !== '' ? `Design: ${design.label}` : historyTouchLabel({ subject: s.subject, label: s.label, kind: 'other', op: 'put' });
  };

  const load = useCallback(async () => {
    const out = await fetchCheckpoint(props.token);
    if (out.ok) {
      setDetail(out.value);
      setError(undefined);
    } else setError(`${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}`);
  }, [props.token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function undo(): Promise<void> {
    if (detail === undefined) return;
    setBusy(true);
    const out = await restoreCheckpoint(detail);
    setBusy(false);
    setConfirming(false);
    if (!out.ok) {
      toast.error('Nothing was undone', { description: `${out.error}${out.hint === undefined ? '' : ` ${out.hint}`}` });
      await load();
      return;
    }
    const n = out.value.restored.subjects.length;
    toast.success(`Undid the agent's work on ${n} ${n === 1 ? 'record' : 'records'}`, {
      description: ['Saved as one new change; the history keeps the agent’s changes too.', ...(out.value.skipped ?? [])].join(' '),
    });
    await load();
    props.onUndone?.();
  }

  if (error !== undefined) return <div role="alert" className="px-4 py-2 text-xs text-err">{error}</div>;
  if (detail === undefined) return <div className="px-4 py-2 text-xs text-faint">Loading the checkpoint…</div>;
  const c = detail.checkpoint;
  const pending = detail.subjects.filter((s) => s.action !== 'none');
  const blocked = detail.subjects.filter((s) => s.blocked !== undefined);
  return (
    <section className="mx-4 my-2 rounded-md border border-line bg-panel px-3 py-2" data-testid="checkpoint" data-token={c.token} aria-label="Agent checkpoint">
      <div className="flex flex-wrap items-center gap-2">
        <IconRobot size={16} className="text-dim" aria-hidden />
        <span className="text-sm font-semibold text-ink">Agent checkpoint</span>
        <span className="min-w-0 truncate text-xs text-dim" title={c.label}>{c.label.replace(/ \(agent draft grant\)$/, '')}</span>
        <span className="text-xs text-faint">
          {c.sets} {c.sets === 1 ? 'change' : 'changes'} · {historyTime(c.firstAt)}{c.firstAt === c.lastAt ? '' : ` – ${historyTime(c.lastAt)}`}
        </span>
        <span className="grow" />
        <Button
          variant="primary"
          disabled={!detail.restorable}
          title={detail.restorable ? 'Bring every record this agent changed back to how it was before, as one new change' : blocked.length > 0 ? 'Some records cannot be undone with the rest; see below' : 'Everything is already back as it was'}
          onClick={() => setConfirming(true)}
          data-testid="checkpoint-undo"
        >
          <IconArrowBackUp size={14} /> Undo this agent’s work
        </Button>
      </div>
      <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0" data-testid="checkpoint-subjects">
        {detail.subjects.map((s) => (
          <li key={s.subject} className="flex flex-wrap items-center gap-1.5 text-xs" data-subject={s.subject} data-action={s.action}>
            <Chip tone={s.blocked === undefined ? ACTION[s.action].tone : 'err'}>{s.blocked === undefined ? ACTION[s.action].label : 'blocked'}</Chip>
            <span className="text-ink" title={s.label}>{subjectName(s)}</span>
            <span className="text-faint">{s.parts.join(', ')}</span>
            {s.blocked === undefined ? null : <span className="text-err">{s.blocked}</span>}
          </li>
        ))}
        {detail.skipped.map((line) => (
          <li key={line} className="text-xs text-faint">{line}</li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming}
        title="Undo this agent’s work?"
        confirmLabel="Undo"
        destructive={pending.some((s) => s.action === 'remove')}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void undo()}
      >
        <p className="m-0">
          {pending.length} {pending.length === 1 ? 'record goes' : 'records go'} back to how {pending.length === 1 ? 'it was' : 'they were'} before the agent began
          {pending.some((s) => s.action === 'remove') ? '; records the agent created are deleted' : ''}. It is saved as one new change, so it can be undone in turn.
        </p>
      </ConfirmDialog>
    </section>
  );
}
