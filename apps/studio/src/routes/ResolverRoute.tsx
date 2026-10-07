/**
 * `/resolver` — "Which cable do I need?" (`docs/resolver.md`).
 *
 * Pick the two devices and their ports; the resolver (`@wirehub/model`, run here on the loaded
 * library) lists every way to connect them, ranked by the hub's policy, each with its reasons,
 * hazards and missing pieces, and the ones it refuses with why. Pick one, a stock (the fitting
 * ones first) and a length, and Create makes it a design (status development, its recipe on it)
 * and opens it.
 *
 * The second tab edits the library the resolver reads: devices, conditioning recipes, hazards
 * and the ranking policy. Device and recipe fields share a draft with advanced JSON editing;
 * hazards and policy use JSON with examples. A pack's
 * records are read-only here; saving one under its id keeps this hub's own version.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';
import { deriveCable, resolve, resolveDevice, suggestStocks, validateDesign, type CableOption, type ConditioningRecipe, type DeviceProfile, type ResolveQuery } from '@wirehub/model';

import { dbKey } from '../queries.ts';
import { decideProposal, fetchPairProposals, fetchProposalDecisions, resolverKey, resolverQuery, saveResolverList, saveResolverPolicy, type ProposalRow, type ResolverList, type ResolverView } from '../resolver.browser.ts';
import { canEditFields, DeviceForm, RecipeForm } from './ResolverRecordForms.tsx';
import { useStudio } from '../studio-context.tsx';

import { RouteTabs } from './RouteTabs.tsx';

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);
const SRC = 'synthetic example';

type Tab = 'which' | 'proposals' | 'library';

export function ResolverRoute(): JSX.Element {
  const [tab, setTab] = useState<Tab>('which');
  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="resolver">
      <h1 className="mb-1 text-[14px] font-semibold">Which cable do I need?</h1>
      <RouteTabs id="resolver" label="resolver" items={[{ id: 'which', label: 'Find a cable' }, { id: 'proposals', label: 'Proposals' }, { id: 'library', label: 'Devices and recipes' }]} value={tab} onChange={setTab} />
      <div role="tabpanel" id={`resolver-panel-${tab}`} aria-labelledby={`resolver-tab-${tab}`}>
        {tab === 'which' ? <FindCable onOpenDevices={() => setTab('library')} /> : tab === 'proposals' ? <ProposalDecisions /> : <ResolverLibrary />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Find a cable
 * ------------------------------------------------------------------ */

function EndPicker(props: { label: string; devices: DeviceProfile[]; device: string; port: string; onChange: (device: string, port: string) => void }): JSX.Element {
  const resolved = props.device === '' ? undefined : resolveDevice(props.devices, props.device);
  const ports = resolved?.ports ?? [];
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-faint">{props.label}</legend>
      <select aria-label={`${props.label} device`} className="rounded border border-line bg-panel px-1 py-1" value={props.device} onChange={(e) => props.onChange(e.target.value, '')}>
        <option value="">Pick a device…</option>
        {props.devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
      {ports.length > 1 ? (
        <select aria-label={`${props.label} port`} className="rounded border border-line bg-panel px-1 py-1" value={props.port} onChange={(e) => props.onChange(props.device, e.target.value)}>
          <option value="">{ports[0]?.label ?? ports[0]?.id} (first)</option>
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label ?? p.id}
            </option>
          ))}
        </select>
      ) : ports.length === 1 ? (
        <span className="text-faint">{ports[0]!.label ?? ports[0]!.id}</span>
      ) : null}
    </fieldset>
  );
}

