/** Supplier UI uses only the module API; quotes are adopted through a downloaded reviewed import. */
import { createElement as h, useEffect, useRef, useState, type ReactElement } from 'react';
import type { ModuleApi, PanelProps, RouteProps } from '@wirehub/modules';
import type { LookupRequest, LookupResult, SupplierId, SupplierOffer } from './types.ts';
import { offersCsv, quoteImportFile, requirementsCsv } from './logic.ts';

interface Provider { id: SupplierId; label: string; enabled: boolean; configured: boolean }
interface Part { mpn?: string; manufacturer?: string; suppliers?: readonly { supplier: string; number?: string }[] }
interface Draft { provider: SupplierId | ''; query: string; match: 'supplier' | 'mpn'; manufacturer: string; quantity: string; currency: string; country: string }
const emptyDraft = (): Draft => ({ provider: '', query: '', match: 'mpn', manufacturer: '', quantity: '1', currency: 'USD', country: 'US' });
const supplierId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const skuOf = (part: Part | undefined, provider: string): string | undefined => part?.suppliers?.find((s) => supplierId(s.supplier) === provider)?.number;
const messageOf = (body: unknown, fallback: string): string => typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : fallback;
function partOf(props: PanelProps): Part | undefined {
  if (props.record === undefined) return undefined;
  const entries = (props.db as unknown as Record<string, unknown>)[props.record.kind];
  return Array.isArray(entries) ? entries.find((r: { id: string }) => r.id === props.record?.id) as Part | undefined : undefined;
}
function safeOfferUrl(offer: SupplierOffer): string | undefined {
  if (offer.url === undefined) return undefined;
  try {
    const u = new URL(offer.url);
    const domains = { mouser: ['mouser.com', 'mouser.co.uk'], digikey: ['digikey.com', 'digikey.co.uk', 'digi-key.com'], lcsc: ['lcsc.com'] }[offer.provider];
    return u.protocol === 'https:' && u.username === '' && u.password === '' && domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`)) ? u.href : undefined;
  } catch { return undefined; }
}
function download(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = fileName; a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function staleWarning(offer: SupplierOffer): string | undefined {
  const observed = Date.parse(offer.observedAt);
  return !Number.isFinite(observed) ? 'Observation time is unavailable.' : Date.now() - observed > 24 * 60 * 60 * 1000 ? 'This quote is more than 24 hours old. Refresh before ordering.' : undefined;
}

function LookupPanel(props: { api: ModuleApi; identity: string; part?: Part; record?: { kind: string; id: string }; readOnly?: boolean }): ReactElement {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [result, setResult] = useState<LookupResult>();
  const [pricingBasis, setPricingBasis] = useState<Record<string, 'each' | 'm' | ''>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [configError, setConfigError] = useState('');
  const partRef = useRef(props.part); partRef.current = props.part;
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ModuleApi has no AbortSignal: invalidate in-flight callbacks and stop later polling.
  const cancel = (): void => { generation.current += 1; if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined; };
  const reset = (): void => { cancel(); setResult(undefined); setPricingBasis({}); setStatus(''); setBusy(false); };
  useEffect(() => {
    let active = true;
    void props.api('GET', 'config').then((out) => {
      if (!active) return;
      if (out.status !== 200) { setConfigError(messageOf(out.body, 'Supplier configuration could not be loaded.')); return; }
      const list = (out.body as { providers: Provider[] }).providers;
      setProviders(list);
      setDraft((old) => {
        const provider = (list.find((p) => p.enabled && p.configured && skuOf(partRef.current, p.id) !== undefined) ?? list.find((p) => p.enabled && p.configured))?.id ?? '';
        const sku = skuOf(partRef.current, provider);
        return { ...old, provider, query: sku ?? partRef.current?.mpn ?? '', match: sku === undefined ? 'mpn' : 'supplier', manufacturer: partRef.current?.manufacturer ?? '' };
      });
    }).catch((error: unknown) => { if (active) setConfigError(error instanceof Error ? error.message : 'Supplier configuration could not be loaded.'); });
    return () => { active = false; cancel(); };
  }, [props.api]);
  useEffect(() => {
    reset();
    setDraft((old) => {
      const sku = skuOf(props.part, old.provider);
      return { ...emptyDraft(), provider: old.provider, query: sku ?? props.part?.mpn ?? '', match: sku === undefined ? 'mpn' : 'supplier', manufacturer: props.part?.manufacturer ?? '' };
    });
    return cancel;
  }, [props.identity]);
  const change = (key: keyof Draft, value: string): void => {
    reset();
    setDraft((old) => {
      if (key === 'provider') {
        const sku = skuOf(props.part, value);
        return { ...old, provider: value as SupplierId, query: sku ?? props.part?.mpn ?? '', match: sku === undefined ? 'mpn' : 'supplier' };
      }
      return { ...old, [key]: value };
    });
  };
  const linkedNumbers = [...new Set((props.part?.suppliers ?? []).filter((s) => supplierId(s.supplier) === draft.provider).flatMap((s) => s.number === undefined ? [] : [s.number]))];
  const provider = providers.find((p) => p.id === draft.provider);
  const quantity = Number(draft.quantity);
  const valid = provider?.enabled === true && provider.configured && draft.query.trim() !== '' && Number.isFinite(quantity) && quantity > 0 && /^[A-Z]{3}$/.test(draft.currency) && /^[A-Z]{2}$/.test(draft.country);
  const refresh = async (): Promise<void> => {
    if (!valid || draft.provider === '') return;
    reset(); const token = generation.current; setBusy(true); setStatus('Requesting supplier quote…');
    const request: LookupRequest = { provider: draft.provider, query: draft.query.trim(), match: draft.match, ...(draft.manufacturer.trim() === '' ? {} : { manufacturer: draft.manufacturer.trim() }), quantity, currency: draft.currency, country: draft.country };
    const current = (): boolean => token === generation.current;
    const fail = (text: string): void => { if (current()) { setStatus(text); setBusy(false); } };
    try {
      const queued = await props.api('POST', 'lookup', request);
      if (!current()) return;
      if (queued.status !== 202) { fail(messageOf(queued.body, 'Supplier lookup could not be started.')); return; }
      const id = (queued.body as { job: { id: string } }).job.id;
      let attempts = 0;
      const poll = async (): Promise<void> => {
        if (!current()) return;
        try {
          const out = await props.api('GET', `lookup?id=${encodeURIComponent(id)}`);
          if (!current()) return;
          if (out.status !== 200) { fail(messageOf(out.body, 'Supplier lookup status could not be read.')); return; }
          const job = (out.body as { job: { status: string; result?: LookupResult; error?: string } }).job;
          if (job.status === 'succeeded' || job.status === 'done' || job.status === 'completed') {
            if (job.result === undefined) { fail('The supplier returned no quote result.'); return; }
            setResult(job.result); setStatus(job.result.offers.length === 0 ? 'No matching offers. Try a supplier number or a more exact manufacturer part number.' : 'Quote received. Review the part, unit and quantity breaks before ordering.'); setBusy(false); return;
          }
          if (job.status === 'failed' || job.status === 'cancelled') { fail(job.error ?? 'Supplier lookup failed.'); return; }
          attempts += 1;
          if (attempts >= 120) { fail('This lookup is taking too long. Refresh to start a new request.'); return; }
          setStatus('Waiting for supplier quote…'); timer.current = setTimeout(() => { void poll(); }, 1000);
        } catch (error) { fail(error instanceof Error ? error.message : 'Supplier lookup failed.'); }
      };
      await poll();
    } catch (error) { fail(error instanceof Error ? error.message : 'Supplier lookup failed.'); }
  };
  const field = (label: string, key: keyof Draft, options: Record<string, unknown> = {}): ReactElement => h('label', null, label, h('input', { ...options, value: draft[key], onChange: (e: { target: { value: string } }) => change(key, ['currency', 'country'].includes(key) ? e.target.value.toUpperCase() : e.target.value) }));
  return h('section', { 'aria-label': 'Supplier lookup' },
    h('p', null, 'Quotes and downloaded reports are for private procurement. Refresh requests current supplier data; it does not change catalog costs.'),
    configError === '' ? null : h('p', { role: 'alert' }, configError),
    providers.length > 0 && !providers.some((p) => p.enabled && p.configured) ? h('p', null, 'No supplier is ready. Configure an enabled provider in your deployment, then reload this page.') : null,
    h('form', { onSubmit: (e: { preventDefault(): void }) => { e.preventDefault(); void refresh(); } },
      h('label', null, 'Supplier', h('select', { value: draft.provider, onChange: (e: { target: { value: string } }) => change('provider', e.target.value) }, h('option', { value: '' }, 'Choose supplier'), ...providers.map((p) => h('option', { key: p.id, value: p.id, disabled: !p.enabled || !p.configured }, `${p.label}${!p.enabled ? ' (disabled)' : !p.configured ? ' (credentials needed)' : ''}`)))),
      h('label', null, 'Match by', h('select', { value: draft.match, onChange: (e: { target: { value: string } }) => change('match', e.target.value) }, h('option', { value: 'supplier' }, 'Supplier part number'), h('option', { value: 'mpn' }, 'Manufacturer part number'))),
      linkedNumbers.length === 0 ? null : h('label', null, 'Linked supplier number', h('select', { value: draft.match === 'supplier' && linkedNumbers.includes(draft.query) ? draft.query : '', onChange: (e: { target: { value: string } }) => { if (e.target.value !== '') { reset(); setDraft((old) => ({ ...old, query: e.target.value, match: 'supplier' })); } } }, h('option', { value: '' }, 'Custom search'), ...linkedNumbers.map((n) => h('option', { key: n, value: n }, n)))),
      field('Part number', 'query'), field('Manufacturer', 'manufacturer'), field('Quantity', 'quantity', { type: 'number', min: 0.001, step: 'any' }), field('Currency', 'currency', { maxLength: 3 }), field('Country', 'country', { maxLength: 2 }),
      h('button', { type: 'submit', disabled: !valid || busy }, busy ? 'Refreshing…' : 'Refresh quote'),
      busy ? h('button', { type: 'button', onClick: reset }, 'Stop waiting') : null),
    status === '' ? null : h('p', { role: 'status' }, status),
    result === undefined ? null : h('div', null,
      h('p', null, `Requested ${result.request.quantity} · ${result.request.currency} · ${result.request.country}. Observed ${result.observedAt}.`),
      h('button', { type: 'button', onClick: () => download('supplier-offers.csv', offersCsv(result), 'text/csv;charset=utf-8') }, 'Download offer CSV'),
      h('table', null, h('caption', null, 'Supplier offers'), h('thead', null, h('tr', null, ...['Part', 'Stock', 'Minimum / multiple', 'Packaging / unit', 'Quantity prices', 'Observation / notes', 'Review'].map((label) => h('th', { key: label, scope: 'col' }, label)))),
        h('tbody', null, ...result.offers.map((offer, index) => {
          const rowKey = `${offer.provider}:${offer.supplierNumber}:${index}`;
          const basis = pricingBasis[rowKey] ?? (offer.unit === 'unknown' ? '' : offer.unit);
          const selectedOffer: SupplierOffer = pricingBasis[rowKey] === undefined ? offer : { ...offer, unit: basis === '' ? 'unknown' : basis, warnings: [...(offer.warnings ?? []), ...(basis === '' ? [] : ['Pricing basis confirmed by user.'])] };
          const url = safeOfferUrl(offer); const file = props.record === undefined || props.readOnly ? undefined : quoteImportFile(props.record, selectedOffer, result.request); const stale = staleWarning(offer);
          return h('tr', { key: `${offer.provider}:${offer.supplierNumber}:${index}` },
            h('td', null, url === undefined ? offer.supplierNumber : h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, offer.supplierNumber), h('div', null, `${offer.manufacturer} · ${offer.mpn}`), offer.description),
            h('td', null, offer.stock === undefined ? 'Unknown' : String(offer.stock)), h('td', null, `${offer.moq ?? 'Unknown'} / ${offer.orderMultiple ?? 'Unknown'}`), h('td', null, `${offer.packaging ?? 'Unknown packaging'} / ${offer.unit}`),
            h('td', null, offer.breaks.length === 0 ? 'Price unavailable' : h('ul', null, ...offer.breaks.map((b, i) => h('li', { key: i }, `${b.minQty}+: ${b.unitPrice} ${offer.currency} / ${offer.unit}`)))),
            h('td', null, offer.observedAt, stale === undefined ? null : h('p', null, stale), offer.unit === 'unknown' ? h('p', null, 'The supplier did not confirm purchasing units. Confirm the pricing basis before adopting a cost.') : null, ...((offer.warnings ?? []).map((warning, i) => h('p', { key: i }, warning)))),
            h('td', null, props.record === undefined ? null : h('label', null, `Pricing basis for ${offer.supplierNumber}`, h('select', { value: basis, disabled: props.readOnly === true, onChange: (e: { target: { value: string } }) => setPricingBasis((old) => ({ ...old, [rowKey]: e.target.value as 'each' | 'm' | '' })) }, h('option', { value: '' }, 'Unconfirmed'), h('option', { value: 'each' }, 'Per piece'), h('option', { value: 'm' }, 'Per metre'))), h('button', { type: 'button', disabled: file === undefined, onClick: () => { if (file !== undefined) download(file.fileName, file.body, 'application/json'); } }, 'Download reviewed quote'), props.readOnly ? h('p', null, 'This record is read-only.') : null));
        }))),
      props.record === undefined ? null : h('p', null, 'To adopt a quote, download it and open Library → Import. Review the proposed record changes before accepting. Confirm whether the supplier price is per piece or per metre; packaging or reel size does not establish the pricing basis. Unpriced offers and unconfirmed units cannot be adopted.')));
}

export function LibraryPanel(props: PanelProps): ReactElement {
  return h(LookupPanel, { api: props.api, identity: `${props.record?.kind ?? ''}:${props.record?.id ?? ''}`, part: partOf(props), record: props.record, readOnly: props.readOnly });
}
export function ProcurementPage(props: RouteProps): ReactElement {
  return h('main', null, h('h1', null, 'Supplier quotes'), h('p', null, 'Look up current offers and download a private procurement report. Supplier availability and prices may change.'), h(LookupPanel, { api: props.api, identity: 'procurement' }));
}
export function DocumentsPanel(props: PanelProps): ReactElement {
  const [builds, setBuilds] = useState('1');
  const count = Number(builds);
  const valid = props.design !== undefined && Number.isSafeInteger(count) && count > 0 && count <= 1_000_000;
  return h('section', { 'aria-label': 'Procurement requirements' },
    h('p', null, 'Download the cable BOM for purchasing. PCBAs remain whole assemblies; confirm supplier packaging, minimum orders and wire units.'),
    h('label', null, 'Build quantity', h('input', { type: 'number', min: 1, step: 1, max: 1_000_000, value: builds, onChange: (e: { target: { value: string } }) => setBuilds(e.target.value) })),
    h('button', { type: 'button', disabled: !valid, onClick: () => { if (valid && props.design !== undefined) download('procurement-requirements.csv', requirementsCsv(props.design, props.db, count), 'text/csv;charset=utf-8'); } }, 'Download purchasing requirements'),
    h(LookupPanel, { api: props.api, identity: `design:${props.design?.id ?? ''}` }));
}
export function SettingsPanel(props: PanelProps): ReactElement {
  const [providers, setProviders] = useState<Provider[]>([]); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void props.api('GET', 'config').then((out) => { if (!active) return; if (out.status !== 200) setError(messageOf(out.body, 'Supplier configuration could not be loaded.')); else setProviders((out.body as { providers: Provider[] }).providers); }).catch(() => { if (active) setError('Supplier configuration could not be loaded.'); });
    return () => { active = false; };
  }, [props.api]);
  return h('section', { 'aria-label': 'Supplier settings' }, h('p', null, 'Enable providers and set their credentials in your deployment environment. Credentials stay on the server; do not put them in catalog records or quote files. Refreshes happen only when you request them.'), error === '' ? null : h('p', { role: 'alert' }, error), h('ul', null, ...providers.map((p) => h('li', { key: p.id }, `${p.label}: ${!p.enabled ? 'disabled' : p.configured ? 'ready' : 'credentials needed'}`))));
}
