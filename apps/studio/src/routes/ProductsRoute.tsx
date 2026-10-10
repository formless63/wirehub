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
import { Button, Callout, Checkbox, Chip, DataTable, Field, Input, KeyValues, Page, PageBody, Select, SidePanel, Tab, TabList, TabPanel, Tabs, Textarea, Toolbar, type DataColumn } from '@wirehub/editor-react';

import { cableListKey, dbKey } from '../queries.ts';
import { EmptyState } from '../shell/EmptyState.tsx';
import { RouteChip } from '../shell/RouteChip.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { useStudio } from '../studio-context.tsx';
import {
  fetchLineup,
  fetchProductPage,
  fetchProducts,
  lineupKey,
  mergeProducts,
  type ProductView,
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

const lineupId = (r: LineupRow): string => `${r.product}/${r.variant}`;

function lineupColumns(showProduct: boolean): DataColumn<LineupRow>[] {
  return [
    ...(showProduct
      ? [{ id: 'product', header: 'Product', width: 150, sortValue: (r: LineupRow) => r.productLabel, cell: (r: LineupRow) => (
          <Link to="/products/$id" params={{ id: r.product }} className="underline">
            {r.productLabel}
          </Link>
        ) }]
      : []),
    { id: 'variant', header: 'Variant', width: 130, sortValue: (r) => r.variantLabel ?? r.variant, cell: (r) => r.variantLabel ?? r.variant },
    { id: 'number', header: 'Number', width: 130, mono: true, sortValue: (r) => r.partNumber ?? '', cell: (r) => r.partNumber ?? '' },
    { id: 'design', header: 'Design', width: 220, sortValue: (r) => r.designLabel ?? r.design, cell: (r) => (
      <Link to="/cables/$id" params={{ id: r.design }} search={{ view: 'build' }} className="underline">
        {r.designLabel ?? r.design}
      </Link>
    ) },
    { id: 'length', header: 'Length', width: 90, numeric: true, sortValue: (r) => r.lengthMm ?? 0, cell: (r) => (r.lengthMm === undefined ? '' : `${r.lengthMm} mm`) },
    { id: 'options', header: 'Options', width: 160, cell: (r) => Object.entries(r.options).map(([k, v]) => `${k}: ${v}`).join(', ') },
    { id: 'released', header: 'Released', width: 100, sortValue: (r) => r.releasedRev ?? 0, cell: (r) => (r.releasedRev === undefined ? <span className="text-warn">none</span> : `Rev ${r.releasedRev}`) },
    { id: 'cost', header: 'Cost', width: 100, numeric: true, sortValue: (r) => r.cost ?? 0, cell: (r) => money(r) },
    { id: 'route', header: 'Route', width: 110, cell: (r) => <RouteChip route={r.route} maker={r.maker} /> },
  ];
}
const LINEUP_ALL = lineupColumns(true);
const LINEUP_ONE = lineupColumns(false);

function LineupTable({ rows, showProduct, loading }: { rows: LineupRow[]; showProduct: boolean; loading?: boolean }): JSX.Element {
  return (
    <DataTable
      loading={loading === true}
      label="Lineup"
      testId="lineup"
      className={showProduct ? undefined : 'cs-ui-dt-inline'}
      rows={rows}
      columns={showProduct ? LINEUP_ALL : LINEUP_ONE}
      getRowId={lineupId}
      columnsKey={showProduct ? 'lineup' : 'variants'}
      rowAttrs={(r) => ({ 'data-variant': lineupId(r) })}
      empty={<EmptyState topic="products">No variants yet.</EmptyState>}
    />
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
  const [selected, setSelected] = useState<string>();
  const navigate = useNavigate();
  const view = query.data;
  const selectedProduct = view?.products.find((p) => p.id === selected);

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
    void client.invalidateQueries({ queryKey: dbKey });
    void client.invalidateQueries({ queryKey: cableListKey });
    setEditing(undefined);
    toast.success(`Saved ${record.label}.`);
    void navigate({ to: '/products/$id', params: { id: record.id } });
  };

  const problemsOf = (p: ProductView) => (view?.issues ?? []).filter((i) => i.where?.startsWith(`products/${p.id}`));
  const familyColumns = useMemo((): DataColumn<ProductView>[] => [
    { id: 'product', header: 'Product', width: 240, sortValue: (p) => p.label, cell: (p) => (
      <Link to="/products/$id" params={{ id: p.id }} className="font-semibold underline">
        {p.label}
      </Link>
    ) },
    { id: 'number', header: 'Number', width: 130, mono: true, sortValue: (p) => p.partNumber ?? '', cell: (p) => p.partNumber ?? '' },
    { id: 'variants', header: 'Variants', width: 90, numeric: true, sortValue: (p) => p.variants.length, cell: (p) => String(p.variants.length) },
    { id: 'aliases', header: 'Also known as', width: 200, cell: (p) => (p.aliases ?? []).join(', ') },
    { id: 'origin', header: 'Origin', width: 130, cell: (p) => (p.origin === 'pack' ? `pack ${p.pack}` : '') },
    { id: 'problems', header: 'Problems', width: 220, cell: (p) => {
      const problems = problemsOf(p);
      return problems.length === 0 ? '' : <span className={problems.some((i) => i.severity === 'error') ? 'text-err' : 'text-warn'}>{problems.length} {problems.length === 1 ? 'problem' : 'problems'}: {problems[0]!.message}</span>;
    } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [view]);

  return (
    <Page testId="products">
      <RouteHeader
        title="Products"
        count={view === undefined ? undefined : `${view.products.length} ${view.products.length === 1 ? 'product' : 'products'}`}
        primary={readOnly ? undefined : <Button variant="primary" disabled={view === undefined || editing !== undefined} onClick={() => { setTab('families'); setEditing(pretty(EXAMPLE)); }}>New product…</Button>}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'families' | 'lineup')} className="flex min-h-0 flex-1 flex-col">
        <TabList aria-label="products" className="px-4">
          <Tab value="families">Families</Tab>
          <Tab value="lineup">Lineup</Tab>
        </TabList>
        <TabPanel value="families" className="flex min-h-0 flex-1 flex-col">
          <PageBody
            panel={
              selectedProduct === undefined ? undefined : (
                <SidePanel
                  title={selectedProduct.label}
                  subtitle={selectedProduct.id}
                  chips={selectedProduct.origin === 'pack' ? <Chip>{`pack ${selectedProduct.pack}`}</Chip> : undefined}
                  onClose={() => setSelected(undefined)}
                  label="Product details"
                  footer={<Link to="/products/$id" params={{ id: selectedProduct.id }} className="cs-ui-btn is-primary no-underline">Open</Link>}
                >
                  <div className="flex flex-col gap-3">
                    <KeyValues items={[['Number', selectedProduct.partNumber ?? '—'], ['Variants', String(selectedProduct.variants.length)], ['Also known as', (selectedProduct.aliases ?? []).join(', ') || '—']]} />
                    {problemsOf(selectedProduct).map((i) => (
                      <Callout key={`${i.where}:${i.message}`} tone={i.severity === 'error' ? 'err' : 'warn'}>{i.message}</Callout>
                    ))}
                  </div>
                </SidePanel>
              )
            }
          >
            {view === undefined && query.isError ? (
              <div className="px-4 py-3 text-faint">The products could not be read.</div>
            ) : (
              <>
                {view === undefined || readOnly || editing === undefined ? null : (
                  <div className="flex max-w-3xl flex-col gap-2 p-4">
                    <Textarea mono rows={14} aria-label="Product record" value={editing} spellCheck={false} onChange={(e) => setEditing(e.target.value)} />
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={() => void create()}>Save</Button>
                      <Button onClick={() => setEditing(undefined)}>Cancel</Button>
                    </div>
                  </div>
                )}
                <DataTable
                  loading={view === undefined}
                  label="Product families"
                  testId="product-list"
                  rows={view?.products ?? []}
                  columns={familyColumns}
                  getRowId={(p) => p.id}
                  selectedId={selected}
                  onSelect={(p) => setSelected(p.id)}
                  onActivate={(p) => void navigate({ to: '/products/$id', params: { id: p.id } })}
                  columnsKey="products"
                  rowAttrs={(p) => ({ 'data-product': p.id })}
                  empty={<EmptyState topic="products" action={readOnly ? undefined : <Button variant="primary" disabled={editing !== undefined} onClick={() => setEditing(pretty(EXAMPLE))}>Create your first product</Button>}>Group your assembly designs into a product family and its variants.</EmptyState>}
                />
              </>
            )}
          </PageBody>
        </TabPanel>
        <TabPanel value="lineup" className="flex min-h-0 flex-1 flex-col">
          <Toolbar label="Lineup options">
            <Checkbox checked={retired} onCheckedChange={setRetired} label="Include retired" />
            <a className="text-xs underline" href={`/api/lineup${retired ? '?retired=1' : ''}`} download="lineup.json">
              Download JSON
            </a>
            <a className="text-xs underline" href={`/api/lineup.csv${retired ? '?retired=1' : ''}`} download="lineup.csv">
              Download CSV
            </a>
          </Toolbar>
          <PageBody>
            {lineup.data === undefined && lineup.isError ? <div className="px-4 py-3 text-faint">The lineup could not be read.</div> : <LineupTable rows={lineup.data?.rows ?? []} showProduct loading={lineup.data === undefined} />}
          </PageBody>
        </TabPanel>
      </Tabs>
    </Page>
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
    void client.invalidateQueries({ queryKey: dbKey });
    void client.invalidateQueries({ queryKey: cableListKey });
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

  if (page.isError) return <Page><RouteHeader title="Product not found" /><PageBody padded><p className="text-err">There is no product called {id}.</p></PageBody></Page>;
  if (product === undefined) return <Page><RouteHeader title="Products" /><PageBody padded><p className="text-faint">Loading…</p></PageBody></Page>;
  const designOptions = studio.designs.map((d) => ({ value: d.id, label: d.label }));
  return (
    <Page testId="product-page">
      <RouteHeader
        title={product.label}
        count={product.partNumber === undefined ? undefined : <code className="cs-mono">{product.partNumber}</code>}
        secondary={<Link to="/products" className="cs-ui-btn no-underline">All products</Link>}
      />
      <PageBody padded>
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
      <h2 className="mt-1 mb-1 text-md font-semibold">Variants</h2>
      <LineupTable rows={page.data!.rows} showProduct={false} />
      {readOnly ? null : (
        <div className="mt-3 flex max-w-4xl flex-col gap-3">
          {adding === undefined ? (
            <Button variant="primary" className="self-start" onClick={() => setAdding({ design: '', id: '', partNumber: '', lengthMm: '', options: {} })}>
              Add a variant…
            </Button>
          ) : (
            <fieldset className="flex flex-wrap items-end gap-2 rounded-md border border-line p-2" data-testid="add-variant">
              <legend>New variant</legend>
              <Field label="Design">
                <Select aria-label="Variant design" className="w-56" placeholder="Pick a design…" value={adding.design === '' ? undefined : adding.design} options={designOptions} onValueChange={(v) => setAdding({ ...adding, design: v, id: adding.id === '' ? v : adding.id })} />
              </Field>
              <Field label="Variant id">
                <Input aria-label="Variant id" value={adding.id} onChange={(e) => setAdding({ ...adding, id: e.target.value })} />
              </Field>
              <Field label="Number">
                <Input mono aria-label="Variant number" value={adding.partNumber} onChange={(e) => setAdding({ ...adding, partNumber: e.target.value })} />
              </Field>
              <Button onClick={() => void suggest()}>Suggest</Button>
              <Field label="Length, mm">
                <Input aria-label="Variant length" className="w-20" value={adding.lengthMm} onChange={(e) => setAdding({ ...adding, lengthMm: e.target.value })} />
              </Field>
              {(product.options ?? []).map((axis) => (
                <Field key={axis.id} label={axis.label}>
                  <Select
                    aria-label={`Variant ${axis.label}`}
                    className="w-32"
                    placeholder="—"
                    value={adding.options[axis.id] === undefined || adding.options[axis.id] === '' ? undefined : adding.options[axis.id]}
                    options={axis.values.map((v) => ({ value: v.id, label: v.label }))}
                    onValueChange={(v) => setAdding({ ...adding, options: { ...adding.options, [axis.id]: v } })}
                  />
                </Field>
              ))}
              <Button
                variant="primary"
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
              </Button>
              <Button onClick={() => setAdding(undefined)}>Cancel</Button>
            </fieldset>
          )}
          {others.length === 0 ? null : (
            <fieldset className="flex flex-wrap items-center gap-3 rounded-md border border-line p-2" data-testid="merge">
              <legend>Merge other products into this one</legend>
              {others.map((p) => (
                <Checkbox key={p.id} checked={mergeFrom.includes(p.id)} onCheckedChange={(on) => setMergeFrom((m) => (on ? [...m, p.id] : m.filter((x) => x !== p.id)))} label={p.label} />
              ))}
              <Button
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
              </Button>
            </fieldset>
          )}
          {product.variants.length < 2 ? null : (
            <fieldset className="flex flex-wrap items-center gap-3 rounded-md border border-line p-2" data-testid="split">
              <legend>Split variants off into a new product</legend>
              {product.variants.map((v) => (
                <Checkbox key={v.id} checked={splitPick.includes(v.id)} onCheckedChange={(on) => setSplitPick((m) => (on ? [...m, v.id] : m.filter((x) => x !== v.id)))} label={v.label ?? v.id} />
              ))}
              <Input aria-label="New product id" placeholder="new id" className="w-36" value={splitTo.id} onChange={(e) => setSplitTo({ ...splitTo, id: e.target.value })} />
              <Input aria-label="New product name" placeholder="name" className="w-44" value={splitTo.label} onChange={(e) => setSplitTo({ ...splitTo, label: e.target.value })} />
              <Button
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
              </Button>
            </fieldset>
          )}
          {json === undefined ? (
            <Button className="self-start" onClick={() => setJson(pretty(product))}>
              Edit as JSON…
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Textarea mono rows={14} aria-label="Product record" value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
              <div className="flex gap-2">
                <Button
                  variant="primary"
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
                </Button>
                <Button onClick={() => setJson(undefined)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
      </PageBody>
    </Page>
  );
}
