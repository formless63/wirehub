/** Pure reports and explicit reviewed adoption; never refresh engineering truth. */
import { deriveBom } from '@wirehub/docs';
import type { CableDesign, Db, PartCost } from '@wirehub/model';
import type { ImportInput, ImportResult } from '@wirehub/modules';
import type { LookupRequest, LookupResult, SupplierOffer } from './types.ts';

const providers = ['mouser', 'digikey', 'lcsc'];
const recordKinds = ['connectors', 'wires', 'components', 'pcbas', 'mechanicals', 'kits'] as const;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 500 && !/[\u0000-\u001f]/.test(s);

export function offerProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['The quote has no offer.'];
  const o = value as SupplierOffer;
  const errors: string[] = [];
  if (!providers.includes(o.provider) || !text(o.supplierNumber) || !text(o.mpn) || !text(o.manufacturer)) errors.push('The offer needs a known supplier and complete part identity.');
  if (!text(o.observedAt) || !Number.isFinite(Date.parse(o.observedAt))) errors.push('The offer needs its retrieval date.');
  if (!/^[A-Z]{3}$/.test(o.currency ?? '')) errors.push('The offer needs an explicit currency.');
  if (!['each', 'm', 'unknown'].includes(o.unit)) errors.push('The pricing unit is invalid.');
  for (const n of [o.stock, o.moq, o.orderMultiple]) if (n !== undefined && (!finite(n) || n < 0)) errors.push('Stock and order quantities must be finite and nonnegative.');
  if (o.moq === 0 || o.orderMultiple === 0) errors.push('Minimum order and order multiple must be positive.');
  if (!Array.isArray(o.breaks) || o.breaks.length > 100 || o.breaks.some(b => !b || !finite(b.minQty) || b.minQty <= 0 || !finite(b.unitPrice) || b.unitPrice < 0)) errors.push('Price breaks must have positive quantities and nonnegative prices.');
  else if (new Set(o.breaks.map(b => b.minQty)).size !== o.breaks.length) errors.push('Price break quantities are duplicated.');
  if (o.url !== undefined) {
    try { const u = new URL(o.url); if (u.protocol !== 'https:' || u.username || u.password || !['mouser.com', 'digikey.com', 'lcsc.com'].some(domain => u.hostname === domain || u.hostname.endsWith(`.${domain}`))) errors.push('The offer link must be a public supplier HTTPS URL.'); }
    catch { errors.push('The offer link is invalid.'); }
  }
  return errors;
}

