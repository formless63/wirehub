/**
 * The store half of `/settings` (`server/store-settings.ts`): the stores this hub
 * trusts. The deployment's are shown read-only ("set by the server"), with the
 * official one's state; an owner or editor adds a store (its URL and public key,
 * verified and previewed before saving), renames, disables, re-checks and removes
 * the ones added here. Browse store lists the packs of every enabled store.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { toast } from 'sonner';

import {
  fetchStoreKey,
  previewStoreSource,
  saveStoreSources,
  storeSourcesKey,
  storeSourcesQuery,
  userSourceInputs,
  type StorePreview,
  type StoreSourceInput,
  type StoreSourceView,
} from '../settings.browser.ts';
import { useStudio } from '../studio-context.tsx';

const OFFICIAL_TEXT = {
  trusted: 'signed: its key is built in and its packs are listed under Browse store',
  'not-signed-yet': 'not signed yet: this build has no public key for the official index, so it is not listed',
  'not-enabled': 'not enabled: this server\'s WIREHUB_STORE_INDEXES does not include it',
} as const;

const originText = (s: StoreSourceView): string => (s.origin === 'user' ? 'added here' : s.origin === 'official' ? 'official, set by the server' : 'set by the server');

export function StoreSourcesSettings(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(storeSourcesQuery);
  const view = query.data;
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [keyNote, setKeyNote] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<StorePreview | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ url: string; label: string } | undefined>(undefined);

  const say = (out: { message: string; hint?: string }): void => {
    toast.error(out.message, { description: out.hint });
  };
  const resetForm = (): void => {
    setUrl('');
    setKey('');
    setKeyNote(undefined);
    setPreview(undefined);
    setConfirmed(false);
    setLabel('');
  };
  const edited = (setter: (v: string) => void) => (e: { target: { value: string } }): void => {
    setter(e.target.value);
    setPreview(undefined);
    setConfirmed(false);
  };

  const fetchKey = async (): Promise<void> => {
    setBusy(true);
    const out = await fetchStoreKey(url.trim());
    setBusy(false);
    if (!out.ok) return say(out);
    setKey(out.value.publicKey);
    setKeyNote(out.value.notice);
    setPreview(undefined);
    setConfirmed(false);
  };
  const check = async (): Promise<void> => {
    setBusy(true);
    const out = await previewStoreSource(url.trim(), key.trim());
    setBusy(false);
    if (!out.ok) return say(out);
    setPreview(out.value);
    setConfirmed(false);
  };

  const save = async (sources: StoreSourceInput[], done: string): Promise<boolean> => {
    if (view === undefined) return false;
    setBusy(true);
    const out = await saveStoreSources(sources, view.etag);
    setBusy(false);
    if (!out.ok) {
      say(out);
      return false;
    }
    client.setQueryData(storeSourcesKey, out.value);
    toast.success(done);
    return true;
  };
  const add = async (): Promise<void> => {
    if (view === undefined || preview === undefined) return;
    const entry: StoreSourceInput = { url: preview.url, publicKey: preview.publicKey, ...(label.trim() === '' ? {} : { label: label.trim() }), enabled: true };
    if (await save([...userSourceInputs(view), entry], `Added ${label.trim() === '' ? preview.store.name : label.trim()}.`)) resetForm();
  };
  const change = (target: StoreSourceView, patch: Partial<StoreSourceInput> | null, done: string): Promise<boolean> =>
    save(
      userSourceInputs(view as NonNullable<typeof view>).flatMap((s) => (s.url !== target.url ? [s] : patch === null ? [] : [{ ...s, ...patch }])),
      done,
    );
  const recheck = async (s: StoreSourceView): Promise<void> => {
    setChecks((c) => ({ ...c, [s.url]: 'Checking…' }));
    const out = await previewStoreSource(s.url, undefined);
    setChecks((c) => ({ ...c, [s.url]: out.ok ? `Verified: ${out.value.store.name}, ${out.value.packs} pack${out.value.packs === 1 ? '' : 's'}.` : `${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}` }));
  };

  const canAdd = !readOnly && view?.allowUserSources === true;
  const input = 'rounded border border-line bg-panel px-2 py-1';

  return (
    <section className="mt-6 max-w-xl text-[12.5px]" data-testid="store-sources">
      <h2 className="mb-1 text-[13px] font-semibold">Store sources</h2>
      <p className="mb-2 text-faint">
        Stores whose packs show up under Browse store, next to the official one. Anyone can host a store; WireHub does not check what a store lists. Each store&apos;s index must be signed with the key you give here. To run a store of your own, start from the{' '}
        <a className="underline" href="https://github.com/formless63/wirehub/blob/main/docs/store-hosting.md" target="_blank" rel="noreferrer">
          run your own store
        </a>
        .
      </p>
      {query.isError ? <div role="alert">{query.error instanceof Error ? query.error.message : 'The stores could not be read.'}</div> : null}
      {view === undefined ? (
        query.isError ? null : <div className="text-faint">Loading…</div>
      ) : (
        <>
          <div data-testid="store-official" className="mb-2">
            <b>Official store</b>: {OFFICIAL_TEXT[view.official.state]}.
          </div>
          {(view.problems ?? []).map((p) => (
            <div key={p} role="alert" className="text-err">
              {p}
            </div>
          ))}
          {view.allowUserSources ? null : <div className="mb-2 text-faint">This server allows only the stores it names (WIREHUB_STORE_ALLOW_USER_SOURCES is off). Stores added here are not used.</div>}
          <ul className="mb-3 flex flex-col gap-2" aria-label="Configured stores">
            {view.sources.length === 0 ? <li className="text-faint">No store is configured.</li> : null}
            {view.sources.map((s) => (
              <li key={`${s.origin}-${s.url}`} className="border border-line p-2" data-store-source={s.url}>
                <div>
                  <b>{s.label ?? s.url}</b> <span className="text-faint">{originText(s)}</span>
                  {s.readOnly ? <span className="ml-2 border border-line px-1">set by the server</span> : null}
                  {s.origin === 'user' && !s.enabled ? <span className="ml-2 text-faint">disabled</span> : null}
                  {s.shadowed ? <span className="ml-2 text-faint">the server also names this store; its entry wins</span> : null}
                  {s.ignored ? <span className="ml-2 text-faint">not used</span> : null}
                </div>
                <div className="break-all text-faint">{s.url}</div>
                <div className="text-faint">Key {s.keyId} · fingerprint {s.fingerprint}</div>
                {checks[s.url] === undefined ? null : <div role="status">{checks[s.url]}</div>}
                <div className="mt-1 flex flex-wrap gap-3">
                  <button type="button" className="underline" disabled={busy} onClick={() => void recheck(s)}>
                    Re-check now
                  </button>
                  {s.readOnly || readOnly || !view.allowUserSources ? null : (
                    <>
                      <button type="button" className="underline" disabled={busy} onClick={() => void change(s, { enabled: !s.enabled }, s.enabled ? 'Disabled.' : 'Enabled.')}>
                        {s.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" aria-label={`Hide unreviewed versions from ${s.label ?? s.url}`} checked={s.hideUnreviewed === true} disabled={busy} onChange={(e) => void change(s, { hideUnreviewed: e.target.checked }, 'Review policy saved.')} />
                        Hide unreviewed versions
                      </label>
                      <button type="button" className="underline" disabled={busy} onClick={() => setRenaming({ url: s.url, label: s.label ?? '' })}>
                        Rename
                      </button>
                      <button type="button" className="underline" disabled={busy} onClick={() => void change(s, null, 'Removed. Packs installed from it stay installed.')}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
                {renaming?.url !== s.url ? null : (
                  <form
                    className="mt-1 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void change(s, renaming.label.trim() === '' ? { label: undefined as never } : { label: renaming.label.trim() }, 'Renamed.').then(() => setRenaming(undefined));
                    }}
                  >
                    <input className={input} aria-label="Store label" maxLength={80} value={renaming.label} onChange={(e) => setRenaming({ url: s.url, label: e.target.value })} />
                    <button type="submit" className="underline" disabled={busy}>
                      Save label
                    </button>
                    <button type="button" className="underline" onClick={() => setRenaming(undefined)}>
                      Cancel
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {!canAdd ? null : (
            <form
              className="flex flex-col gap-2 border border-line p-2"
              aria-label="Add a store"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <b>Add a store</b>
              <label className="flex flex-col gap-0.5">
                <span>Store index URL (https)</span>
                <input className={input} aria-label="Store index URL" placeholder="https://example.org/store/index.json" value={url} onChange={edited(setUrl)} />
              </label>
              <label className="flex flex-col gap-0.5">
                <span>Store public key (minisign, RW…)</span>
                <input className={input} aria-label="Store public key" placeholder="RW…" value={key} onChange={edited(setKey)} />
              </label>
              <div>
                <button type="button" className="underline" disabled={busy || url.trim() === ''} onClick={() => void fetchKey()}>
                  Fetch key from the store&apos;s wirehub-store.pub
                </button>
              </div>
              {keyNote === undefined ? null : (
                <div role="note" className="text-faint" data-testid="store-key-note">
                  {keyNote}
                </div>
              )}
              <div>
                <button type="button" className="underline" disabled={busy || url.trim() === '' || key.trim() === ''} onClick={() => void check()}>
                  Check store
                </button>
              </div>
              {preview === undefined ? null : (
                <div className="border border-line p-2" data-testid="store-preview">
                  <div>
                    <b>{preview.store.name}</b> <span className="text-faint">{preview.store.id}</span>
                  </div>
                  <div>
                    {preview.packs} pack{preview.packs === 1 ? '' : 's'} · publishers: {preview.publishers.length === 0 ? 'none named (packs are pinned by the index only)' : preview.publishers.map((p) => p.name).join(', ')}
                  </div>
                  <div>
                    Key {preview.keyId} · fingerprint <code>{preview.fingerprint}</code>
                  </div>
                  <div className="text-faint">The index is signed with this key. Whether the key belongs to the store you mean is for you to decide: you are trusting it on first use.</div>
                  {preview.alreadyConfigured ? <div role="alert" className="text-err">This store is already configured.</div> : null}
                  <label className="mt-1 flex items-center gap-2">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    <span>I have checked this fingerprint with the store&apos;s owner and trust this store.</span>
                  </label>
                  <label className="mt-1 flex flex-col gap-0.5">
                    <span>Label (optional)</span>
                    <input className={input} aria-label="Label" maxLength={80} placeholder={preview.store.name} value={label} onChange={(e) => setLabel(e.target.value)} />
                  </label>
                </div>
              )}
              <div>
                <button type="submit" disabled={busy || preview === undefined || !confirmed || preview.alreadyConfigured === true} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
                  Add store
                </button>
              </div>
            </form>
          )}
          {readOnly ? <div className="text-faint">Your role can view these settings but not change them.</div> : null}
        </>
      )}
    </section>
  );
}
