import { AppLink } from '../shell/AppLink.tsx';
/**
 * Library → Browse store: the packs listed by the store indexes this hub trusts
 * (`WIREHUB_STORE_INDEXES`), each index's signature verified by the server. Search
 * and a domain filter; the licence and author shown as the author states them,
 * beside the store disclaimer. Install / Update previews the record-level diff
 * and applies it as one change set (the ordinary pack lifecycle). A viewer sees
 * the list but no buttons.
 *
 * Phase 5: who signs each pack (its publisher, or the index alone), each version's
 * review status as the index publisher states it, yanked versions (warned about, never
 * offered; an owner may install one anyway) and versions signed only by a revoked key.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { loadMe } from '../me.browser.ts';
import { applyStoreInstall, listStore, noticeText, previewStoreInstall, reviewText, type PackAnswer, type PackPlan, type StoreIndexView, type StoreNotice, type StorePackView, type StoreReviewView } from '../packs.browser.ts';
import { PlanView } from './PacksPanel.tsx';
import type { CodePreviewView } from '../code-modules.browser.ts';
import { CodeConsent } from './CodeConsent.tsx';
import { useNotify } from '../notify.ts';
import { Drawer } from '@wirehub/editor-react';

const headline = (a: PackAnswer): string => a.error ?? `That failed (HTTP ${a.status}).`;
const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

interface Pending {
  pack: StorePackView;
  version: string;
  sha256: string;
  plan: PackPlan;
  applicable: boolean;
  kind: 'install' | 'update';
  review?: StoreReviewView;
  yanked?: { reason: string };
  publisher?: string;
  force: boolean;
  /** a refusal that still shows the plan (it cannot be applied) */
  refusal?: string;
  /** the code module the pack carries: shown for consent before Install */
  code?: CodePreviewView;
}

