import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { recordMetaIssues } from '@wirehub/model';
import { expect, it } from 'vitest';
import { importQuote, offersCsv, priceAt, quoteImportFile, requirementsCsv } from '../src/logic.ts';
import type { LookupRequest, SupplierOffer } from '../src/types.ts';

const request: LookupRequest = { provider: 'mouser', match: 'mpn', query: 'TEST-001', quantity: 10, currency: 'USD', country: 'US' };
const offer: SupplierOffer = { provider: 'mouser', supplierNumber: 'TEST-SKU', mpn: 'TEST-001', manufacturer: 'Example', observedAt: '2026-01-01T00:00:00Z', currency: 'USD', unit: 'each', moq: 5, breaks: [{ minQty: 5, unitPrice: 2 }, { minQty: 10, unitPrice: 1.5 }] };
const db = () => createCatalog(fsCatalogSource(dataPath(''))).loadDb();

it('uses the applicable price tier and leaves missing/below-MOQ offers unpriced', () => {
  expect(priceAt(offer, 10)).toBe(1.5);
  expect(priceAt(offer, 6)).toBe(2);
  expect(priceAt(offer, 1)).toBeUndefined();
  expect(priceAt({ ...offer, breaks: [] }, 10)).toBeUndefined();
  expect(priceAt({ ...offer, breaks: [{ minQty: 1, unitPrice: NaN }] }, 10)).toBeUndefined();
});

it('protects spreadsheet formulas and keeps unavailable prices blank', () => {
  const report = offersCsv({ request, observedAt: offer.observedAt, offers: [{ ...offer, manufacturer: '=1+1', breaks: [] }] });
  expect(report).toContain('"\'=1+1"');
  expect(report).toContain('"USD",""');
  expect(report).not.toContain('"USD","0"');
});

it('does not offer cost adoption for unknown units or absent pricing', () => {
  expect(quoteImportFile({ kind: 'components', id: 'test' }, { ...offer, unit: 'unknown' }, request)).toBeUndefined();
  expect(quoteImportFile({ kind: 'components', id: 'test' }, { ...offer, breaks: [] }, request)).toBeUndefined();
  expect(quoteImportFile({ kind: 'components', id: 'test' }, { ...offer, url: 'https://mouser.evil.invalid/product' }, request)).toBeUndefined();
});

it('proposes an explicit update without mutating the record, retaining other suppliers', () => {
  const catalog = db();
  catalog.components.push({ id: 'quote-target', label: 'Synthetic component', kind: 'resistor', terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example', mpn: offer.mpn, manufacturer: offer.manufacturer, suppliers: [{ supplier: 'other', number: 'OTHER' }] });
  const before = structuredClone(catalog.components.at(-1));
  const file = quoteImportFile({ kind: 'components', id: 'quote-target' }, offer, request)!;
  const out = importQuote({ fileName: file.fileName, bytes: new TextEncoder().encode(file.body) }, catalog);
  expect(catalog.components.at(-1)).toEqual(before);
  expect(out.updates?.components?.[0]?.cost).toMatchObject({ unit: 2, currency: 'USD', per: 'each', moq: 5, breaks: [{ minQty: 5, unit: 2 }, { minQty: 10, unit: 1.5 }] });
  expect(out.updates?.components?.[0]?.suppliers).toEqual([{ supplier: 'other', number: 'OTHER' }, { supplier: 'mouser', number: 'TEST-SKU' }]);
  const adopted = out.updates!.components![0]!;
  expect(adopted.license).toBe('(CC0-1.0) AND LicenseRef-mouser-terms');
  expect(adopted.provenance?.sources[0]?.retrieved).toBe('2026-01-01');
  expect(recordMetaIssues(adopted, 'components/quote-target')).toEqual([]);
  catalog.components[catalog.components.length - 1] = adopted;
  for (let refresh = 0; refresh < 10; refresh += 1) {
    const again = importQuote({ fileName: file.fileName, bytes: new TextEncoder().encode(file.body) }, catalog).updates!.components![0]!;
    expect(again).toEqual(adopted);
    catalog.components[catalog.components.length - 1] = again;
  }
  expect(out.notes[0]).toContain('only if you apply');
  catalog.components.at(-1)!.mpn = 'DIFFERENT';
  expect(() => importQuote({ fileName: file.fileName, bytes: new TextEncoder().encode(file.body) }, catalog)).toThrow(/part number differs/);
});

it('accepts regional supplier links for reviewed quotes and rejects cross-provider links', () => {
  const regional = { ...offer, provider: 'digikey' as const, url: 'https://www.digikey.co.uk/en/products/detail/synthetic' };
  expect(quoteImportFile({ kind: 'components', id: 'test' }, regional, { ...request, provider: 'digikey' })).toBeDefined();
  expect(quoteImportFile({ kind: 'components', id: 'test' }, { ...regional, provider: 'mouser' }, request)).toBeUndefined();
});

it('derives purchasing quantities from the BOM and treats a PCBA as one whole part', () => {
  const catalog = db();
  catalog.pcbas.push({ id: 'quote-board', label: 'Synthetic PCBA', partNumber: 'TEST-BOARD', revision: '1', terminals: [], internalLinks: [], src: 'synthetic example' });
  const design: CableDesign = { schemaVersion: 4, id: 'quote-cable', label: 'Cable', instances: { connectors: [], segments: [], components: [], pcbas: [{ id: 'board', def: 'quote-board' }] }, joints: [], src: 'synthetic example' };
  const report = requirementsCsv(design, catalog, 3);
  expect(report).toContain('"pcba","quote-board","TEST-BOARD","Synthetic PCBA","3","each"');
  expect(() => requirementsCsv(design, catalog, 0)).toThrow(/Build quantity/);
});
