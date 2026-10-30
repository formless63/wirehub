import { AppLink } from '../shell/AppLink.tsx';
/**
 * Catalog packs on the modules page: what is installed, update with a diff,
 * disable, and "Install pack…" from a file or an https URL. Every change is
 * previewed first (the record-level diff), then applied as one change set by
 * the server; a refusal lists the references or problems that stopped it.
 * Writes need an owner or editor; a viewer's attempt answers with the server's
 * sentence. An installed pack the store has since yanked, flagged, or whose signing
 * key it revoked carries a warning badge with the version to update to (from the
 * store list's `notices`; nothing when no store index is reachable).
 * An owner can **release** an installed pack to the hub: its records keep their ids and content
 * and become the hub's own (editable); the pack then shows as released, without update or disable.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { loadMe } from '../me.browser.ts';

import {
  applyInstall,
  applyRelease,
  applyUpdate,
  disablePack,
  listPacks,
  listStore,
  noticeText,
  previewDisable,
  previewInstall,
  previewRelease,
  previewUpdate,
  sourceOfFile,
  type InstalledPackView,
  type PackAnswer,
  type PackDiff,
  type PackPlan,
  type PackReleasePlan,
  type PackSource,
  type RecordRef,
  type StoreNotice,
} from '../packs.browser.ts';
import type { CodePreviewView } from '../code-modules.browser.ts';
import { CodeConsent } from './CodeConsent.tsx';
import { useNotify, type ViewTarget } from '../notify.ts';
import { Button, Drawer, FileDrop, Input, notify as toastKit } from '@wirehub/editor-react';

const toastDeferred = toastKit.deferred;

const short = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 60 ? `${text.slice(0, 57)}…` : (text ?? '');
};

const RECORD_LABEL: Readonly<Record<string, string>> = {
  connectors: 'Connectors', bodies: 'Connector bodies', interfaces: 'Pinouts', wires: 'Wire stocks', components: 'Components',
  pcbas: 'Boards', mechanicals: 'Shells and hardware', kits: 'Kits', design: 'Example designs',
};
const categoryOf = (r: RecordRef): string => r.file.startsWith('vocab/') ? 'Vocabulary' : RECORD_LABEL[r.kind] ?? r.kind.replaceAll('-', ' ');
const nameOf = (r: RecordRef): string => r.label || categoryOf(r);

function ContentsView({ diff, updating }: { diff: PackDiff; updating: boolean }): JSX.Element {
  const categories = [...new Set([...diff.added, ...diff.changed, ...diff.removed].map(categoryOf))].sort();
  const examples = diff.added.filter((r) => r.kind === 'design');
  return (
    <section aria-label={updating ? 'Changes by category' : 'Pack contents'} className="mb-3" data-testid="pack-contents">
      <h3 className="mb-1 font-medium">{updating ? 'Changes by category' : 'What this pack adds'}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead><tr><th className="py-1 pr-3">Category</th><th className="px-2">Added</th>{updating ? <><th className="px-2">Changed</th><th className="px-2">Removed</th></> : null}</tr></thead>
          <tbody>{categories.map((category) => <tr key={category} className="border-t border-line">
            <th className="py-1 pr-3 font-normal">{category}</th>
            <td className="px-2 tabular-nums">{diff.added.filter((r) => categoryOf(r) === category).length}</td>
            {updating ? <><td className="px-2 tabular-nums">{diff.changed.filter((r) => categoryOf(r) === category).length}</td><td className="px-2 tabular-nums">{diff.removed.filter((r) => categoryOf(r) === category).length}</td></> : null}
          </tr>)}</tbody>
        </table>
      </div>
      {!updating && examples.length === 0 ? <p className="mt-2 text-dim">No example designs are included in this install.</p> : examples.length === 0 ? null : <div className="mt-2"><span className="font-medium">{updating ? 'New example designs' : 'Example designs'}</span><ul className="ml-4 list-disc">{examples.map((r) => <li key={`${r.file}-${r.id}`}>{nameOf(r)}</li>)}</ul></div>}
      {!updating ? <p className="mt-2 text-dim">These are library parts and examples. Review the records below before installing.</p> : null}
    </section>
  );
}

function DiffView({ diff }: { diff: PackDiff }): JSX.Element {
  const [open, setOpen] = useState(false);
  const total = diff.added.length + diff.changed.length + diff.removed.length;
  return (
    <div data-testid="pack-diff" className="mt-1">
      <div className="flex flex-wrap gap-x-3" data-testid="pack-diff-counts">
        <span>{diff.added.length} added</span><span>{diff.changed.length} changed</span><span>{diff.removed.length} removed</span><span className="text-faint">{diff.unchanged} unchanged</span>
      </div>
      {total === 0 ? null : <Button type="button" aria-expanded={open} onClick={() => setOpen(!open)} variant="ghost" size="xs" className="mt-1">{open ? 'Hide records' : 'Show all records'}</Button>}
      {!open ? null : <ul className="ml-4 mt-1 list-disc">
        {diff.added.map((r) => (
          <li key={`a-${r.file}-${r.id}`}>Added {categoryOf(r)}: {nameOf(r)}</li>
        ))}
        {diff.changed.map((r) => (
          <li key={`c-${r.file}-${r.id}`}>
            Changed {categoryOf(r)}: {nameOf(r)}:{' '}
            {r.fields.map((f) => `${f.path}: ${f.before === undefined ? '(new)' : short(f.before)} → ${f.after === undefined ? '(dropped)' : short(f.after)}`).join('; ')}
          </li>
        ))}
        {diff.removed.map((r) => (
          <li key={`r-${r.file}-${r.id}`}>Removed {categoryOf(r)}: {nameOf(r)}</li>
        ))}
      </ul>}
    </div>
  );
}

/** Why a previewed install or update cannot be applied, in one line; undefined when it can (or the plan already says it in red). */
export function blockedReason(plan: PackPlan, applicable: boolean): string | undefined {
  if (applicable) return undefined;
  if (plan.direction === 'same') return `Already installed at ${plan.pack.from ?? plan.pack.to ?? ''}`.trim();
  if ((plan.conflicts ?? []).length > 0) return 'Clashes with records outside the pack';
  if ((plan.issues ?? []).length > 0) return 'Would add errors to the library';
  if ((plan.unmetRequires ?? []).length > 0) return 'Needs packs that are not installed';
  return undefined;
}

