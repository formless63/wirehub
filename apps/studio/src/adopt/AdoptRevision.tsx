/**
 * Adopt a newer revision of a part (`server/adopt.ts`, `@wirehub/model` `revision-adopt.ts`):
 *
 * - the Library page of a board (or a mechanical part with a revision) lists the designs that
 *   place an older revision, each with what moving would change, and Adopt per design or all;
 * - a design's inspector shows a "newer revision" row per placed part that has one, adopted
 *   through the editor's own history (so Undo takes it back).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';
import { Button, Chip, IconButton, Section, type EditorExtensions } from '@wirehub/editor-react';
import {
  adoptRevision,
  adoptSubassemblyRevision,
  impactNeedsLook,
  impactSummary,
  newerRevisionsInDesign,
  newerSubassemblyRevisions,
  subassemblyImpactSummary,
  type AdoptImpact,
  type AdoptKind,
  type RevisionSibling,
  type SubassemblyAdoptImpact,
  type TerminalName,
} from '@wirehub/model';

import { request } from '../definitions.browser.ts';
import { unwrap } from '../products.browser.ts';
import { useOptionalStudio } from '../studio-context.tsx';

interface AdoptView {
  kind: AdoptKind;
  id: string;
  family: RevisionSibling[];
  target?: RevisionSibling;
  impacts: (AdoptImpact & { etag: string })[];
}

const path = (kind: string, id: string): string => `/api/adopt/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
const adoptKey = (kind: string, id: string) => ['adopt', kind, id] as const;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const termName = (t: TerminalName): string => t.label ?? t.id;

/** The lines behind an impact's one-line summary: names first, ids only where a terminal has no label. */
function ImpactDetail({ impact }: { impact: AdoptImpact }): JSX.Element {
  const rows: [string, string][] = [];
  if (impact.lostTerminals.length > 0) rows.push(['Loses its terminal', impact.lostTerminals.map((l) => `${l.terminal} (to ${l.other})`).join(', ')]);
  if (impact.lostPads.length > 0) rows.push(['Loses its pad', impact.lostPads.map((l) => `${l.terminal} ${l.pad} (to ${l.other})`).join(', ')]);
  if (impact.lostStates.length > 0) rows.push(['Jumper state dropped', impact.lostStates.map((s) => s.ref).join(', ')]);
  if (impact.renamed.length > 0) rows.push(['Renamed', impact.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')]);
  if (impact.removed.length > 0) rows.push(['Removed', impact.removed.map(termName).join(', ')]);
  if (impact.added.length > 0) rows.push(['Added', impact.added.map(termName).join(', ')]);
  if (impact.links.added + impact.links.removed > 0) rows.push(['Board links', `+${impact.links.added} −${impact.links.removed}`]);
  rows.push(['BOM', `${impact.bom.from} → ${impact.bom.to}`]);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 py-1 pl-5 text-muted" data-testid="adopt-detail">
      {rows.map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-dim">{k}</dt><dd className="m-0 break-words">{v}</dd></div>
      ))}
    </dl>
  );
}

