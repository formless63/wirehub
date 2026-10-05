/**
 * `/products` and `/products/$id` (`docs/products.md`): the product families a hub sells, each a
 * group of designs with its variants, and the lineup across them.
 *
 * The list shows every family with its number, variants and problems, and the lineup tab every
 * variant as a row with its released revision, cost and route, downloadable as JSON or CSV. A
 * family's page lists its variants (each linked to its design), asks the numbering scheme for the
 * next variant number, adds a variant, merges other families in, splits variants off, and edits the
 * record as JSON. Every save is one change set and raises `product.changed`.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';
import type { LineupRow, ProductFamily } from '@wirehub/model';

import { RouteChip } from '../shell/RouteChip.tsx';
import { useStudio } from '../studio-context.tsx';
import {
  fetchLineup,
  fetchProductPage,
  fetchProducts,
  lineupKey,
  mergeProducts,
  nextVariantNumber,
  productKey,
  productsKey,
  saveProducts,
  splitProduct,
  unwrap,
  type ProductsView,
} from '../products.browser.ts';

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);
const EXAMPLE: ProductFamily = {
  id: 'example-product',
  label: 'Example product',
  partNumber: 'CBL-00100-XX',
  options: [{ id: 'colour', label: 'Colour', values: [{ id: 'black', label: 'Black' }] }],
  variants: [],
  src: 'synthetic example',
};

function money(row: Pick<LineupRow, 'cost' | 'currency'>): string {
  if (row.cost === undefined) return '';
  return `${row.cost.toFixed(2)}${row.currency === undefined ? '' : ` ${row.currency}`}`;
}

function LineupTable({ rows, showProduct }: { rows: LineupRow[]; showProduct: boolean }): JSX.Element {
  return (
    <table className="w-full max-w-5xl text-left" data-testid="lineup">
      <thead>
        <tr className="text-faint">
          {showProduct ? <th className="pr-3 font-normal">Product</th> : null}
          <th className="pr-3 font-normal">Variant</th>
          <th className="pr-3 font-normal">Number</th>
          <th className="pr-3 font-normal">Design</th>
          <th className="pr-3 font-normal">Length</th>
          <th className="pr-3 font-normal">Options</th>
          <th className="pr-3 font-normal">Released</th>
          <th className="pr-3 font-normal">Cost</th>
          <th className="pr-3 font-normal">Route</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.product}/${r.variant}`} data-variant={`${r.product}/${r.variant}`}>
            {showProduct ? (
              <td className="pr-3">
                <Link to="/products/$id" params={{ id: r.product }} className="underline">
                  {r.productLabel}
                </Link>
              </td>
            ) : null}
            <td className="pr-3">{r.variantLabel ?? r.variant}</td>
            <td className="pr-3 font-mono">{r.partNumber ?? ''}</td>
            <td className="pr-3">
              <Link to="/cables/$id" params={{ id: r.design }} search={{ view: 'build' }} className="underline">
                {r.designLabel ?? r.design}
              </Link>
            </td>
            <td className="pr-3">{r.lengthMm === undefined ? '' : `${r.lengthMm} mm`}</td>
            <td className="pr-3">{Object.entries(r.options).map(([k, v]) => `${k}: ${v}`).join(', ')}</td>
            <td className="pr-3">{r.releasedRev === undefined ? <span className="text-warn">none</span> : `Rev ${r.releasedRev}`}</td>
            <td className="pr-3">{money(r)}</td>
            <td className="pr-3">
              <RouteChip route={r.route} maker={r.maker} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProductsRoute(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const [tab, setTab] = useState<'families' | 'lineup'>('families');
  const [retired, setRetired] = useState(false);
  const query = useQuery({ queryKey: productsKey, queryFn: () => unwrap(fetchProducts()), retry: false });
  const lineup = useQuery({ queryKey: [...lineupKey, retired], queryFn: () => unwrap(fetchLineup(retired)), retry: false, enabled: tab === 'lineup' });
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const navigate = useNavigate();
  const view = query.data;

  const create = async (): Promise<void> => {
    if (view === undefined || editing === undefined) return;
    let record: ProductFamily;
    try {
      record = JSON.parse(editing) as ProductFamily;
    } catch (error) {
      toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
      return;
    }
    const out = await saveProducts([...view.local.filter((p) => p.id !== record.id), record], view.etag);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    client.setQueryData(productsKey, out.value);
    setEditing(undefined);
    toast.success(`Saved ${record.label}.`);
    void navigate({ to: '/products/$id', params: { id: record.id } });
  };

  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="products">
      <h1 className="mb-1 text-[14px] font-semibold">Products</h1>
      <p className="mb-2 max-w-2xl text-faint">
        The designs this hub sells, grouped: each family has its number, the names it is also known by, the options its builds differ on, and its variants — each documented by one design.
      </p>
      <nav className="mb-3 flex gap-3" role="tablist" aria-label="products">
        <button type="button" role="tab" aria-selected={tab === 'families'} className={tab === 'families' ? 'font-semibold underline' : 'text-dim'} onClick={() => setTab('families')}>
          Families
        </button>
        <button type="button" role="tab" aria-selected={tab === 'lineup'} className={tab === 'lineup' ? 'font-semibold underline' : 'text-dim'} onClick={() => setTab('lineup')}>
          Lineup
        </button>
      </nav>
      {tab === 'lineup' ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> include retired
            </label>
            <a className="underline" href={`/api/lineup${retired ? '?retired=1' : ''}`} download="lineup.json">
              Download JSON
            </a>
            <a className="underline" href={`/api/lineup.csv${retired ? '?retired=1' : ''}`} download="lineup.csv">
              Download CSV
            </a>
          </div>
          {lineup.data === undefined ? <div className="text-faint">{lineup.isError ? 'The lineup could not be read.' : 'Loading…'}</div> : <LineupTable rows={lineup.data.rows} showProduct />}
        </div>
      ) : view === undefined ? (
        <div className="text-faint">{query.isError ? 'The products could not be read.' : 'Loading…'}</div>
      ) : (
        <>
          {view.products.length === 0 ? <div className="text-faint">No products yet.</div> : null}
          <ul data-testid="product-list">
            {view.products.map((p) => {
              const problems = view.issues.filter((i) => i.where?.startsWith(`products/${p.id}`));
              return (
                <li key={p.id} className="my-1 border border-line p-2" data-product={p.id}>
                  <Link to="/products/$id" params={{ id: p.id }} className="font-semibold underline">
                    {p.label}
                  </Link>{' '}
                  {p.partNumber === undefined ? null : <code className="cs-mono">{p.partNumber}</code>} · {p.variants.length} variant{p.variants.length === 1 ? '' : 's'}
                  {p.origin === 'pack' ? <span className="text-faint"> · from pack {p.pack}</span> : null}
                  {(p.aliases ?? []).length === 0 ? null : <div className="text-faint">also: {(p.aliases ?? []).join(', ')}</div>}
                  {problems.length === 0 ? null : (
                    <div className={problems.some((i) => i.severity === 'error') ? 'text-err' : 'text-warn'}>
                      {problems.length} problem{problems.length === 1 ? '' : 's'}: {problems[0]!.message}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {readOnly ? null : editing === undefined ? (
            <button type="button" className="underline" onClick={() => setEditing(pretty(EXAMPLE))}>
              New product…
            </button>
          ) : (
            <div className="mt-2 max-w-3xl">
              <textarea className="h-64 w-full rounded border border-line bg-panel px-2 py-1 font-mono text-[11.5px]" aria-label="Product record" value={editing} spellCheck={false} onChange={(e) => setEditing(e.target.value)} />
              <div className="mt-1 flex gap-2">
                <button type="button" className="rounded border border-line bg-accent px-3 py-1 text-accent-ink" onClick={() => void create()}>
                  Save
                </button>
                <button type="button" className="underline" onClick={() => setEditing(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ProductRoute(): JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const client = useQueryClient();
  const studio = useStudio();
  const navigate = useNavigate();
  const readOnly = studio.me?.role === 'viewer';
  const page = useQuery({ queryKey: productKey(id), queryFn: () => unwrap(fetchProductPage(id)), retry: false });
  const list = useQuery({ queryKey: productsKey, queryFn: () => unwrap(fetchProducts()), retry: false });
  const [json, setJson] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<{ design: string; id: string; partNumber: string; lengthMm: string; options: Record<string, string> } | undefined>(undefined);
  const [mergeFrom, setMergeFrom] = useState<string[]>([]);
  const [splitPick, setSplitPick] = useState<string[]>([]);
  const [splitTo, setSplitTo] = useState({ id: '', label: '' });
  const product = page.data?.product;
  const others = useMemo(() => (list.data?.products ?? []).filter((p) => p.id !== id), [list.data, id]);

  const refresh = (view?: ProductsView): void => {
    if (view !== undefined) client.setQueryData(productsKey, view);
    void client.invalidateQueries({ queryKey: ['products'] });
  };
  const saveFamily = async (next: ProductFamily, done: string): Promise<boolean> => {
    const view = list.data;
    if (view === undefined) return false;
    const out = await saveProducts([...view.local.filter((p) => p.id !== next.id), next], view.etag);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return false;
    }
    refresh(out.value);
    toast.success(done);
    return true;
  };
  const suggest = async (): Promise<void> => {
    const out = await nextVariantNumber(id);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    if (out.value.suggestion === null) return void toast.info('The numbering scheme proposes no number for this family.');
    setAdding((a) => (a === undefined ? a : { ...a, partNumber: out.value.suggestion!.pn }));
    toast.message(out.value.suggestion.explanation);
  };

  if (page.isError) return <div className="p-4 text-err">There is no product called {id}.</div>;
  if (product === undefined) return <div className="p-4 text-faint">Loading…</div>;
  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="product-page">
      <div className="mb-1 text-faint">
        <Link to="/products" className="underline">
          Products
        </Link>{' '}
        /
      </div>
      <h1 className="mb-1 text-[14px] font-semibold">
        {product.label} {product.partNumber === undefined ? null : <code className="cs-mono">{product.partNumber}</code>}
      </h1>
      {(product.aliases ?? []).length === 0 ? null : <div className="text-faint">Also known as: {(product.aliases ?? []).join(', ')}</div>}
      {product.description === undefined ? null : <p className="max-w-2xl">{product.description}</p>}
      {page.data!.issues.length === 0 ? null : (
        <ul className="my-2" role="alert">
          {page.data!.issues.map((i) => (
            <li key={`${i.where}:${i.message}`} className={i.severity === 'error' ? 'text-err' : 'text-warn'}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-3 mb-1 text-[13px] font-semibold">Variants</h2>
      <LineupTable rows={page.data!.rows} showProduct={false} />
      {readOnly ? null : (
        <div className="mt-3 flex max-w-4xl flex-col gap-3">
          {adding === undefined ? (
            <button type="button" className="self-start underline" onClick={() => setAdding({ design: '', id: '', partNumber: '', lengthMm: '', options: {} })}>
              Add a variant…
            </button>
          ) : (
            <fieldset className="flex flex-wrap items-end gap-2 border border-line p-2" data-testid="add-variant">
              <legend>New variant</legend>
              <label className="flex flex-col">
                <span className="text-faint">Design</span>
                <select aria-label="Variant design" className="rounded border border-line bg-panel px-1 py-1" value={adding.design} onChange={(e) => setAdding({ ...adding, design: e.target.value, id: adding.id === '' ? e.target.value : adding.id })}>
                  <option value="">Pick a design…</option>
                  {studio.designs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col">
                <span className="text-faint">Variant id</span>
                <input aria-label="Variant id" className="rounded border border-line bg-panel px-1 py-1" value={adding.id} onChange={(e) => setAdding({ ...adding, id: e.target.value })} />
              </label>
              <label className="flex flex-col">
                <span className="text-faint">Number</span>
                <input aria-label="Variant number" className="rounded border border-line bg-panel px-1 py-1 font-mono" value={adding.partNumber} onChange={(e) => setAdding({ ...adding, partNumber: e.target.value })} />
              </label>
              <button type="button" className="underline" onClick={() => void suggest()}>
                Suggest
              </button>
              <label className="flex flex-col">
                <span className="text-faint">Length, mm</span>
                <input aria-label="Variant length" className="w-20 rounded border border-line bg-panel px-1 py-1" value={adding.lengthMm} onChange={(e) => setAdding({ ...adding, lengthMm: e.target.value })} />
              </label>
              {(product.options ?? []).map((axis) => (
                <label key={axis.id} className="flex flex-col">
                  <span className="text-faint">{axis.label}</span>
                  <select aria-label={`Variant ${axis.label}`} className="rounded border border-line bg-panel px-1 py-1" value={adding.options[axis.id] ?? ''} onChange={(e) => setAdding({ ...adding, options: { ...adding.options, [axis.id]: e.target.value } })}>
                    <option value="">—</option>
                    {axis.values.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <button
                type="button"
                className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50"
                disabled={adding.design === '' || adding.id === ''}
                onClick={() => {
                  const length = Number(adding.lengthMm);
                  const options = Object.fromEntries(Object.entries(adding.options).filter(([, v]) => v !== ''));
                  const variant = {
                    id: adding.id,
                    design: adding.design,
                    ...(adding.partNumber.trim() === '' ? {} : { partNumber: adding.partNumber.trim() }),
                    ...(adding.lengthMm.trim() !== '' && Number.isFinite(length) && length > 0 ? { lengthMm: length } : {}),
                    ...(Object.keys(options).length === 0 ? {} : { options }),
                  };
                  void saveFamily({ ...product, variants: [...product.variants, variant] }, `Added variant ${adding.id}.`).then((ok) => ok && setAdding(undefined));
                }}
              >
                Add
              </button>
              <button type="button" className="underline" onClick={() => setAdding(undefined)}>
                Cancel
              </button>
            </fieldset>
          )}
          {others.length === 0 ? null : (
            <fieldset className="flex flex-wrap items-center gap-2 border border-line p-2" data-testid="merge">
              <legend>Merge other products into this one</legend>
              {others.map((p) => (
                <label key={p.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={mergeFrom.includes(p.id)} onChange={(e) => setMergeFrom((m) => (e.target.checked ? [...m, p.id] : m.filter((x) => x !== p.id)))} /> {p.label}
                </label>
              ))}
              <button
                type="button"
                className="underline disabled:opacity-50"
                disabled={mergeFrom.length === 0}
                onClick={async () => {
                  const out = await mergeProducts(id, mergeFrom);
                  if (!out.ok) return void toast.error(out.message, { description: out.hint });
                  refresh(out.value);
                  setMergeFrom([]);
                  toast.success(`Merged ${mergeFrom.length} product${mergeFrom.length === 1 ? '' : 's'} into ${product.label}.`);
                }}
              >
                Merge
              </button>
            </fieldset>
          )}
          {product.variants.length < 2 ? null : (
            <fieldset className="flex flex-wrap items-center gap-2 border border-line p-2" data-testid="split">
              <legend>Split variants off into a new product</legend>
              {product.variants.map((v) => (
                <label key={v.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={splitPick.includes(v.id)} onChange={(e) => setSplitPick((m) => (e.target.checked ? [...m, v.id] : m.filter((x) => x !== v.id)))} /> {v.label ?? v.id}
                </label>
              ))}
              <input aria-label="New product id" placeholder="new id" className="rounded border border-line bg-panel px-1 py-1" value={splitTo.id} onChange={(e) => setSplitTo({ ...splitTo, id: e.target.value })} />
              <input aria-label="New product name" placeholder="name" className="rounded border border-line bg-panel px-1 py-1" value={splitTo.label} onChange={(e) => setSplitTo({ ...splitTo, label: e.target.value })} />
              <button
                type="button"
                className="underline disabled:opacity-50"
                disabled={splitPick.length === 0 || splitTo.id === ''}
                onClick={async () => {
                  const out = await splitProduct(id, splitPick, splitTo);
                  if (!out.ok) return void toast.error(out.message, { description: out.hint });
                  refresh(out.value);
                  setSplitPick([]);
                  toast.success(`Split ${splitPick.length} variant${splitPick.length === 1 ? '' : 's'} into ${splitTo.label || splitTo.id}.`);
                  void navigate({ to: '/products/$id', params: { id: splitTo.id } });
                }}
              >
                Split
              </button>
            </fieldset>
          )}
          {json === undefined ? (
            <button type="button" className="self-start underline" onClick={() => setJson(pretty(product))}>
              Edit as JSON…
            </button>
          ) : (
            <div>
              <textarea className="h-64 w-full rounded border border-line bg-panel px-2 py-1 font-mono text-[11.5px]" aria-label="Product record" value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  className="rounded border border-line bg-accent px-3 py-1 text-accent-ink"
                  onClick={() => {
                    try {
                      const next = JSON.parse(json) as ProductFamily;
                      void saveFamily(next, `Saved ${next.label}.`).then((ok) => ok && setJson(undefined));
                    } catch (error) {
                      toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
                    }
                  }}
                >
                  Save
                </button>
                <button type="button" className="underline" onClick={() => setJson(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