export function BlockedReason({ plan, applicable }: { plan: PackPlan; applicable: boolean }): JSX.Element | null {
  const reason = blockedReason(plan, applicable);
  return reason === undefined ? null : <span className="text-dim text-xs" data-testid="pack-blocked">{reason}</span>;
}

export function PlanView({ plan }: { plan: PackPlan }): JSX.Element {
  return (
    <div>
      {plan.diff === undefined ? null : <ContentsView diff={plan.diff} updating={plan.pack.from !== undefined} />}
      {plan.diff === undefined ? null : <DiffView diff={plan.diff} />}
      {plan.licenseChanged === true ? <div>The licence changes to {plan.pack.license}.</div> : null}
      {plan.major === true ? <div>This is a major version: designs built on the old one can break.</div> : null}
      {(plan.unmetRequires ?? []).length > 0 ? <div>Needs packs that are not installed: {plan.unmetRequires?.join(', ')}.</div> : null}
      {(plan.conflicts ?? []).map((c) => (
        <div key={c} className="text-err">{c}</div>
      ))}
      {(plan.issues ?? []).map((i) => (
        <div key={`${i.code}-${i.message}`} className="text-err">{i.code}: {i.message}</div>
      ))}
      {(plan.retired ?? []).length > 0 ? (
        <div data-testid="pack-retired">
          {plan.retired?.length} record{plan.retired?.length === 1 ? ' is' : 's are'} dropped by the new version but still used, so {plan.retired?.length === 1 ? 'it is' : 'they are'} kept as your own (retired from the pack, editable):{' '}
          {plan.retired?.map(nameOf).join(', ')}.
        </div>
      ) : null}
      {(plan.references ?? []).length > 0 ? (
        <ul data-testid="pack-references" className={plan.retired === undefined ? 'ml-4 list-disc text-err' : 'ml-4 list-disc'}>
          {plan.references?.map((r) => (
            <li key={`${r.from.file}-${r.from.id}-${r.field}`}>
              {nameOf(r.from)} still uses a record in this pack ({r.field})
            </li>
          ))}
        </ul>
      ) : null}
      {plan.records === undefined ? null : <div>{plan.records.length} records would be removed.</div>}
    </div>
  );
}

