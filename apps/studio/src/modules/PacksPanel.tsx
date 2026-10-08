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
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { loadMe } from '../me.browser.ts';

import {
  applyInstall,
  applyUpdate,
  disablePack,
  listPacks,
  listStore,
  noticeText,
  previewDisable,
  previewInstall,
  previewUpdate,
  sourceOfFile,
  type InstalledPackView,
  type PackAnswer,
  type PackDiff,
  type PackPlan,
  type PackSource,
  type StoreNotice,
} from '../packs.browser.ts';
import type { CodePreviewView } from '../code-modules.browser.ts';
import { CodeConsent } from './CodeConsent.tsx';
import { useNotify, type ViewTarget } from '../notify.ts';
import { Drawer } from '@wirehub/editor-react';

const short = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 60 ? `${text.slice(0, 57)}…` : (text ?? '');
};

function DiffView({ diff }: { diff: PackDiff }): JSX.Element {
  const [open, setOpen] = useState(false);
  const total = diff.added.length + diff.changed.length + diff.removed.length;
  return (
    <div data-testid="pack-diff" className="mt-1">
      <div className="flex flex-wrap gap-x-3" data-testid="pack-diff-counts">
        <span>{diff.added.length} added</span><span>{diff.changed.length} changed</span><span>{diff.removed.length} removed</span><span className="text-faint">{diff.unchanged} unchanged</span>
      </div>
      {total === 0 ? null : <button type="button" className="mt-1 text-dim underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide records' : 'Show all records'}</button>}
      {!open ? null : <ul className="ml-4 mt-1 list-disc">
        {diff.added.map((r) => (
          <li key={`a-${r.file}-${r.id}`}>added {r.kind} {r.id}</li>
        ))}
        {diff.changed.map((r) => (
          <li key={`c-${r.file}-${r.id}`}>
            changed {r.kind} {r.id}:{' '}
            {r.fields.map((f) => `${f.path}: ${f.before === undefined ? '(new)' : short(f.before)} → ${f.after === undefined ? '(dropped)' : short(f.after)}`).join('; ')}
          </li>
        ))}
        {diff.removed.map((r) => (
          <li key={`r-${r.file}-${r.id}`}>removed {r.kind} {r.id}</li>
        ))}
      </ul>}
    </div>
  );
}

export function PlanView({ plan }: { plan: PackPlan }): JSX.Element {
  return (
    <div>
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
          {plan.retired?.map((r) => r.id).join(', ')}.
        </div>
      ) : null}
      {(plan.references ?? []).length > 0 ? (
        <ul data-testid="pack-references" className={plan.retired === undefined ? 'ml-4 list-disc text-err' : 'ml-4 list-disc'}>
          {plan.references?.map((r) => (
            <li key={`${r.from.file}-${r.from.id}-${r.field}`}>
              {r.from.kind} {r.from.id} uses {r.to} ({r.field})
            </li>
          ))}
        </ul>
      ) : null}
      {plan.records === undefined ? null : <div>{plan.records.length} records would be removed.</div>}
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
    void loadMe().then((me) => setCanWrite(me.role !== 'viewer'));
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

  const confirm = (): Promise<void> =>
    run(async () => {
      if (pending === undefined) return;
      const major = pending.plan.major === true;
      const answer =
        pending.kind === 'update'
          ? await applyUpdate(pending.id, major)
          : pending.kind === 'disable'
            ? await disablePack(pending.id)
            : await applyInstall(pending.source as PackSource, pending.sha256 ?? '', major, '/api', { trustKey, ...(pending.code === undefined ? {} : { consent: { code: pending.code.consent } }) });
      if (!answer.ok) {
        showPlan(answer, pending.kind, pending.id, pending.source);
        return;
      }
      const status = answer.body['moduleStatus'] as { state?: string; error?: string; restartPending?: boolean } | undefined;
      const codeNote = pending.code === undefined ? '' : status?.state === 'loaded' ? (pending.code.apply === 'live' ? ' Its code runs now.' : ' Its code runs now; its job queues start after Restart WireHub (Settings).') : ` Its code is not running: ${status?.error ?? 'see Settings, Code modules'}.`;
      const offersScheme = answer.body['offers'] !== undefined && (answer.body['offers'] as { partNumberScheme?: unknown }).partNumberScheme !== undefined;
      await finish(
        pending.kind === 'disable' ? `Disabled ${pending.id}.` : `${pending.kind === 'update' ? 'Updated' : 'Installed'} ${pending.id}.`,
        `${codeNote}${offersScheme ? ' It offers a part-numbering scheme: an owner can review and switch to it in Settings, Part numbers. Nothing was switched.' : ''}`.trim(),
        pending.kind === 'disable' ? { to: '/modules' } : pending.code === undefined ? { to: '/library' } : { to: '/settings', section: 'modules' },
      );
    });

  return (
    <section className="mb-4 min-w-0 border-b border-line pb-3 [overflow-wrap:anywhere]" data-testid="packs-panel">
      <h2 className="text-[13px] font-medium">Catalog packs</h2>
      <p className="mb-2 text-faint">Installed catalog data and uploads. A pack may also carry a signed code module; its preview asks for owner consent before code can run.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        <AppLink to="/library/store" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover">Browse store</AppLink>
        <AppLink to="/settings" section="modules" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover">Manage code modules</AppLink>
        <AppLink to="/settings" section="stores" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover">Configure stores</AppLink>
      </div>
      {packs === undefined ? <div className="text-faint">Loading…</div> : packs.length === 0 ? <div className="text-faint">No packs are installed.</div> : null}
      <ul>
        {(packs ?? []).map((p) => (
          <li key={p.id} className="my-1" data-pack={p.id}>
            <b>{p.id}</b> {p.version} · {p.license} · {p.records} records
            {notices
              .filter((n) => n.id === p.id && n.version === p.version)
              .map((n) => (
                <span key={n.index} role="alert" className="ml-2 border border-warn px-1 text-warn" data-pack-warning={p.id} title={noticeText(n)}>
                  {n.yanked !== undefined ? 'Yanked' : n.revoked !== undefined ? 'Revoked key' : 'Flagged'}: {noticeText(n)}{' '}
                  {n.suggest === undefined ? null : (
                    <AppLink to="/library/store" className="underline">
                      Update…
                    </AppLink>
                  )}
                </span>
              ))}
            {!canWrite || p.available === undefined ? null : (
              <button type="button" className="ml-2 rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover disabled:cursor-default disabled:opacity-50" disabled={busy} onClick={() => void run(async () => showPlan(await previewUpdate(p.id), 'update', p.id))}>
                Update to {p.available}…
              </button>
            )}
            {!canWrite ? null : <button type="button" className="ml-2 rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover disabled:cursor-default disabled:opacity-50" disabled={busy} onClick={() => void run(async () => showPlan(await previewDisable(p.id), 'disable', p.id))}>
              Disable…
            </button>}
          </li>
        ))}
      </ul>

      {!canWrite ? null : <div className="mt-2">
        <b>Install pack…</b> from a file (zip or JSON bundle) or an https address.
        <div className="mt-1">
          <input
            type="file"
            className="max-w-full"
            aria-label="Pack file"
            accept=".zip,.json,application/zip,application/json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
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
          />
        </div>
        <div className="mt-1">
          <input
            aria-label="Publisher key for a code module"
            placeholder="Publisher key (RW…), for a pack with code"
            value={trustKey}
            onChange={(e) => setTrustKey(e.target.value)}
            className="w-80 max-w-full min-w-0 rounded border border-line bg-panel px-2 py-1.5"
          />{' '}
          <span className="text-faint">only for a code module from a file or address: its publisher's public key, compared with the publisher another way (owners)</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input type="url" aria-label="Pack address" placeholder="https://…/pack.zip" value={url} onChange={(e) => setUrl(e.target.value)} className="w-80 max-w-full min-w-0 rounded border border-line bg-panel px-2 py-1.5" />
          <button
            type="button"
            className="ml-2 rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover disabled:cursor-default disabled:opacity-50"
            disabled={busy || url.trim() === ''}
            onClick={() => void run(async () => showPlan(await previewInstall({ url: url.trim() }, '/api', { trustKey }), 'install', url.trim(), { url: url.trim() }))}
          >
            Fetch and preview
          </button>
        </div>
      </div>}

      <Drawer
        open={pending !== undefined}
        title={pending === undefined ? '' : `${pending.kind === 'update' ? 'Update' : pending.kind === 'disable' ? 'Disable' : 'Install'} ${pending.plan.pack.id}${pending.plan.pack.to ?? pending.plan.pack.version ? ` ${pending.plan.pack.to ?? pending.plan.pack.version}` : ''}`}
        onClose={() => setPending(undefined)}
        testId="pack-pending"
        footer={pending === undefined ? undefined : (
          <>
            <button type="button" disabled={busy || !pending.applicable || (pending.code !== undefined && !agreed)} onClick={() => void confirm()} className="cs-ui-btn is-primary">
              {pending.kind === 'update' ? 'Update' : pending.kind === 'disable' ? 'Disable pack' : 'Install'}
            </button>
            <button type="button" onClick={() => setPending(undefined)} className="cs-ui-btn">
              Cancel
            </button>
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
    </section>
  );
}