/** Spreadsheet formula protection is applied even to names and source URLs. */
function cell(value: unknown): string {
  let s = value === undefined ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
const csv = (rows: unknown[][]): string => rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';

export function priceAt(offer: SupplierOffer, quantity: number): number | undefined {
  if (offerProblems(offer).length > 0 || !finite(quantity) || quantity <= 0 || (offer.moq !== undefined && quantity < offer.moq)) return undefined;
  return [...offer.breaks].sort((a, b) => b.minQty - a.minQty).find(b => b.minQty <= quantity)?.unitPrice;
}

export function offersCsv(result: LookupResult): string {
  return csv([
    ['Supplier', 'Supplier number', 'Manufacturer', 'MPN', 'Requested quantity', 'Pricing unit', 'Currency', 'Unit price', 'Stock', 'MOQ', 'Order multiple', 'Packaging', 'Retrieved', 'Source', 'Notes'],
    ...result.offers.map(o => [o.provider, o.supplierNumber, o.manufacturer, o.mpn, result.request.quantity, o.unit, o.currency, priceAt(o, result.request.quantity), o.stock, o.moq, o.orderMultiple, o.packaging, o.observedAt, o.url, [...(o.warnings ?? []), ...(o.unit === 'unknown' ? ['Confirm purchasing units before costing.'] : [])].join('; ')]),
  ]);
}

export function quoteImportFile(record: { kind: string; id: string }, offer: SupplierOffer, request: LookupRequest): { fileName: string; body: string } | undefined {
  if (!(recordKinds as readonly string[]).includes(record.kind) || !text(record.id) || offerProblems(offer).length > 0 || offer.unit === 'unknown' || priceAt(offer, request.quantity) === undefined) return undefined;
  return { fileName: 'selected.supplier-quote.json', body: JSON.stringify({ format: 'wirehub.supplier-quote', version: 1, record, offer, quantity: request.quantity }, null, 2) + '\n' };
}

/** The host previews updates and applies its normal validation/read-only policy. */
export function importQuote(input: ImportInput, db: Db): ImportResult {
  if (input.bytes.length > 64 * 1024) throw new Error('The selected quote is too large.');
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)) as { format: string; version: number; record: { kind: string; id: string }; offer: SupplierOffer; quantity: number };
  if (document.format !== 'wirehub.supplier-quote' || document.version !== 1 || !document.record || !(recordKinds as readonly string[]).includes(document.record.kind) || !text(document.record.id)) throw new Error('This is not a selected supplier quote.');
  const offer = document.offer;
  const errors = offerProblems(offer);
  if (errors.length > 0) throw new Error(errors.join(' '));
  if (offer.unit === 'unknown' || priceAt(offer, document.quantity) === undefined) throw new Error('Confirm the purchasing unit and a price for the requested quantity before adopting a cost.');
  const kind = document.record.kind as typeof recordKinds[number];
  const record = db[kind]?.find(r => r.id === document.record.id);
  if (record === undefined) throw new Error('The selected library record no longer exists.');
  const identity = record as typeof record & { mpn?: string; manufacturer?: string; suppliers?: { supplier: string; number?: string }[] };
  if (identity.mpn && identity.mpn.trim().toLowerCase() !== offer.mpn.trim().toLowerCase()) throw new Error('The offer manufacturer part number differs from the library record.');
  if (identity.manufacturer && identity.manufacturer.trim().toLowerCase() !== offer.manufacturer.trim().toLowerCase()) throw new Error('The offer manufacturer differs from the library record.');
  const breaks = [...offer.breaks].sort((a, b) => a.minQty - b.minQty);
  const cost: PartCost = { unit: breaks[0]!.unitPrice, currency: offer.currency, per: offer.unit, breaks: breaks.map(b => ({ minQty: b.minQty, unit: b.unitPrice })), moq: Math.max(offer.moq ?? 1, breaks[0]!.minQty), src: `${offer.provider} ${offer.supplierNumber}; retrieved ${offer.observedAt}${offer.url ? `; ${offer.url}` : ''}` };
  const suppliers = (identity.suppliers ?? []).filter(s => s.supplier.toLowerCase() !== offer.provider);
  const citation = `${offer.provider} ${offer.supplierNumber}; selected quote ${input.fileName}; retrieved ${offer.observedAt}`;
  const updated = {
    ...record, cost, suppliers: [...suppliers, { supplier: offer.provider, number: offer.supplierNumber }],
    src: `${record.src}; ${citation}`,
    license: `(${record.license ?? 'CC0-1.0'}) AND LicenseRef-${offer.provider}-terms`,
    provenance: { method: 'derived' as const, sources: [...(record.provenance?.sources ?? []), { title: citation, ...(offer.url ? { url: offer.url } : {}), retrieved: new Date(offer.observedAt).toISOString().slice(0, 10) }] },
  };
  return { updates: { [kind]: [updated] }, notes: [`Review ${kind}/${record.id}: adopt ${offer.provider} ${offer.supplierNumber}, ${offer.currency} per ${offer.unit}, retrieved ${offer.observedAt}. Existing cost is replaced only if you apply this update. Confirm order multiples (${offer.orderMultiple ?? 'unspecified'}) and packaging (${offer.packaging ?? 'unspecified'}).`] };
}

/** Assembly purchasing quantities derive from the ordinary BOM; PCBAs remain whole. */
export function requirementsCsv(design: CableDesign, db: Db, builds = 1): string {
  if (!Number.isSafeInteger(builds) || builds <= 0 || builds > 1_000_000) throw new Error('Build quantity must be a positive whole number up to 1000000.');
  const bom = deriveBom(design, db);
  return csv([
    ['Design', 'Category', 'Definition', 'Part number', 'Description', 'Required quantity', 'Unit', 'Notes'],
    ...bom.lines.map(line => [design.id, line.category, line.ref, line.partNumber, line.label, line.totalMm === undefined ? line.qty * builds : line.totalMm / 1000 * builds, line.totalMm === undefined ? 'each' : 'm', 'Confirm supplier packaging and order quantities.']),
    ...bom.gaps.map(gap => [design.id, 'gap', '', '', '', '', '', gap]),
    ...bom.issues.map(issue => [design.id, issue.severity, '', '', '', '', '', issue.message]),
  ]);
}