/** What releasing a pack hands over: records per kind and the pack's other files. */
export function ReleaseView({ plan }: { plan: PackReleasePlan }): JSX.Element {
  const kinds = Object.entries(plan.counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    <div data-testid="pack-release-plan">
      <p className="mt-0">
        Every record below keeps its id and content and becomes this hub&apos;s own: editable, renamable and deletable like any other.
        Designs that use them do not change. The pack is then listed as released, and it is never installed or updated over these records again.
      </p>
      <table className="w-full text-left text-xs">
        <thead><tr><th className="py-1 pr-3">Kind</th><th className="px-2">Records</th></tr></thead>
        <tbody>{kinds.map(([kind, n]) => <tr key={kind} className="border-t border-line"><th className="py-1 pr-3 font-normal">{RECORD_LABEL[kind] ?? kind.replaceAll('-', ' ')}</th><td className="px-2 tabular-nums">{n}</td></tr>)}</tbody>
      </table>
      {plan.files.length === 0 ? null : <p className="mt-2 text-dim">Also the hub&apos;s own: {plan.files.length} other file{plan.files.length === 1 ? '' : 's'} (drawing facts, settings, images, model links).</p>}
      {plan.blockers.map((b) => <div key={b} className="text-err">Cannot release: {b}.</div>)}
    </div>
  );
}

const sentence = (a: PackAnswer): string => `${a.error ?? `That failed (HTTP ${a.status}).`}${a.hint === undefined ? '' : ` ${a.hint}`}`;
const headline = (a: PackAnswer): string => a.error ?? `That failed (HTTP ${a.status}).`;

