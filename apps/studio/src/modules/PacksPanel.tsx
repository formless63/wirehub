/**
 * Catalog packs on the modules page: what is installed, update with a diff,
 * disable, and "Install pack…" from a file or an https URL. Every change is
 * previewed first (the record-level diff), then applied as one change set by
 * the server; a refusal lists the references or problems that stopped it.
 * Writes need an owner or editor; a viewer's attempt answers with the server's
 * sentence.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { loadMe } from '../me.browser.ts';

import {
  applyInstall,
  applyUpdate,
  disablePack,
  listPacks,
  previewDisable,
  previewInstall,
  previewUpdate,
  sourceOfFile,
  type InstalledPackView,
  type PackAnswer,
  type PackDiff,
  type PackPlan,
  type PackSource,
} from '../packs.browser.ts';

const short = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 60 ? `${text.slice(0, 57)}…` : (text ?? '');
};

function DiffView({ diff }: { diff: PackDiff }): JSX.Element {
  return (
    <div data-testid="pack-diff" className="mt-1">
      <div>
        {diff.added.length} added · {diff.changed.length} changed · {diff.removed.length} removed · {diff.unchanged} unchanged
      </div>
      <ul className="ml-4 list-disc">
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
      </ul>
    </div>
  );
}

function PlanView({ plan }: { plan: PackPlan }): JSX.Element {
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

export function PacksPanel(): JSX.Element {
  const [packs, setPacks] = useState<InstalledPackView[] | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  /** the pending action: an update or disable preview of one pack, or an install preview */
  const [pending, setPending] = useState<{ kind: 'update' | 'disable' | 'install'; id: string; plan: PackPlan; applicable: boolean; source?: PackSource; sha256?: string } | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // a viewer reads: no install, update or disable (the server refuses them too)
  const [canWrite, setCanWrite] = useState(true);

  const reload = useCallback(async (): Promise<void> => {
    const answer = await listPacks();
    if (answer.ok) setPacks(answer.body['packs'] as InstalledPackView[]);
    else setMessage(sentence(answer));
  }, []);
  useEffect(() => {
    void reload();
    void loadMe().then((me) => setCanWrite(me.role !== 'viewer'));
  }, [reload]);

  const finish = async (text: string): Promise<void> => {
    setPending(undefined);
    setMessage(text);
    await reload();
  };

  const showPlan = (answer: PackAnswer, kind: 'update' | 'disable' | 'install', id: string, source?: PackSource): void => {
    const plan = (answer.body['plan'] ?? answer.body) as PackPlan;
    if (!answer.ok && answer.body['plan'] === undefined && answer.body['problems'] === undefined) {
      setMessage(sentence(answer));
      return;
    }
    const listed = answer.body['problems'] as string[] | undefined;
    const problems = listed !== undefined && listed.length > 0 ? listed : undefined;
    setMessage(answer.ok ? undefined : `${sentence(answer)}${problems === undefined ? '' : ` ${problems.join('; ')}`}`);
    if (problems !== undefined) return;
    setPending({ kind, id, plan, applicable: answer.body['applicable'] !== false && plan.ok, ...(source === undefined ? {} : { source }), ...(typeof answer.body['sha256'] === 'string' ? { sha256: answer.body['sha256'] } : {}) });
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
            : await applyInstall(pending.source as PackSource, pending.sha256 ?? '', major);
      if (!answer.ok) {
        showPlan(answer, pending.kind, pending.id, pending.source);
        return;
      }
      await finish(pending.kind === 'disable' ? `Disabled ${pending.id}.` : `${pending.kind === 'update' ? 'Updated' : 'Installed'} ${pending.id}.`);
    });

  return (
    <section className="mb-4 border-b border-line pb-3" data-testid="packs-panel">
      <h2 className="text-[13px] font-medium">Catalog packs</h2>
      {packs === undefined ? <div className="text-faint">Loading…</div> : packs.length === 0 ? <div className="text-faint">No packs are installed.</div> : null}
      <ul>
        {(packs ?? []).map((p) => (
          <li key={p.id} className="my-1" data-pack={p.id}>
            <b>{p.id}</b> {p.version} · {p.license} · {p.records} records
            {!canWrite || p.available === undefined ? null : (
              <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void run(async () => showPlan(await previewUpdate(p.id), 'update', p.id))}>
                Update to {p.available}…
              </button>
            )}
            {!canWrite ? null : <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void run(async () => showPlan(await previewDisable(p.id), 'disable', p.id))}>
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
                  setMessage('That file is neither a zip nor a JSON pack bundle.');
                  return;
                }
                showPlan(await previewInstall(source), 'install', file.name, source);
              });
            }}
          />
        </div>
        <div className="mt-1">
          <input type="url" aria-label="Pack address" placeholder="https://…/pack.zip" value={url} onChange={(e) => setUrl(e.target.value)} className="w-80 border border-line px-1" />
          <button
            type="button"
            className="ml-2 underline"
            disabled={busy || url.trim() === ''}
            onClick={() => void run(async () => showPlan(await previewInstall({ url: url.trim() }), 'install', url.trim(), { url: url.trim() }))}
          >
            Fetch and preview
          </button>
        </div>
      </div>}

      {message === undefined ? null : <div role="status" className="mt-2">{message}</div>}
      {pending === undefined ? null : (
        <div className="mt-2 border border-line p-2" data-testid="pack-pending">
          <b>
            {pending.kind === 'update' ? 'Update' : pending.kind === 'disable' ? 'Disable' : 'Install'} {pending.plan.pack.id}
            {pending.plan.pack.to ?? pending.plan.pack.version ? ` ${pending.plan.pack.to ?? pending.plan.pack.version}` : ''}
          </b>
          <PlanView plan={pending.plan} />
          <button type="button" disabled={busy || !pending.applicable} onClick={() => void confirm()} className="mr-2 underline">
            {pending.kind === 'update' ? 'Update' : pending.kind === 'disable' ? 'Disable pack' : 'Install'}
          </button>
          <button type="button" onClick={() => setPending(undefined)} className="underline">
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
