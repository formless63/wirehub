/**
 * Library → Browse store: the packs listed by the store indexes this hub trusts
 * (`WIREHUB_STORE_INDEXES`), each index's signature verified by the server. Search
 * and a domain filter; the licence and author shown as the author states them,
 * beside the store disclaimer. Install / Update previews the record-level diff
 * and applies it as one change set (the ordinary pack lifecycle). A viewer sees
 * the list but no buttons.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { loadMe } from '../me.browser.ts';
import { applyStoreInstall, listStore, previewStoreInstall, type PackAnswer, type PackPlan, type StoreIndexView, type StorePackView } from '../packs.browser.ts';
import { PlanView } from './PacksPanel.tsx';

const sentence = (a: PackAnswer): string => `${a.error ?? `That failed (HTTP ${a.status}).`}${a.hint === undefined ? '' : ` ${a.hint}`}`;
const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

interface Pending {
  pack: StorePackView;
  version: string;
  sha256: string;
  plan: PackPlan;
  applicable: boolean;
  kind: 'install' | 'update';
}

export function StoreBrowser(): JSX.Element {
  const [packs, setPacks] = useState<StorePackView[] | undefined>(undefined);
  const [indexes, setIndexes] = useState<StoreIndexView[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [disclaimer, setDisclaimer] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // a viewer reads the store; installing is for owners and editors (the server refuses too)
  const [canWrite, setCanWrite] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    const answer = await listStore();
    if (!answer.ok) {
      setPacks([]);
      setMessage(sentence(answer));
      return;
    }
    setPacks((answer.body['packs'] as StorePackView[]) ?? []);
    setIndexes((answer.body['indexes'] as StoreIndexView[]) ?? []);
    setDomains((answer.body['domains'] as string[]) ?? []);
    setDisclaimer(answer.body['disclaimer'] as string | undefined);
    setNotes([...((answer.body['problems'] as string[] | undefined) ?? []), ...(typeof answer.body['hint'] === 'string' ? [answer.body['hint']] : [])]);
  }, []);
  useEffect(() => {
    void reload();
    void loadMe().then((me) => setCanWrite(me.role !== 'viewer'));
  }, [reload]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
    return (packs ?? []).filter((p) => {
      if (domain !== '' && p.domain !== domain) return false;
      const text = `${p.id} ${p.name} ${p.description ?? ''} ${p.domain} ${p.author.name} ${p.license}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [packs, query, domain]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const preview = (pack: StorePackView): Promise<void> =>
    run(async () => {
      setMessage(undefined);
      const answer = await previewStoreInstall({ index: pack.index, id: pack.id });
      const plan = answer.body['plan'] as PackPlan | undefined;
      const from = answer.body['from'] as { version: string; sha256: string } | undefined;
      const problems = (answer.body['problems'] as string[] | undefined) ?? [];
      if (plan === undefined || from === undefined) {
        setMessage(`${sentence(answer)}${problems.length > 0 ? ` ${problems.join('; ')}` : ''}`);
        return;
      }
      if (!answer.ok) setMessage(sentence(answer));
      setPending({ pack, version: from.version, sha256: from.sha256, plan, applicable: answer.body['applicable'] !== false && plan.ok, kind: answer.body['kind'] === 'update' ? 'update' : 'install' });
    });

  const confirm = (): Promise<void> =>
    run(async () => {
      if (pending === undefined) return;
      const answer = await applyStoreInstall({ index: pending.pack.index, id: pending.pack.id, version: pending.version }, pending.sha256, pending.plan.major === true);
      if (!answer.ok) {
        setMessage(sentence(answer));
        return;
      }
      setPending(undefined);
      setMessage(`${pending.kind === 'update' ? 'Updated' : 'Installed'} ${pending.pack.id} ${pending.version}.`);
      await reload();
    });

  return (
    <section className="p-3" data-testid="store-browser">
      <h2 className="text-[13px] font-medium">Browse store</h2>
      {disclaimer === undefined ? null : (
        <p className="my-2 border border-line p-2 text-faint" data-testid="store-disclaimer">
          {disclaimer}
        </p>
      )}
      {indexes
        .filter((i) => !i.ok)
        .map((i) => (
          <div key={i.url} role="alert" className="text-err">
            {i.url}: {i.error}
          </div>
        ))}
      {notes.map((n) => (
        <div key={n} className="text-faint">{n}</div>
      ))}
      <div className="my-2 flex flex-wrap gap-2">
        <input type="search" aria-label="Search packs" placeholder="Search packs" value={query} onChange={(e) => setQuery(e.target.value)} className="w-64 border border-line px-1" />
        <select aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} className="border border-line px-1">
          <option value="">All domains</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      {packs === undefined ? <div className="text-faint">Loading…</div> : shown.length === 0 ? <div className="text-faint">{packs.length === 0 ? 'No packs to show.' : 'No pack matches.'}</div> : null}
      <ul>
        {shown.map((p) => (
          <li key={`${p.index} ${p.id}`} className="my-2" data-store-pack={p.id}>
            <div>
              <b>{p.name}</b> <span className="text-faint">{p.id}</span> {p.latest?.version ?? ''} · {p.domain} · by {p.author.name}
              {p.latest === undefined ? null : <> · {kb(p.latest.size)}</>} · <span title="As the author states it; not checked by WireHub">licence: {p.license}</span>
              {p.installed === undefined ? null : <> · installed {p.installed}</>}
            </div>
            {p.description === undefined ? null : <div className="text-faint">{p.description}</div>}
            <div className="text-faint">
              from {p.store.name}
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
              <button type="button" className="underline" disabled={busy} onClick={() => void preview(p)}>
                {p.action === 'install' ? 'Install…' : `Update to ${p.latest?.version ?? ''}…`}
              </button>
            )}
          </li>
        ))}
      </ul>
      {message === undefined ? null : <div role="status" className="mt-2">{message}</div>}
      {pending === undefined ? null : (
        <div className="mt-2 border border-line p-2" data-testid="store-pending">
          <b>
            {pending.kind === 'update' ? 'Update' : 'Install'} {pending.pack.id} {pending.version}
          </b>
          <div className="text-faint">Licence (as stated by the author): {pending.plan.pack.license}</div>
          <PlanView plan={pending.plan} />
          <button type="button" disabled={busy || !pending.applicable} onClick={() => void confirm()} className="mr-2 underline">
            {pending.kind === 'update' ? 'Update' : 'Install'}
          </button>
          <button type="button" onClick={() => setPending(undefined)} className="underline">
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