export function StoreBrowser({ initialQuery = '', openPack }: { initialQuery?: string; openPack?: string } = {}): JSX.Element {
  const [packs, setPacks] = useState<StorePackView[] | undefined>(undefined);
  const [indexes, setIndexes] = useState<StoreIndexView[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [disclaimer, setDisclaimer] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState<string[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const [domain, setDomain] = useState('');
  const [kind, setKind] = useState('');
  // '' = every store
  const [storeUrl, setStoreUrl] = useState('');
  const notify = useNotify();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  // a viewer reads the store; installing is for owners and editors (the server refuses too)
  const [canWrite, setCanWrite] = useState(false);
  // only an owner installs a yanked version anyway (the server refuses anyone else)
  const [isOwner, setIsOwner] = useState(false);
  const [notices, setNotices] = useState<StoreNotice[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    const answer = await listStore();
    if (!answer.ok) {
      setPacks([]);
      notify.error(headline(answer), answer.hint);
      return;
    }
    setPacks((answer.body['packs'] as StorePackView[]) ?? []);
    setIndexes((answer.body['indexes'] as StoreIndexView[]) ?? []);
    setDomains((answer.body['domains'] as string[]) ?? []);
    setDisclaimer(answer.body['disclaimer'] as string | undefined);
    setNotices((answer.body['notices'] as StoreNotice[] | undefined) ?? []);
    const hidden = answer.body['hideUnreviewed'] === true ? Number(answer.body['hidden'] ?? 0) : 0;
    setNotes([
      ...((answer.body['problems'] as string[] | undefined) ?? []),
      ...(typeof answer.body['hint'] === 'string' ? [answer.body['hint']] : []),
      ...((answer.body['indexes'] as StoreIndexView[] | undefined) ?? []).filter((i) => i.hideUnreviewed === true).map((i) => `${i.label ?? i.url}: unreviewed versions are hidden.`),
      ...(answer.body['hideUnreviewed'] === true ? [`This hub shows only versions the store has reviewed${hidden > 0 ? ` (${hidden} pack${hidden === 1 ? '' : 's'} with none hidden)` : ''}.`] : []),
    ]);
  }, [notify]);
  useEffect(() => {
    void reload();
    void loadMe().then((me) => {
      setCanWrite(me.role !== 'viewer');
      setIsOwner(me.role === undefined || me.role === 'owner');
    });
  }, [reload]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
    return (packs ?? []).filter((p) => {
      if (domain !== '' && p.domain !== domain) return false;
      if (kind === 'code' && p.latest?.module === undefined) return false;
      if (kind === 'catalog' && p.latest?.module !== undefined) return false;
      if (storeUrl !== '' && p.index !== storeUrl) return false;
      const text = `${p.id} ${p.name} ${p.description ?? ''} ${p.domain} ${p.author.name} ${p.license}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [packs, query, domain, storeUrl, kind]);
  // the packs grouped by store, in the order the stores are listed (the server's first)
  const groups = useMemo(
    () =>
      indexes
        .filter((i) => i.ok)
        .map((i) => ({ index: i, packs: shown.filter((p) => p.index === i.url) }))
        .filter((g) => g.packs.length > 0),
    [indexes, shown],
  );
  const nameOf = (i: StoreIndexView): string => i.label ?? i.store?.name ?? i.url;

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const preview = (pack: StorePackView, forced?: string): Promise<void> =>
    run(async () => {
      const answer = await previewStoreInstall({ index: pack.index, id: pack.id, ...(forced === undefined ? {} : { version: forced, force: true }) });
      const plan = answer.body['plan'] as PackPlan | undefined;
      const from = answer.body['from'] as { version: string; sha256: string; review?: StoreReviewView; yanked?: { reason: string }; publisher?: string } | undefined;
      const problems = (answer.body['problems'] as string[] | undefined) ?? [];
      if (plan === undefined || from === undefined) {
        notify.error(headline(answer), `${answer.hint ?? ''}${problems.length > 0 ? ` ${problems.join('; ')}` : ''}`.trim());
        return;
      }
      setAgreed(false);
      const code = answer.body['code'] as CodePreviewView | undefined;
      setPending({
        ...(code === undefined ? {} : { code }),
        pack,
        version: from.version,
        sha256: from.sha256,
        plan,
        applicable: answer.body['applicable'] !== false && plan.ok,
        kind: answer.body['kind'] === 'update' ? 'update' : 'install',
        ...(from.review === undefined ? {} : { review: from.review }),
        ...(from.yanked === undefined ? {} : { yanked: from.yanked }),
        ...(from.publisher === undefined ? {} : { publisher: from.publisher }),
        force: forced !== undefined,
        ...(answer.ok ? {} : { refusal: `${headline(answer)}${answer.hint === undefined ? '' : ` ${answer.hint}`}` }),
      });
    });

  // the editor's node creator links here with a pack id: open that pack's install drawer once, when the list is in
  const autoOpened = useRef(false);
  useEffect(() => {
    if (openPack === undefined || autoOpened.current || packs === undefined) return;
    const pack = packs.find((p) => p.id === openPack && p.action !== 'current' && p.action !== 'unavailable');
    autoOpened.current = true;
    if (pack !== undefined) void preview(pack);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival
  }, [openPack, packs]);

  const confirm = (): Promise<void> =>
    run(async () => {
      if (pending === undefined) return;
      const answer = await applyStoreInstall({ index: pending.pack.index, id: pending.pack.id, version: pending.version, force: pending.force }, pending.sha256, pending.plan.major === true, '/api', pending.code === undefined ? undefined : { code: pending.code.consent });
      if (!answer.ok) {
        notify.error(headline(answer), answer.hint);
        return;
      }
      setPending(undefined);
      const status = answer.body['moduleStatus'] as { state?: string; error?: string } | undefined;
      const codeNote = pending.code === undefined ? '' : status?.state === 'loaded' ? (pending.code.apply === 'live' ? ' Its code runs now.' : ' Its code runs now; its job queues start after Restart WireHub (Settings).') : ` Its code is not running: ${status?.error ?? 'see Settings, Code modules'}.`;
      const offersScheme = answer.body['offers'] !== undefined && (answer.body['offers'] as { partNumberScheme?: unknown }).partNumberScheme !== undefined;
      const description = `${codeNote}${offersScheme ? ' It offers a part-numbering scheme: an owner can review and switch to it in Settings, Part numbers. Nothing was switched.' : ''}`.trim();
      notify.success(`${pending.kind === 'update' ? 'Updated' : 'Installed'} ${pending.pack.id} ${pending.version}.`, {
        ...(description === '' ? {} : { description }),
        view: pending.code === undefined ? { to: '/library' } : { to: '/settings', section: 'modules' },
      });
      await reload();
    });

  return (
    <section className="min-w-0 p-3 [overflow-wrap:anywhere]" data-testid="store-browser">
      <h1 className="text-base font-semibold">Modules & catalog packs</h1>
      <p className="mt-1 text-dim">Add tools with code modules or extend your Library with catalog packs. Every install starts with a preview; modules that run code require owner consent.</p>
      <nav aria-label="Store management" className="my-3 flex flex-wrap gap-2">
        <AppLink to="/settings" section="stores" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover">Configure stores</AppLink>
        <AppLink to="/settings" section="modules" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover">Manage installed modules</AppLink>
        <AppLink to="/modules" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover">Installed packs & uploads</AppLink>
      </nav>
      {disclaimer === undefined ? null : (
        <p className="my-2 border border-line p-2 text-dim" data-testid="store-disclaimer">
          {disclaimer}
        </p>
      )}
      {indexes
        .filter((i) => !i.ok)
        .map((i) => (
          <div key={i.url} role="alert" className="text-err" data-store-down={i.url}>
            {i.label ?? i.url}: {i.error} The other stores are still listed.
          </div>
        ))}
      {notes.map((n) => (
        <div key={n} className="text-dim">{n}</div>
      ))}
      <div className="my-2 flex flex-wrap gap-2">
        <input type="search" aria-label="Search modules and packs" placeholder="Search modules & packs" value={query} onChange={(e) => setQuery(e.target.value)} className="w-64 max-w-full min-w-0 rounded border border-line-field bg-panel px-2 py-1.5" />
        <select aria-label="Content type" value={kind} onChange={(e) => setKind(e.target.value)} className="max-w-full rounded border border-line-field bg-panel px-2 py-1.5">
          <option value="">Modules & catalog packs</option>
          <option value="code">Code modules</option>
          <option value="catalog">Catalog packs</option>
        </select>
        {indexes.filter((i) => i.ok).length < 2 ? null : (
          <select aria-label="Store" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} className="min-w-0 max-w-full rounded border border-line-field bg-panel px-2 py-1.5">
            <option value="">All stores</option>
            {indexes
              .filter((i) => i.ok)
              .map((i) => (
                <option key={i.url} value={i.url}>
                  {nameOf(i)}
                </option>
              ))}
          </select>
        )}
        <select aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} className="min-w-0 max-w-full rounded border border-line-field bg-panel px-2 py-1.5">
          <option value="">All domains</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      {packs === undefined ? <div className="text-dim">Loading…</div> : shown.length === 0 ? <div className="rounded border border-line p-3" role="status">
        {packs.length === 0 ? indexes.length === 0 ? 'No stores are configured. Configure a store to browse its modules and catalog packs.' : 'No modules or catalog packs are available from these stores. Check the store connection and review policy in Configure stores.' : kind === 'code' ? 'No code modules match. Only modules published to a configured store appear here; built-in modules are listed in Manage installed modules.' : 'No matching modules or catalog packs. Try another search or filter.'}
      </div> : null}
      {groups.map((g) => (
        <div key={g.index.url} data-store-group={g.index.url}>
          {groups.length < 2 && indexes.filter((i) => i.ok).length < 2 ? null : (
            <h3 className="mt-3 text-[12.5px] font-medium">
              {nameOf(g.index)} <span className="text-dim">{g.index.source === 'user' ? 'added here' : 'set by the server'} · {g.packs.length} item{g.packs.length === 1 ? '' : 's'}</span>
            </h3>
          )}
      <ul>
        {g.packs.map((p) => (
          <li key={`${p.index} ${p.id}`} className="my-3 rounded border border-line bg-panel p-3" data-store-pack={p.id}>
            <div>
              <b>{p.name}</b> <span className="text-dim">{p.id}</span> {p.latest?.version ?? ''} · {p.domain} · by {p.author.name}
              {p.latest === undefined ? null : <> · {kb(p.latest.size)}</>} · <span title="As the author states it; not checked by WireHub">licence: {p.license}</span>
              {p.latest?.module === undefined ? null : <span className="ml-2 rounded border border-line px-1" title={`Runs code. Permissions stated by the author: ${p.latest.module.permissions.join(', ') || 'none'}. Installation preview confirms the downloaded module and asks for owner consent.`}>Code module</span>}
              {p.installed === undefined ? null : <> · installed {p.installed}</>}
            </div>
            {p.description === undefined ? null : <div className="text-dim">{p.description}</div>}
            <div data-testid="store-trust">
              {p.publisher === undefined ? <span className="text-dim">not signed by a publisher (pinned by the index)</span> : <>signed by {p.publisher.name}</>}
              {p.latest === undefined ? null : (
                <>
                  {' · '}
                  <span className={p.latest.review?.status === 'flagged' ? 'text-err' : undefined} title="As the store states it; information, not checked by WireHub">
                    {reviewText(p.latest.review)}
                  </span>
                </>
              )}
            </div>
            {(p.releases ?? [])
              .filter((r) => r.yanked !== undefined || r.revoked === true)
              .map((r) => (
                <div key={r.version} role="note" className="text-err" data-store-warning={r.version}>
                  {r.yanked === undefined ? null : <>Version {r.version} was yanked: {r.yanked.reason}. It is not offered for install.</>}
                  {r.revoked === true ? <> Version {r.version} is signed only by a revoked key and cannot be installed.</> : null}
                  {canWrite && isOwner && r.yanked !== undefined && r.revoked !== true ? (
                    <button type="button" className="ml-2 rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover disabled:cursor-default disabled:opacity-50" disabled={busy} onClick={() => void preview(p, r.version)}>
                      Install {r.version} anyway…
                    </button>
                  ) : null}
                </div>
              ))}
            {notices
              .filter((n) => n.id === p.id && n.index === p.index)
              .map((n) => (
                <div key={`${n.index}-${n.version}`} role="alert" className="text-err">
                  Installed: {noticeText(n)}
                </div>
              ))}
            {p.action === 'other-store' ? (
              <div className="text-dim" data-store-note="other-store">
                Installed ({p.installed}) from another store; updates come from that store.
              </div>
            ) : null}
            {p.action === 'unavailable' ? <div className="text-dim">Every version is yanked; nothing is offered.</div> : null}
            <div className="text-dim">
              from {p.storeLabel ?? p.store.name}
              {p.homepage === undefined ? null : (
                <>
                  {' · '}
                  <a href={p.homepage} target="_blank" rel="noreferrer noopener" className="underline">
                    homepage
                  </a>
                </>
              )}
            </div>
            {!canWrite || (p.action !== 'install' && p.action !== 'update') ? null : (
              <button type="button" className="rounded border border-line bg-panel px-3 py-1.5 hover:bg-hover disabled:cursor-default disabled:opacity-50" disabled={busy} onClick={() => void preview(p)}>
                {p.action === 'install' ? 'Install…' : `Update to ${p.latest?.version ?? ''}…`}
              </button>
            )}
          </li>
        ))}
      </ul>
        </div>
      ))}
      <Drawer
        open={pending !== undefined}
        title={pending === undefined ? '' : `${pending.kind === 'update' ? 'Update' : 'Install'} ${pending.pack.id} ${pending.version}`}
        onClose={() => setPending(undefined)}
        testId="store-pending"
        footer={pending === undefined ? undefined : (
          <>
            <button type="button" disabled={busy || !pending.applicable || (pending.code !== undefined && !agreed)} onClick={() => void confirm()} className="cs-ui-btn is-primary">
              {pending.kind === 'update' ? 'Update' : 'Install'}
            </button>
            <button type="button" onClick={() => setPending(undefined)} className="cs-ui-btn">
              Cancel
            </button>
          </>
        )}
      >
        {pending === undefined ? null : (
          <div className="flex flex-col gap-1.5 text-[12px]">
            {pending.refusal === undefined ? null : <div role="alert" className="text-err">{pending.refusal}</div>}
            {pending.yanked === undefined ? null : (
              <div role="alert" className="text-err">
                This version was yanked: {pending.yanked.reason}. You are installing it anyway.
              </div>
            )}
            <PlanView plan={pending.plan} />
            <div className="text-dim">Licence (as stated by the author): {pending.plan.pack.license}</div>
            <div className="text-dim">
              {pending.publisher === undefined ? 'Not signed by a publisher; pinned by the index.' : `Signature of publisher ${pending.publisher} verified.`} Review: {reviewText(pending.review)}.
            </div>
            {pending.code === undefined ? null : <CodeConsent code={pending.code} agreed={agreed} onAgree={setAgreed} />}
          </div>
        )}
      </Drawer>
    </section>
  );
}