function OptionCard({ option, chosen, onChoose }: { option: CableOption; chosen: boolean; onChoose: () => void }): JSX.Element {
  return (
    <li className={`my-1 border p-2 ${chosen ? 'border-accent' : 'border-line'}`} data-option={option.id}>
      <label className="flex items-baseline gap-2">
        <input type="radio" name="option" checked={chosen} onChange={onChoose} aria-label={`Option ${option.rank}: ${option.label}`} />
        <b>
          {option.rank}. {option.label}
        </b>
        <span className="text-faint">
          {option.kind} · {option.conductors} conductor{option.conductors === 1 ? '' : 's'} · {option.parts} part{option.parts === 1 ? '' : 's'}
        </span>
      </label>
      <ul className="ml-6 list-disc">
        {option.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {option.hazards.map((h) => (
        <div key={h.message} className="ml-6 text-warn" role="note">
          Hazard: {h.message}
        </div>
      ))}
      {option.missing.map((m) => (
        <div key={m.message} className="ml-6 text-err" role="note">
          Missing: {m.message}
        </div>
      ))}
      {option.unverified.length === 0 ? null : <div className="ml-6 text-faint">Unconfirmed: {option.unverified.join('; ')}</div>}
      <details className="ml-6">
        <summary className="text-faint">Lines</summary>
        <table className="text-left">
          <tbody>
            {option.links.map((l) => (
              <tr key={`${l.from}-${l.to}`}>
                <td className="pr-2">{l.from}</td>
                <td className="pr-2">→ {l.to}</td>
                <td className="pr-2 text-faint">
                  {l.signal}
                  {l.toSignal !== undefined && l.toSignal !== l.signal ? ` → ${l.toSignal}` : ''}
                </td>
                <td className="text-faint">{l.recipes.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {option.notes.map((n) => (
          <div key={n} className="text-faint">
            {n}
          </div>
        ))}
      </details>
    </li>
  );
}

function FindCable({ onOpenDevices }: { onOpenDevices: () => void }): JSX.Element {
  const studio = useStudio();
  const navigate = useNavigate();
  const db = studio.db;
  const ends = useMemo(() => (db.devices ?? []).filter((d) => resolveDevice(db.devices, d.id)?.board === undefined && d.status !== 'retired'), [db.devices]);
  const [src, setSrc] = useState({ device: '', port: '' });
  const [dst, setDst] = useState({ device: '', port: '' });
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [stock, setStock] = useState('');
  const [length, setLength] = useState('1000');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const query: ResolveQuery | undefined =
    src.device === '' || dst.device === ''
      ? undefined
      : { source: { device: src.device, ...(src.port === '' ? {} : { port: src.port }) }, destination: { device: dst.device, ...(dst.port === '' ? {} : { port: dst.port }) } };
  const resolution = useMemo(() => (query === undefined ? undefined : resolve(db, query)), [db, query?.source.device, query?.source.port, query?.destination.device, query?.destination.port]);
  const option = resolution?.options.find((o) => o.id === chosen) ?? resolution?.options[0];
  useEffect(() => {
    setChosen(undefined);
    setStock('');
    setId('');
    setLabel('');
  }, [src.device, src.port, dst.device, dst.port]);
  const stocks = useMemo(() => (option === undefined ? [] : suggestStocks(db, option)), [db, option]);
  const lengthMm = Number(length);
  const derived = useMemo(() => {
    if (query === undefined || option === undefined) return undefined;
    return deriveCable(db, query, option.id, {
      ...(stock === '' ? {} : { stock }),
      ...(Number.isFinite(lengthMm) && lengthMm > 0 ? { lengthMm } : {}),
      ...(id === '' ? {} : { id }),
      ...(label === '' ? {} : { label }),
    });
  }, [db, query?.source.device, query?.source.port, query?.destination.device, query?.destination.port, option, stock, lengthMm, id, label]);
  const errors = derived?.ok ? validateDesign(derived.design, db).filter((i) => i.severity === 'error') : [];
  const taken = derived?.ok === true && studio.designs.some((d) => d.id === derived.design.id);

  const create = async (): Promise<void> => {
    if (derived === undefined || !derived.ok) return;
    setBusy(true);
    const out = await studio.persistence.create(derived.design);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    toast.success(`Created ${derived.design.label}.`);
    void navigate({ to: '/cables/$id', params: { id: derived.design.id }, search: { view: 'build' } });
  };

  if (ends.length === 0) {
    return (
      <section className="cs-route-empty" data-testid="resolver-empty" aria-label="Device profiles needed">
        <h2 className="mb-2 text-[13px] font-semibold">Add device profiles to find a cable</h2>
        <p className="text-dim">There are no device profiles available to connect yet. Add profiles here, or browse catalog packs that include them.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="cs-route-action cs-route-action-primary" onClick={onOpenDevices}>Device profiles</button>
          <Link to="/library/store" className="cs-route-action">Browse store</Link>
        </div>
      </section>
    );
  }
  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        <EndPicker label="From" devices={ends} device={src.device} port={src.port} onChange={(device, port) => setSrc({ device, port })} />
        <button
          type="button"
          className="cs-route-action mt-5"
          onClick={() => {
            setSrc(dst);
            setDst(src);
          }}
        >
          Swap
        </button>
        <EndPicker label="To" devices={ends} device={dst.device} port={dst.port} onChange={(device, port) => setDst({ device, port })} />
      </div>
      {resolution === undefined ? null : (
        <>
          {resolution.problems.map((p) => (
            <div key={p.message} role="alert" className="text-err">
              {p.message}
            </div>
          ))}
          <ol className="list-none p-0" data-testid="resolver-options">
            {resolution.options.map((o) => (
              <OptionCard key={o.id} option={o} chosen={o.id === option?.id} onChoose={() => setChosen(o.id)} />
            ))}
          </ol>
          {resolution.more > 0 ? <div className="text-faint">{resolution.more} more not shown (the policy's limit).</div> : null}
          {resolution.rejected.length === 0 ? null : (
            <details data-testid="resolver-rejected">
              <summary>Refused ({resolution.rejected.length})</summary>
              <ul>
                {resolution.rejected.map((r) => (
                  <li key={r.option.id}>
                    <b>{r.option.label}</b>: {r.why.map((w) => w.message).join('; ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {query === undefined || resolution.options.some((o) => o.missing.length === 0) ? null : <PairProposals query={query} />}
          {option === undefined ? null : (
            <section className="border-t border-line pt-2" data-testid="resolver-create">
              <h2 className="mb-1 text-[13px] font-semibold">Make it a design</h2>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col">
                  <span className="text-faint">Wire stock</span>
                  <select aria-label="Wire stock" className="rounded border border-line bg-panel px-1 py-1" value={stock} onChange={(e) => setStock(e.target.value)}>
                    <option value="">{stocks[0] === undefined ? 'none fits' : `${stocks[0].label} (suggested)`}</option>
                    {stocks.map((s) => (
                      <option key={s.id} value={s.id} title={s.reasons.join('; ')}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col">
                  <span className="text-faint">Length, mm</span>
                  <input aria-label="Length in millimetres" className="w-24 rounded border border-line bg-panel px-1 py-1" value={length} onChange={(e) => setLength(e.target.value)} />
                </label>
                <label className="flex flex-col">
                  <span className="text-faint">Id</span>
                  <input aria-label="Design id" className="rounded border border-line bg-panel px-1 py-1" placeholder={derived?.ok ? derived.design.id : ''} value={id} onChange={(e) => setId(e.target.value)} />
                </label>
                <label className="flex flex-col">
                  <span className="text-faint">Name</span>
                  <input aria-label="Design name" className="w-72 rounded border border-line bg-panel px-1 py-1" placeholder={derived?.ok ? derived.design.label : ''} value={label} onChange={(e) => setLabel(e.target.value)} />
                </label>
                <button
                  type="button"
                  className="cs-route-action cs-route-action-primary"
                  disabled={busy || derived === undefined || !derived.ok || errors.length > 0 || taken || studio.me?.role === 'viewer'}
                  onClick={() => void create()}
                >
                  Create design
                </button>
              </div>
              {derived === undefined ? null : derived.ok ? (
                <div className="mt-1 text-faint" data-testid="resolver-preview">
                  {derived.design.instances.connectors.length} plug{derived.design.instances.connectors.length === 1 ? '' : 's'}, {derived.design.instances.pcbas.length} board
                  {derived.design.instances.pcbas.length === 1 ? '' : 's'}, {derived.design.instances.components.length} part{derived.design.instances.components.length === 1 ? '' : 's'}, {derived.design.joints.length} joints.
                  {taken ? <span className="text-err"> A design called {derived.design.id} exists: give it another id.</span> : null}
                  {errors.map((e) => (
                    <div key={e.message} className="text-err">
                      {e.message}
                    </div>
                  ))}
                  {derived.missing.map((m) => (
                    <div key={m.message} className="text-err">
                      Missing: {m.message}
                    </div>
                  ))}
                </div>
              ) : (
                <div role="alert" className="mt-1 text-err">
                  {derived.reason}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Proposals: drafts for what nothing completes, and the decisions on them
 * ------------------------------------------------------------------ */

function PairProposals({ query }: { query: ResolveQuery }): JSX.Element | null {
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const key = ['resolver', 'proposals', query.source.device, query.source.port ?? '', query.destination.device, query.destination.port ?? ''];
  const client = useQueryClient();
  const found = useQuery({ queryKey: key, queryFn: async () => {
    const out = await fetchPairProposals(query);
    if (!out.ok) throw new Error(out.message);
    return out.value.proposals;
  }, retry: false });
  const [showDeclined, setShowDeclined] = useState(false);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [boardId, setBoardId] = useState<Record<string, string>>({});
  const rows = (found.data ?? []).filter((r) => showDeclined || r.state !== 'declined');
  if (found.data === undefined || found.data.length === 0) return null;
  const act = async (action: 'decline' | 'reopen' | 'accept', row: ProposalRow): Promise<void> => {
    const k = row.proposal.key;
    const out = await decideProposal(action, { key: k, proposal: row.proposal, ...(reason[k] ? { reason: reason[k] } : {}), ...(action === 'accept' ? { id: boardId[k] ?? '' } : {}) });
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    toast.success(action === 'decline' ? 'Declined: it will not be offered again.' : action === 'accept' ? 'Started a development board from it.' : 'Offered again.');
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['resolver', 'decisions'] });
    if (action === 'accept') void client.invalidateQueries({ queryKey: dbKey });
  };
  return (
    <section className="border-t border-line pt-2" data-testid="resolver-proposals">
      <h2 className="mb-1 text-[13px] font-semibold">Proposals</h2>
      <p className="mb-1 max-w-2xl text-faint">Nothing connects these completely. A board or adapter could; each draft lists its pads, its parts and what nobody has stated yet.</p>
      <label className="flex items-center gap-1 text-faint">
        <input type="checkbox" checked={showDeclined} onChange={(e) => setShowDeclined(e.target.checked)} /> show declined
      </label>
      <ul>
        {rows.map((row) => {
          const p = row.proposal;
          return (
            <li key={p.key} className="my-1 border border-line p-2" data-proposal={p.key} data-state={row.state}>
              <b>{p.title}</b> <span className="text-faint">· {row.state}{row.reason === undefined ? '' : ` (${row.reason})`}{row.pcba === undefined ? '' : ` → ${row.pcba}`}</span>
              {p.gap === undefined ? null : <div className="text-faint">{p.gap.message}</div>}
              <div>Pads: {p.pads.map((x) => x.id).join(', ')} · Parts: {p.parts.map((x) => `${x.ref} ${x.value ?? x.kind}`).join(', ')}</div>
              {p.open.map((o) => (
                <div key={o} className="text-warn">Open: {o}</div>
              ))}
              {readOnly || row.state === 'accepted' ? null : row.state === 'declined' ? (
                <button type="button" className="cs-route-action" onClick={() => void act('reopen', row)}>
                  Offer again
                </button>
              ) : (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input aria-label="Reason" placeholder="why not (optional)" className="rounded border border-line bg-panel px-1 py-0.5" value={reason[p.key] ?? ''} onChange={(e) => setReason({ ...reason, [p.key]: e.target.value })} />
                  <button type="button" className="cs-route-action" onClick={() => void act('decline', row)}>
                    Decline
                  </button>
                  <input aria-label="New board id" placeholder="new board id" className="rounded border border-line bg-panel px-1 py-0.5" value={boardId[p.key] ?? ''} onChange={(e) => setBoardId({ ...boardId, [p.key]: e.target.value })} />
                  <button type="button" className="cs-route-action" disabled={(boardId[p.key] ?? '') === ''} onClick={() => void act('accept', row)}>
                    Start a board
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProposalDecisions(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const list = useQuery({ queryKey: ['resolver', 'decisions'], queryFn: async () => {
    const out = await fetchProposalDecisions();
    if (!out.ok) throw new Error(out.message);
    return out.value.proposals;
  }, retry: false });
  if (list.data === undefined) return <div className="text-faint">{list.isError ? 'The proposals could not be read.' : 'Loading…'}</div>;
  if (list.data.length === 0) return <p className="text-faint" data-testid="proposal-decisions">No proposal has been filed, declined or accepted yet. Find a cable that nothing completes to see drafts.</p>;
  return (
    <ul className="max-w-3xl" data-testid="proposal-decisions">
      {list.data.map((d) => (
        <li key={d.key} className="my-1 border border-line p-2" data-state={d.state}>
          <b>{d.proposal.title}</b> <span className="text-faint">· {d.state}{d.reason === undefined ? '' : ` (${d.reason})`} · {d.by ?? ''} {d.at.slice(0, 10)}{d.pcba === undefined ? '' : ` → board ${d.pcba}`}</span>
          {me?.role === 'viewer' || d.state !== 'declined' ? null : (
            <button
              type="button"
              className="cs-route-action ml-2"
              onClick={async () => {
                const out = await decideProposal('reopen', { key: d.key });
                if (!out.ok) return void toast.error(out.message);
                void client.invalidateQueries({ queryKey: ['resolver'] });
              }}
            >
              Offer again
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * The library the resolver reads
 * ------------------------------------------------------------------ */

function firstInterface(view: ResolverView | undefined, db: { interfaces?: { id: string; bodies: string[] }[] }): { iface: string; body: string } {
  const i = db.interfaces?.[0];
  void view;
  return { iface: i?.id ?? 'an-interface', body: i?.bodies[0] ?? 'a-body' };
}

const EXAMPLES = (iface: string, body: string): Record<ResolverList, Record<string, unknown>> => ({
  devices: {
    id: 'example-device',
    label: 'Example device',
    kind: 'instrument',
    ports: [{ id: 'port-1', label: 'Port 1', interface: iface, body, role: 'both', pins: {} }],
    src: SRC,
  },
  recipes: {
    id: 'example-series-resistor',
    label: 'Example series resistor',
    conditioning: 'series-resistor',
    from: { level: 'dc-12v' },
    to: { level: 'dc-5v' },
    parts: [{ kind: 'resistor', value: '150 Ω', placement: 'series' }],
    src: SRC,
  },
  hazards: {
    id: 'example-no-12v-on-data',
    label: '12 V never onto data',
    severity: 'reject',
    a: { signals: ['pwr-12v'] },
    b: { kinds: ['data'] },
    text: '{a} must never meet {b}',
    src: SRC,
  },
});

function ListEditor({ list, title, view, records, readOnly, onSaved }: { list: ResolverList; title: string; view: ResolverView; records: ({ id: string; label?: string; origin: string; pack?: string; held?: boolean } & Record<string, unknown>)[]; readOnly: boolean; onSaved: (v: ResolverView) => void }): JSX.Element {
  const studio = useStudio();
  const [editing, setEditing] = useState<{ text: string; replaces?: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  let fields: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = editing === undefined ? undefined : JSON.parse(editing.text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && canEditFields(list, parsed as Record<string, unknown>)) fields = parsed as Record<string, unknown>;
  } catch { /* Advanced JSON can be temporarily incomplete. */ }
  const own = view.local[list];
  const strip = (r: Record<string, unknown>): Record<string, unknown> => {
    const { origin: _o, pack: _p, held: _h, ...rest } = r;
    return rest;
  };
  const persist = async (next: unknown[], done: string): Promise<boolean> => {
    setBusy(true);
    const out = await saveResolverList(list, next, view.etags[list]);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return false;
    }
    onSaved(out.value);
    toast.success(done);
    return true;
  };
  const save = async (): Promise<void> => {
    if (editing === undefined) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(editing.text) as Record<string, unknown>;
    } catch (error) {
      toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
      return;
    }
    const others = own.filter((r) => r['id'] !== (editing.replaces ?? record['id']) && r['id'] !== record['id']);
    if (await persist([...others, record], `Saved ${String(record['id'])}.`)) setEditing(undefined);
  };
  const { iface, body } = firstInterface(view, studio.db);
  return (
    <section className="mt-4 max-w-3xl border-t border-line pt-3" data-testid={`resolver-${list}`}>
      <h2 className="mb-1 text-[13px] font-semibold">
        {title} <span className="text-faint">{records.length}</span>
      </h2>
      {records.length === 0 ? <div className="text-faint">None yet.</div> : null}
      <ul>
        {records.map((r) => (
          <li key={r.id} className="my-1 border border-line p-2" data-record={r.id}>
            <b>{r.id}</b> {r.label === undefined ? null : <span>· {r.label}</span>}
            {r.origin === 'pack' ? <span className="text-faint"> · from pack {r.pack}{r.held ? ', edited here' : ''}</span> : null}
            {readOnly ? null : (
              <span className="ml-2 inline-flex gap-3">
                <button type="button" className="cs-route-action" onClick={() => setEditing({ text: pretty(strip(r)), replaces: r.id })}>
                  {r.origin === 'pack' && !r.held ? 'Override…' : 'Edit…'}
                </button>
                {r.origin === 'local' ? (
                  <button type="button" className="cs-route-action" disabled={busy} onClick={() => void persist(own.filter((x) => x['id'] !== r.id), `Removed ${r.id}.`)}>
                    Remove
                  </button>
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <button type="button" className="cs-route-action" onClick={() => setEditing({ text: pretty(EXAMPLES(iface, body)[list]) })}>
          New from an example…
        </button>
      )}
      {editing === undefined ? null : (
        <div className="mt-2">
          {fields === undefined ? null : list === 'devices' ? <DeviceForm record={fields as unknown as DeviceProfile} db={studio.db} onChange={(record) => setEditing({ ...editing, text: pretty(record) })} /> : list === 'recipes' ? <RecipeForm record={fields as unknown as ConditioningRecipe} db={studio.db} onChange={(record) => setEditing({ ...editing, text: pretty(record) })} /> : null}
          <details open={list === 'hazards' || fields === undefined} className="mt-2"><summary>Advanced JSON</summary>
            <textarea className="h-64 w-full rounded border border-line bg-panel px-2 py-1 font-mono text-[11.5px]" aria-label={`${title} record`} value={editing.text} spellCheck={false} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          </details>
          <div className="mt-1 flex gap-2">
            <button type="button" className="cs-route-action cs-route-action-primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="cs-route-action" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ResolverLibrary(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(resolverQuery);
  const view = query.data;
  const [policyText, setPolicyText] = useState<string | undefined>(undefined);
  const onSaved = (v: ResolverView): void => {
    client.setQueryData(resolverKey, v);
    void client.invalidateQueries({ queryKey: dbKey });
  };
  if (view === undefined) return <div className="text-faint">{query.isError ? 'The resolver library could not be read.' : 'Loading…'}</div>;
  const savePolicy = async (policy: unknown): Promise<void> => {
    const out = await saveResolverPolicy(policy, view.etags.policy);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    onSaved(out.value);
    setPolicyText(undefined);
    toast.success(policy === null ? 'The default ranking is back in force.' : 'Saved the ranking policy.');
  };
  return (
    <div>
      <p className="max-w-2xl text-faint">
        What the resolver knows: devices and their ports, the recipes that condition a line, the hazards it refuses or warns about, and the order it ranks options in. All data; a pack can ship
        every one of them.
      </p>
      {view.issues.length === 0 ? null : (
        <ul role="alert" className="mt-2 text-err">
          {view.issues.slice(0, 12).map((i) => (
            <li key={`${i.where}:${i.message}`}>
              {i.where}: {i.message}
            </li>
          ))}
        </ul>
      )}
      <ListEditor list="devices" title="Devices" view={view} records={view.devices as never} readOnly={readOnly} onSaved={onSaved} />
      <ListEditor list="recipes" title="Conditioning recipes" view={view} records={view.recipes as never} readOnly={readOnly} onSaved={onSaved} />
      <ListEditor list="hazards" title="Hazards" view={view} records={view.hazards.library as never} readOnly={readOnly} onSaved={onSaved} />
      <section className="mt-4 max-w-3xl border-t border-line pt-3" data-testid="resolver-builtin-hazards">
        <h2 className="mb-1 text-[13px] font-semibold">Built-in hazards</h2>
        <ul>
          {view.hazards.builtIn.map((h) => (
            <li key={h.id}>
              <b>{h.id}</b> · {h.severity} · {h.label}
            </li>
          ))}
        </ul>
        <div className="text-faint">A hazard of the same id above replaces one of these; enabled: false switches it off.</div>
      </section>
      <section className="mt-4 max-w-3xl border-t border-line pt-3" data-testid="resolver-policy">
        <h2 className="mb-1 text-[13px] font-semibold">Ranking</h2>
        <div>
          In force: {view.policy.inForce.order.join(' → ')} {view.policy.local === null ? <span className="text-faint">(the default)</span> : null}
        </div>
        <div className="text-faint">Criteria: {view.policy.criteria.join(', ')}</div>
        {readOnly ? null : policyText === undefined ? (
          <div className="mt-1 flex gap-3">
            <button type="button" className="cs-route-action" onClick={() => setPolicyText(pretty(view.policy.local ?? view.policy.default))}>
              Edit…
            </button>
            {view.policy.local === null ? null : (
              <button type="button" className="cs-route-action" onClick={() => void savePolicy(null)}>
                Use the default
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <textarea className="h-40 w-full rounded border border-line bg-panel px-2 py-1 font-mono text-[11.5px]" aria-label="Ranking policy" value={policyText} spellCheck={false} onChange={(e) => setPolicyText(e.target.value)} />
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                className="rounded border border-line bg-accent px-3 py-1 text-accent-ink"
                onClick={() => {
                  try {
                    void savePolicy(JSON.parse(policyText));
                  } catch (error) {
                    toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
                  }
                }}
              >
                Save
              </button>
              <button type="button" className="cs-route-action" onClick={() => setPolicyText(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