function ImpactRow({ impact, showFrom, canEdit, busy, onAdopt }: { impact: AdoptImpact; showFrom: boolean; canEdit: boolean; busy: boolean; onAdopt?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const look = impactNeedsLook(impact);
  return (
    <li data-testid="adopt-row" data-design={impact.design}>
      <div className="flex items-center gap-2">
        <IconButton size="xs" label={`What changes in ${impact.label}`} aria-expanded={open} icon={open ? <IconChevronDown size={12} aria-hidden /> : <IconChevronRight size={12} aria-hidden />} onClick={() => setOpen(!open)} />
        <Link to="/cables/$id" params={{ id: impact.design }} className="underline">{impact.label}</Link>
        {showFrom ? <Chip>{impact.from.revision}</Chip> : null}
        {impact.status === 'retired' || impact.status === 'legacy' ? <Chip>{impact.status}</Chip> : null}
        <span className={look ? 'text-warn' : 'text-dim'} title={look ? 'Adopting removes these landings, pads or jumper states; History restores the design.' : undefined}>{impactSummary(impact)}</span>
        <span className="flex-1" />
        {canEdit && onAdopt !== undefined ? <Button size="xs" loading={busy} onClick={onAdopt}>Adopt</Button> : null}
      </div>
      {open ? <ImpactDetail impact={impact} /> : null}
    </li>
  );
}

/** The Library record's section: designs on an older revision of this part, with Adopt. */
export function AdoptRevisionSection({ kind, id, readOnly, onOpen }: { kind: AdoptKind; id: string; readOnly: boolean; onOpen?: (id: string) => void }): JSX.Element | null {
  const client = useQueryClient();
  const query = useQuery({ queryKey: adoptKey(kind, id), queryFn: () => unwrap(request<AdoptView>(path(kind, id))), retry: false, staleTime: 5_000 });
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const view = query.data;
  if (view?.target === undefined || view.impacts.length === 0) return null;
  const target = view.target;
  const newest = target.id === id;

  const adopt = async (rows: readonly (AdoptImpact & { etag: string })[], key: string): Promise<void> => {
    setBusy(key);
    const out = await request<{ adopted: string[]; refused: { id: string; error: string }[] }>(path(kind, id), {
      method: 'POST',
      body: { to: target.id, designs: rows.map((r) => ({ id: r.design, from: r.from.id, etag: r.etag })) },
    });
    setBusy(undefined);
    await client.invalidateQueries({ queryKey: ['adopt'] });
    if (!out.ok) return void toast.error(out.message, out.hint === undefined ? {} : { description: out.hint });
    const label = (d: string): string => rows.find((r) => r.design === d)?.label ?? d;
    if (out.value.adopted.length > 0) toast.success(`${plural(out.value.adopted.length, 'design')} now on ${target.name}`);
    if (out.value.refused.length > 0) toast.error(`${plural(out.value.refused.length, 'design')} not switched`, { description: out.value.refused.map((r) => `${label(r.id)}: ${r.error}`).join('\n') });
  };
  const all = view.impacts.filter((i) => i.status !== 'retired');
  const canEdit = !readOnly;
  return (
    <Section
      id="adopt-revision"
      title={newest ? 'Older revisions in use' : 'Newer revision'}
      testId="adopt-revision"
      summary={newest ? plural(view.impacts.length, 'design') : `${target.name} · ${plural(view.impacts.length, 'design')}`}
      actions={
        <>
          {newest || onOpen === undefined ? null : <Button size="xs" variant="ghost" onClick={() => onOpen(target.id)}>Open {target.revision}</Button>}
          {canEdit && all.length > 1 ? <Button size="xs" loading={busy === '*'} disabled={busy !== undefined} onClick={() => void adopt(all, '*')}>Adopt {target.revision} in all {all.length}</Button> : null}
        </>
      }
    >
      <ul className="flex flex-col gap-0.5">
        {view.impacts.map((impact) => (
          <ImpactRow key={`${impact.design}/${impact.from.id}`} impact={impact} showFrom={newest} canEdit={canEdit} busy={busy === impact.design} onAdopt={() => void adopt([impact], impact.design)} />
        ))}
      </ul>
    </Section>
  );
}

function DesignNewerRow({ impact, canEdit, onAdopt }: { impact: AdoptImpact; canEdit: boolean; onAdopt: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="design-newer-row" className="flex flex-col">
      <div className="flex items-center gap-1">
        <IconButton size="xs" label="What changes" aria-expanded={open} icon={open ? <IconChevronDown size={12} aria-hidden /> : <IconChevronRight size={12} aria-hidden />} onClick={() => setOpen(!open)} />
        <span>{impact.from.name} → <strong>{impact.to.revision}</strong></span>
        <span className="flex-1" />
        {canEdit ? <Button size="xs" onClick={onAdopt}>Adopt</Button> : null}
      </div>
      <span className={`pl-6 ${impactNeedsLook(impact) ? 'text-warn' : 'text-dim'}`}>{impactSummary(impact)}</span>
      {open ? <ImpactDetail impact={impact} /> : null}
    </li>
  );
}

/** The lines behind a sub-assembly impact's summary. */
function SubassemblyDetail({ impact }: { impact: SubassemblyAdoptImpact }): JSX.Element {
  const rows: [string, string][] = [];
  if (impact.lost.length > 0) rows.push(['Landing removed', impact.lost.map((l) => `${l.instance} ${l.port} (to ${l.other})`).join(', ')]);
  if (impact.removed.length > 0) rows.push(['Free end gone', impact.removed.map((p) => p.label).join(', ')]);
  if (impact.added.length > 0) rows.push(['New free end', impact.added.map((p) => p.label).join(', ')]);
  if (rows.length === 0) rows.push(['Free ends', 'unchanged']);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 py-1 pl-5 text-muted" data-testid="adopt-detail">
      {rows.map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-dim">{k}</dt><dd className="m-0 break-words">{v}</dd></div>
      ))}
    </dl>
  );
}

function SubassemblyNewerRow({ impact, canEdit, onAdopt }: { impact: SubassemblyAdoptImpact; canEdit: boolean; onAdopt: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="design-newer-row" data-subassembly={impact.placed} className="flex flex-col">
      <div className="flex items-center gap-1">
        <IconButton size="xs" label="What changes" aria-expanded={open} icon={open ? <IconChevronDown size={12} aria-hidden /> : <IconChevronRight size={12} aria-hidden />} onClick={() => setOpen(!open)} />
        <span>{impact.placedLabel} Rev {impact.from} → <strong>Rev {impact.to}</strong></span>
        <span className="flex-1" />
        {canEdit ? <Button size="xs" onClick={onAdopt}>Adopt</Button> : null}
      </div>
      <span className={`pl-6 ${impact.lost.length > 0 ? 'text-warn' : 'text-dim'}`}>{subassemblyImpactSummary(impact)}</span>
      {open ? <SubassemblyDetail impact={impact} /> : null}
    </li>
  );
}