export function PacksPanel(): JSX.Element {
  const [packs, setPacks] = useState<InstalledPackView[] | undefined>(undefined);
  const notify = useNotify();
  /** the pending action: an update or disable preview of one pack, or an install preview */
  const [pending, setPending] = useState<{ kind: 'update' | 'disable' | 'install'; id: string; plan: PackPlan; applicable: boolean; source?: PackSource; sha256?: string; code?: CodePreviewView } | undefined>(undefined);
  const [url, setUrl] = useState('');
  /** a code module's publisher key, for an upload (pinned when it installs), and the owner's consent */
  const [trustKey, setTrustKey] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  // a viewer reads: no install, update or disable (the server refuses them too)
  const [canWrite, setCanWrite] = useState(true);
  // releasing a pack to the hub is the owners' (the server refuses anyone else)
  const [canRelease, setCanRelease] = useState(false);
  const [releasing, setReleasing] = useState<PackReleasePlan | undefined>(undefined);

  const [notices, setNotices] = useState<StoreNotice[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    const answer = await listPacks();
    if (answer.ok) setPacks(answer.body['packs'] as InstalledPackView[]);
    else notify.error(headline(answer), answer.hint);
    // the store's word on what is installed (yanked, revoked, flagged); best effort
    if (answer.ok && ((answer.body['packs'] as unknown[] | undefined) ?? []).length > 0) {
      const store = await listStore();
      setNotices(store.ok ? ((store.body['notices'] as StoreNotice[] | undefined) ?? []) : []);
    } else setNotices([]);
  }, [notify]);
  useEffect(() => {
    void reload();
    void loadMe().then((me) => {
      setCanWrite(me.role !== 'viewer');
      setCanRelease(me.role === undefined || me.role === 'owner');
    });
  }, [reload]);

  const finish = async (title: string, description: string | undefined, view: ViewTarget): Promise<void> => {
    setPending(undefined);
    notify.success(title, { ...(description === undefined || description === '' ? {} : { description }), view });
    await reload();
  };

  const showPlan = (answer: PackAnswer, kind: 'update' | 'disable' | 'install', id: string, source?: PackSource): void => {
    const plan = (answer.body['plan'] ?? answer.body) as PackPlan;
    if (!answer.ok && answer.body['plan'] === undefined && answer.body['problems'] === undefined) {
      notify.error(headline(answer), answer.hint);
      return;
    }
    const listed = answer.body['problems'] as string[] | undefined;
    const problems = listed !== undefined && listed.length > 0 ? listed : undefined;
    if (!answer.ok) notify.error(headline(answer), `${answer.hint ?? ''}${problems === undefined ? '' : ` ${problems.join('; ')}`}`.trim());
    if (problems !== undefined) return;
    setAgreed(false);
    const code = answer.body['code'] as CodePreviewView | undefined;
    setPending({ kind, id, plan, applicable: answer.body['applicable'] !== false && plan.ok, ...(source === undefined ? {} : { source }), ...(typeof answer.body['sha256'] === 'string' ? { sha256: answer.body['sha256'] } : {}), ...(code === undefined ? {} : { code }) });
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  /** packs whose Disable is waiting out its Undo window: shown as already gone */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leave = (id: string, going: boolean): void =>
    setLeaving((current) => {
      const next = new Set(current);
      if (going) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Disable cannot be put back (its records are removed), so it waits ten seconds, with Undo, before it happens */
  const disableWithUndo = (id: string): void => {
    setPending(undefined);
    leave(id, true);
    toastDeferred(`Disabled ${id}.`, async () => {
      const answer = await disablePack(id);
      leave(id, false);
      if (!answer.ok) notify.error(headline(answer), answer.hint);
      await reload();
    }, { onUndo: () => leave(id, false) });
  };

  const applyPending = (): Promise<void> =>
    run(async () => {
      if (pending === undefined) return;
      if (pending.kind === 'disable') {
        disableWithUndo(pending.id);
        return;
      }
      const major = pending.plan.major === true;
      const answer =
        pending.kind === 'update'
          ? await applyUpdate(pending.id, major)
          : await applyInstall(pending.source as PackSource, pending.sha256 ?? '', major, '/api', { trustKey, ...(pending.code === undefined ? {} : { consent: { code: pending.code.consent } }) });
      if (!answer.ok) {
        showPlan(answer, pending.kind, pending.id, pending.source);
        return;
      }
      const status = answer.body['moduleStatus'] as { state?: string; error?: string; restartPending?: boolean } | undefined;
      const codeNote = pending.code === undefined ? '' : status?.state === 'loaded' ? (pending.code.apply === 'live' ? ' Its code runs now.' : ' Its code runs now; its job queues start after Restart WireHub (Settings).') : ` Its code is not running: ${status?.error ?? 'see Settings, Code modules'}.`;
      const offersScheme = answer.body['offers'] !== undefined && (answer.body['offers'] as { partNumberScheme?: unknown }).partNumberScheme !== undefined;
      await finish(
        `${pending.kind === 'update' ? 'Updated' : 'Installed'} ${pending.plan.pack.name ?? 'catalog pack'}.`,
        `${codeNote}${offersScheme ? ' It offers a part-numbering scheme: an owner can review and switch to it in Settings, Part numbers. Nothing was switched.' : ''}`.trim(),
        pending.code === undefined ? { to: '/library' } : { to: '/extensions', tab: 'installed' },
      );
    });

  const startRelease = (id: string): Promise<void> =>
    run(async () => {
      const answer = await previewRelease(id);
      if (!answer.ok) {
        notify.error(headline(answer), answer.hint);
        return;
      }
      setReleasing(answer.body['plan'] as PackReleasePlan);
    });

  const confirmRelease = (): Promise<void> =>
    run(async () => {
      if (releasing === undefined) return;
      const answer = await applyRelease(releasing.pack.id);
      if (!answer.ok) {
        notify.error(headline(answer), answer.hint);
        return;
      }
      setReleasing(undefined);
      notify.success(`Released ${releasing.pack.name} to this hub.`, { description: `${releasing.records.length} records are this hub's own now, editable in the Library.`, view: { to: '/library' } });
      await reload();
    });

  return (
    <section className="cs-ext-section" data-testid="packs-panel">
      <h2 className="text-md font-semibold">Catalog packs</h2>
      {packs === undefined ? <div className="text-faint">Loading…</div> : packs.length === 0 ? <div className="text-faint">No packs are installed.</div> : null}
      <ul>
        {(packs ?? []).filter((p) => !leaving.has(p.id)).map((p) => (
          <li key={p.id} className="my-2 flex flex-wrap items-center gap-2 rounded border border-line p-3" data-pack={p.id}>
            <div className="min-w-0 flex-1"><b>{p.name ?? 'Catalog pack'}</b> <span className="text-dim">{p.version} · {p.license} · {p.records} records</span></div>
            <a href={`/library/connectors?pack=${encodeURIComponent(p.id)}`} className="cs-ui-btn" data-variant="secondary" data-size="xs">View contents</a>
            {notices
              .filter((n) => n.id === p.id && n.version === p.version)
              .map((n) => (
                <span key={n.index} role="alert" className="ml-2 border border-warn px-1 text-warn" data-pack-warning={p.id} title={noticeText(n)}>
                  {n.yanked !== undefined ? 'Yanked' : n.revoked !== undefined ? 'Revoked key' : 'Flagged'}: {noticeText(n)}{' '}
                  {n.suggest === undefined ? null : (
                    <AppLink to="/extensions" tab="browse" className="underline">
                      Update…
                    </AppLink>
                  )}
                </span>
              ))}
            {p.released === undefined ? null : (
              <span className="text-dim text-xs" data-pack-released={p.id}>
                Released to this hub {p.released.at.slice(0, 10)}{p.released.by === undefined ? '' : ` by ${p.released.by}`}: its records are the hub&apos;s own
              </span>
            )}
            {!canWrite || p.released !== undefined || p.available === undefined ? null : (
              <Button type="button" disabled={busy} onClick={() => void run(async () => showPlan(await previewUpdate(p.id), 'update', p.id))} className="ml-2">
                Update to {p.available}…
              </Button>
            )}
            {!canRelease || p.released !== undefined ? null : (
              <Button type="button" disabled={busy} onClick={() => void startRelease(p.id)} className="ml-2" title="Make its records this hub's own, editable in place">
                Release to this hub…
              </Button>
            )}
            {!canWrite || p.released !== undefined ? null : <Button type="button" disabled={busy} onClick={() => void run(async () => showPlan(await previewDisable(p.id), 'disable', p.id))} className="ml-2">
              Disable…
            </Button>}
          </li>
        ))}
      </ul>

      {!canWrite ? null : <div className="mt-2">
        <b>Install pack…</b> from a file (zip or JSON bundle) or an https address.
        <div className="mt-1">
          <FileDrop
            className="max-w-full"
            aria-label="Pack file"
            accept=".zip,.json,application/zip,application/json"
            disabled={busy}
            hint="ZIP or JSON catalog bundle"
            onFiles={(files) => {
              const file = files[0];
              if (file === undefined) return;
              void run(async () => {
                let source: PackSource;
                try {
                  source = await sourceOfFile(file);
                } catch {
                  notify.error('That file is neither a zip nor a JSON pack bundle.');
                  return;
                }
                showPlan(await previewInstall(source, '/api', { trustKey }), 'install', file.name, source);
              });
            }}
          >Choose a pack or drop it here</FileDrop>
        </div>
        <div className="mt-1">
          <Input
            aria-label="Publisher key for a code module"
            placeholder="Publisher key (RW…), only for a pack with code"
            title="Only for a code module from a file or an address: its publisher's public key, compared with the publisher another way (owners)."
            value={trustKey}
            onChange={(e) => setTrustKey(e.target.value)} className="w-80 max-w-full min-w-0"
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Input type="url" aria-label="Pack address" placeholder="https://…/pack.zip" value={url} onChange={(e) => setUrl(e.target.value)} className="w-80 max-w-full min-w-0" />
          <Button
            type="button"
            disabled={busy || url.trim() === ''} className="ml-2"
            onClick={() => void run(async () => showPlan(await previewInstall({ url: url.trim() }, '/api', { trustKey }), 'install', url.trim(), { url: url.trim() }))}
          >
            Fetch and preview
          </Button>
        </div>
      </div>}

      <Drawer
        open={pending !== undefined}
        title={pending === undefined ? '' : `${pending.kind === 'update' ? 'Update' : pending.kind === 'disable' ? 'Disable' : 'Install'} ${pending.plan.pack.name ?? 'catalog pack'}${pending.plan.pack.to ?? pending.plan.pack.version ? ` ${pending.plan.pack.to ?? pending.plan.pack.version}` : ''}`}
        onClose={() => setPending(undefined)}
        testId="pack-pending"
        footer={pending === undefined ? undefined : (
          <>
            <Button variant="primary" disabled={busy || !pending.applicable || (pending.code !== undefined && !agreed)} onClick={() => void applyPending()}>
              {pending.kind === 'update' ? 'Update' : pending.kind === 'disable' ? 'Disable pack' : 'Install'}
            </Button>
            <Button onClick={() => setPending(undefined)}>Cancel</Button>
            {pending.kind === 'disable' ? null : <BlockedReason plan={pending.plan} applicable={pending.applicable} />}
          </>
        )}
      >
        {pending === undefined ? null : (
          <>
            <PlanView plan={pending.plan} />
            {pending.code === undefined ? null : <CodeConsent code={pending.code} agreed={agreed} onAgree={setAgreed} />}
          </>
        )}
      </Drawer>

      <Drawer
        open={releasing !== undefined}
        title={releasing === undefined ? '' : `Release ${releasing.pack.name} ${releasing.pack.version} to this hub`}
        onClose={() => setReleasing(undefined)}
        testId="pack-release"
        footer={releasing === undefined ? undefined : (
          <>
            <Button variant="primary" disabled={busy || !releasing.ok} onClick={() => void confirmRelease()}>Release to this hub</Button>
            <Button onClick={() => setReleasing(undefined)}>Cancel</Button>
          </>
        )}
      >
        {releasing === undefined ? null : <ReleaseView plan={releasing} />}
      </Drawer>
    </section>
  );
}
