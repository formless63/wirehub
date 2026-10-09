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
import { Button, Chip, Drawer, Input, RadioGroup } from '@wirehub/editor-react';

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
        view: pending.code === undefined ? { to: '/library' } : { to: '/extensions', tab: 'installed' },
      });
      await reload();
    });

  const okIndexes = indexes.filter((i) => i.ok);
  const kindOptions = [{ value: 'all', label: 'All' }, { value: 'catalog', label: 'Catalog packs' }, { value: 'code', label: 'Code modules' }];
  const counts = { catalog: (packs ?? []).filter((p) => p.latest?.module === undefined).length, code: (packs ?? []).filter((p) => p.latest?.module !== undefined).length };
  return (
    <section className="cs-ext-browse" data-testid="store-browser">
      <aside className="cs-ext-facets" aria-label="Filters">
        <Input type="search" aria-label="Search modules and packs" placeholder="Search packs and modules" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div>
          <h3 className="cs-ext-facet-head">Kind</h3>
          <RadioGroup aria-label="Content type" value={kind === '' ? 'all' : kind} onValueChange={(v) => setKind(v === 'all' ? '' : v)} options={kindOptions.map((o) => ({ ...o, label: o.value === 'all' ? o.label : `${o.label} (${counts[o.value as 'catalog' | 'code']})` }))} />
        </div>
        <div>
          <h3 className="cs-ext-facet-head">Domain</h3>
          <RadioGroup aria-label="Domain" value={domain === '' ? 'all' : domain} onValueChange={(v) => setDomain(v === 'all' ? '' : v)} options={[{ value: 'all', label: 'All domains' }, ...domains.map((d) => ({ value: d, label: d }))]} />
        </div>
        {okIndexes.length < 2 ? null : (
          <div>
            <h3 className="cs-ext-facet-head">Source</h3>
            <RadioGroup aria-label="Store" value={storeUrl === '' ? 'all' : storeUrl} onValueChange={(v) => setStoreUrl(v === 'all' ? '' : v)} options={[{ value: 'all', label: 'All stores' }, ...okIndexes.map((i) => ({ value: i.url, label: nameOf(i) }))]} />
          </div>
        )}
      </aside>
      <div className="cs-ext-results">
      {disclaimer === undefined ? null : (
        <p className="cs-ext-note" data-testid="store-disclaimer" title="A signature proves who published the index, not that its data is right.">
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
      {packs === undefined ? <div className="text-dim">Loading…</div> : shown.length === 0 ? <div className="text-dim" role="status">
        {packs.length === 0 ? indexes.length === 0 ? 'No stores are configured. Configure a store to browse its modules and catalog packs.' : 'No modules or catalog packs are available from these stores. Check the store connection and review policy in Sources.' : kind === 'code' ? 'No code modules match. Only modules published to a configured store appear here; built-in modules are listed under Installed.' : 'No matching modules or catalog packs. Try another search or filter.'}
      </div> : null}
      {groups.map((g) => (
        <div key={g.index.url} data-store-group={g.index.url}>
          {groups.length < 2 && okIndexes.length < 2 ? null : (
            <h3 className="cs-ext-group">
              {nameOf(g.index)} <span className="text-dim">{g.index.source === 'user' ? 'added here' : 'set by the server'} · {g.packs.length} item{g.packs.length === 1 ? '' : 's'}</span>
            </h3>
          )}
      <ul className="cs-ext-grid">
        {g.packs.map((p) => (
          <li key={`${p.index} ${p.id}`} className="cs-ext-card" data-store-pack={p.id}>
            <div className="cs-ext-card-top">
              <span className="cs-ext-glyph" aria-hidden>{p.name.split(/[\s&/-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')}</span>
              <div className="min-w-0">
                <h3 className="cs-ext-card-name">{p.name}</h3>
                <div className="cs-ext-card-sub">{p.id} {p.latest?.version ?? ''}{p.latest === undefined ? '' : ` · ${kb(p.latest.size)}`}{p.installed === undefined ? '' : ` · installed ${p.installed}`}</div>
              </div>
            </div>
            {p.description === undefined ? null : <p className="cs-ext-card-desc">{p.description}</p>}
            <div className="cs-ext-chips">
              {p.latest?.module === undefined ? <Chip>Pack</Chip> : <Chip tone="info" title={`Runs code. Permissions stated by the author: ${p.latest.module.permissions.join(', ') || 'none'}. Installation preview confirms the downloaded module and asks for owner consent.`}>Code module</Chip>}
              <Chip title="As the author states it; not checked by WireHub">{`licence: ${p.license}`}</Chip>
              <Chip>{p.domain}</Chip>
              {p.installed === undefined ? null : <Chip tone="ok">Installed</Chip>}
            </div>
            <div className="cs-ext-card-meta">by {p.author.name}</div>
            <div className="cs-ext-card-meta" data-testid="store-trust">
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
                    <Button size="xs" className="ml-2" disabled={busy} onClick={() => void preview(p, r.version)}>
                      Install {r.version} anyway…
                    </Button>
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
            <div className="cs-ext-card-foot">
              <span className="text-dim">
                from {p.storeLabel ?? p.store.name}
                {p.homepage === undefined ? null : (
                  <>
                    {' · '}
                    <a href={p.homepage} target="_blank" rel="noreferrer noopener" className="underline">
                      homepage
                    </a>
                  </>
                )}
              </span>
              {!canWrite || (p.action !== 'install' && p.action !== 'update') ? null : (
                <Button size="xs" variant={p.action === 'install' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void preview(p)}>
                  {p.action === 'install' ? 'Install…' : `Update to ${p.latest?.version ?? ''}…`}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
        </div>
      ))}
      </div>
      <Drawer
        open={pending !== undefined}
        title={pending === undefined ? '' : `${pending.kind === 'update' ? 'Update' : 'Install'} ${pending.pack.id} ${pending.version}`}
        onClose={() => setPending(undefined)}
        testId="store-pending"
        footer={pending === undefined ? undefined : (
          <>
            <Button variant="primary" disabled={busy || !pending.applicable || (pending.code !== undefined && !agreed)} onClick={() => void confirm()}>
              {pending.kind === 'update' ? 'Update' : 'Install'}
            </Button>
            <Button onClick={() => setPending(undefined)}>Cancel</Button>
          </>
        )}
      >
        {pending === undefined ? null : (
          <div className="flex flex-col gap-1.5 text-xs">
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