/** The design inspector's "newer revision" rows: one per placed part (or pinned sub-assembly) that has one; Adopt goes through the editor history. */
export function DesignNewerRevisions({ context }: { context: Parameters<NonNullable<EditorExtensions['inspector']>>[0] }): JSX.Element | null {
  const studio = useOptionalStudio();
  const impacts = newerRevisionsInDesign(context.db, context.design);
  const subs = newerSubassemblyRevisions(context.db, context.design);
  const count = impacts.length + subs.length;
  if (count === 0) return null;
  const canEdit = !context.readOnly && context.onChange !== undefined && studio?.me?.role !== 'viewer';
  return (
    <Section id="design-newer-revisions" title="Newer revision" testId="design-newer-revisions" className="mx-2" summary={<Chip tone="info">{plural(count, 'part')}</Chip>}>
      <ul className="flex flex-col gap-0.5">
        {impacts.map((impact) => <DesignNewerRow key={impact.from.id} impact={impact} canEdit={canEdit} onAdopt={() => context.onChange?.(adoptRevision(context.db, context.design, impact.kind, impact.from.id, impact.to.id), `Adopt ${impact.to.name}`)} />)}
        {subs.map((impact) => (
          <SubassemblyNewerRow
            key={`${impact.placed}@${impact.from}`}
            impact={impact}
            canEdit={canEdit}
            onAdopt={() => context.onChange?.(adoptSubassemblyRevision(context.db, context.design, impact.placed, impact.from, impact.to), `Adopt ${impact.placedLabel} Rev ${impact.to}`)}
          />
        ))}
      </ul>
    </Section>
  );
}

interface SubassemblyAdoptView {
  id: string;
  to?: number;
  impacts: (SubassemblyAdoptImpact & { etag: string })[];
}

/**
 * On a design's "Used in" line: the parents pinned to an older saved version of it, each with a
 * one-click re-pin to the newest released one (what changes in the tooltip).
 */
export function SubassemblyRepin({ id, parent }: { id: string; parent: string }): JSX.Element | null {
  const studio = useOptionalStudio();
  const client = useQueryClient();
  const query = useQuery({ queryKey: adoptKey('designs', id), queryFn: () => unwrap(request<SubassemblyAdoptView>(path('designs', id))), retry: false, staleTime: 5_000 });
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const view = query.data;
  const mine = view?.impacts.filter((i) => i.design === parent) ?? [];
  if (view?.to === undefined || mine.length === 0) return null;
  const to = view.to;
  const canEdit = studio?.me?.role !== 'viewer';
  const repin = async (rows: readonly (SubassemblyAdoptImpact & { etag: string })[], key: string): Promise<void> => {
    setBusy(key);
    const out = await request<{ adopted: string[]; refused: { id: string; error: string }[] }>(path('designs', id), {
      method: 'POST',
      body: { to, designs: rows.map((r) => ({ id: r.design, from: r.from, etag: r.etag })) },
    });
    setBusy(undefined);
    await client.invalidateQueries({ queryKey: ['adopt'] });
    await client.invalidateQueries({ queryKey: ['studio', 'used-in', id] });
    if (!out.ok) return void toast.error(out.message, out.hint === undefined ? {} : { description: out.hint });
    const label = (d: string): string => rows.find((r) => r.design === d)?.label ?? d;
    if (out.value.adopted.length > 0) toast.success(`${plural(out.value.adopted.length, 'design')} now on Rev ${to}`);
    if (out.value.refused.length > 0) toast.error(`${plural(out.value.refused.length, 'design')} not re-pinned`, { description: out.value.refused.map((r) => `${label(r.id)}: ${r.error}`).join('\n') });
  };
  return (
    <span className="flex items-center gap-1" data-testid="subassembly-repin">
      {mine.map((impact) => (
        <Button
          key={`${impact.design}@${impact.from}`}
          size="xs"
          variant="ghost"
          disabled={!canEdit || busy !== undefined}
          loading={busy === `${impact.design}@${impact.from}`}
          title={`Pinned to Rev ${impact.from}: re-pin to Rev ${to} (${subassemblyImpactSummary(impact)}${impact.lost.length === 0 ? '' : `: ${[...new Set(impact.lost.map((l) => l.port))].join(', ')}`})`}
          onClick={() => void repin([impact], `${impact.design}@${impact.from}`)}
        >
          Rev {impact.from} → {to}
        </Button>
      ))}
    </span>
  );
}

/** The editor's extensions with the newer-revision rows added to the inspector's Issues (the default) and Part tabs. */
export function withNewerRevisions(extensions: EditorExtensions): EditorExtensions {
  const inner = extensions.inspector;
  return {
    ...extensions,
    inspector: (context) => (
      <>
        {context.inspectorTab !== undefined && context.inspectorTab !== 'part' && context.inspectorTab !== 'issues' ? null : <DesignNewerRevisions context={context} />}
        {inner?.(context)}
      </>
    ),
  };
}
