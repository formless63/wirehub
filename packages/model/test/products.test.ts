/** Products, variants, merge and split, the lineup, routes (`products.ts`), over the starter catalog. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import {
  DEFAULT_PART_NUMBER_SCHEME,
  isVariantNumber,
  knownPartNumbers,
  lineupCsv,
  lineupRows,
  mergeProducts,
  partNumberReport,
  productIssues,
  productsOfDesign,
  splitProduct,
  validateDb,
  validateDesign,
  type CableDesign,
  type ProductFamily,
} from '../src/index.ts';

const db = loadDb();
const designs = ['dc-led-lead', 'dc-pigtail-lead', 'dc-y-splitter', 'de9-crossover'].map((id) => loadDesign(id));
const SRC = 'synthetic example';

const leads: ProductFamily = {
  id: 'dc-leads',
  label: 'DC leads',
  partNumber: 'CBL-00090-XX',
  options: [{ id: 'colour', label: 'Colour', values: [{ id: 'black', label: 'Black' }, { id: 'red', label: 'Red' }] }],
  variants: [
    { id: 'led', design: 'dc-led-lead', partNumber: 'CBL-00090-01', options: { colour: 'black' } },
    { id: 'pigtail', design: 'dc-pigtail-lead', partNumber: 'CBL-00090-02', lengthMm: 300, options: { colour: 'red' } },
  ],
  src: SRC,
};
const ys: ProductFamily = { id: 'y-leads', label: 'Y leads', partNumber: 'CBL-00091', aliases: ['Splitter'], variants: [{ id: 'y', design: 'dc-y-splitter' }], src: SRC };

describe('product checks', () => {
  it('a well-formed lineup has no errors; nothing released is a warning per sold variant', () => {
    const issues = productIssues([leads, ys], { designs, scheme: DEFAULT_PART_NUMBER_SCHEME, released: new Map([['dc-led-lead', 1]]) });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => i.code === 'product-variant-unreleased').map((i) => i.where)).toEqual(['products/dc-leads/variants/pigtail', 'products/y-leads/variants/y']);
  });

  it('refuses unknown designs and options, and warns about twins, shared designs and numbers off the family', () => {
    const odd: ProductFamily = {
      ...leads,
      variants: [
        { id: 'a', design: 'dc-led-lead', options: { colour: 'green' } },
        { id: 'b', design: 'dc-led-lead', options: { size: 'big' } },
        { id: 'c', design: 'no-such-design' },
        { id: 'd', design: 'de9-crossover', partNumber: 'CBL-00777-01' },
        { id: 'e', design: 'de9-crossover', partNumber: 'CBL-00777-01' },
      ],
    };
    const codes = productIssues([odd, { ...ys, variants: [{ id: 'y', design: 'de9-crossover' }] }], { designs }).map((i) => `${i.code}:${i.severity}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'product-option-unknown:error',
        'product-variant-design:error',
        'product-variant-pn:warning',
        'product-variants-ambiguous:warning',
        'product-design-shared:warning',
      ]),
    );
  });

  it('reads a family pattern', () => {
    expect(isVariantNumber('CBL-00090-XX', 'CBL-00090-07')).toBe(true);
    expect(isVariantNumber('CBL-00090-XX', 'CBL-00091-07')).toBe(false);
    expect(isVariantNumber('CBL-00090', 'CBL-00090')).toBe(false);
  });

  it('finds the families a design is in', () => {
    expect(productsOfDesign([leads, ys], 'dc-pigtail-lead').map((x) => `${x.product.id}/${x.variant.id}`)).toEqual(['dc-leads/pigtail']);
  });
});

describe('merge and split', () => {
  it('merges: variants move with unique ids, the merged family becomes aliases, axes join', () => {
    const twin: ProductFamily = { id: 'more-leads', label: 'More leads', partNumber: 'CBL-00092', options: [{ id: 'colour', label: 'Colour', values: [{ id: 'blue', label: 'Blue' }] }], variants: [{ id: 'led', design: 'dc-led-lead', options: { colour: 'blue' } }], src: SRC };
    const out = mergeProducts([leads, ys, twin], 'dc-leads', ['y-leads', 'more-leads']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.products.map((p) => p.id)).toEqual(['dc-leads']);
    const merged = out.products[0]!;
    expect(merged.variants.map((v) => v.id)).toEqual(['led', 'pigtail', 'y', 'more-leads-led']);
    expect(merged.aliases).toEqual(['y-leads', 'Y leads', 'CBL-00091', 'Splitter', 'more-leads', 'More leads', 'CBL-00092']);
    expect(merged.options?.[0]?.values.map((v) => v.id)).toEqual(['black', 'red', 'blue']);
    expect(productIssues(out.products, { designs }).filter((i) => i.severity === 'error')).toEqual([]);
    expect(mergeProducts([leads], 'dc-leads', ['dc-leads']).ok).toBe(false);
    expect(mergeProducts([leads], 'nope', ['dc-leads']).ok).toBe(false);
  });

  it('splits variants off, keeping at least one behind', () => {
    const out = splitProduct([leads, ys], 'dc-leads', ['pigtail'], { id: 'pigtails', label: 'Pigtail leads' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.products.map((p) => [p.id, p.variants.map((v) => v.id)])).toEqual([
      ['dc-leads', ['led']],
      ['pigtails', ['pigtail']],
      ['y-leads', ['y']],
    ]);
    expect(out.products[1]!.options?.map((a) => a.id)).toEqual(['colour']);
    expect(splitProduct([leads], 'dc-leads', ['led', 'pigtail'], { id: 'all', label: 'All' }).ok).toBe(false);
    expect(splitProduct([leads], 'dc-leads', ['nope'], { id: 'x', label: 'X' }).ok).toBe(false);
    expect(splitProduct([leads, ys], 'dc-leads', ['led'], { id: 'y-leads', label: 'Taken' }).ok).toBe(false);
  });
});

describe('the lineup', () => {
  it('lists every sold variant with its number, length, options, release, cost and route', () => {
    const contract: CableDesign = { ...designs[0]!, route: 'contract', maker: 'A contract maker' };
    const rows = lineupRows([leads, ys], { designs: [contract, ...designs.slice(1)], released: new Map([['dc-led-lead', 2]]), costs: new Map([['dc-led-lead', { total: 1.25, currency: 'EUR' }]]) });
    expect(rows.map((r) => [r.product, r.variant, r.partNumber, r.options['colour']])).toEqual([
      ['dc-leads', 'led', 'CBL-00090-01', 'Black'],
      ['dc-leads', 'pigtail', 'CBL-00090-02', 'Red'],
      ['y-leads', 'y', undefined, undefined],
    ]);
    expect(rows[0]).toMatchObject({ route: 'contract', maker: 'A contract maker', releasedRev: 2, cost: 1.25, currency: 'EUR' });
    expect(rows[1]!.lengthMm).toBe(300);
    const csv = lineupCsv(rows);
    expect(csv.split('\r\n')[0]).toBe('product,product_label,product_part_number,variant,variant_label,part_number,design,design_label,status,route,maker,length_mm,option_colour,released_rev,cost,currency,aliases');
    expect(csv).toContain('dc-leads,DC leads,CBL-00090-XX,led,,CBL-00090-01,dc-led-lead,');
    // retired variants are left out unless asked for
    const retired = lineupRows([{ ...ys, status: 'retired' }], { designs });
    expect(retired).toEqual([]);
    expect(lineupRows([{ ...ys, status: 'retired' }], { designs }, { retired: true })).toHaveLength(1);
  });

  it('quotes CSV cells that need it', () => {
    const csv = lineupCsv(lineupRows([{ ...ys, label: 'Y, "split"' }], { designs }));
    expect(csv).toContain('"Y, ""split"""');
  });
});

describe('routes and part numbers', () => {
  it('warns about a bought-in part with no supplier and a contract part with no maker, and refuses a bad route', () => {
    const lib = { ...db, components: db.components.map((c, i) => (i === 0 ? { ...c, route: 'buy' as const } : i === 1 ? { ...c, route: 'buy' as const, suppliers: [{ supplier: 'A distributor', number: '123' }] } : c)) };
    const codes = validateDb(lib).map((i) => i.code);
    expect(codes.filter((c) => c === 'route-buy-no-supplier')).toHaveLength(1);
    const bad = { ...db, connectors: db.connectors.map((c, i) => (i === 0 ? ({ ...c, route: 'borrowed' } as never) : c)) };
    expect(validateDb(bad).find((i) => i.code === 'invalid-route')?.severity).toBe('error');
    const design: CableDesign = { ...designs[0]!, route: 'contract' };
    expect(validateDesign(design, db).map((i) => i.code)).toContain('route-contract-no-maker');
    expect(validateDesign({ ...design, maker: 'A contract maker' }, db).map((i) => i.code)).not.toContain('route-contract-no-maker');
  });

  it('counts product numbers as taken, and a variant numbered like its design is not a duplicate', () => {
    const lib = { ...db, products: [leads, ys] };
    expect(knownPartNumbers(lib).map((k) => k.pn)).toEqual(expect.arrayContaining(['CBL-00090-01', 'CBL-00091']));
    const withRef = designs.map((d) => (d.id === 'dc-led-lead' ? { ...d, productRef: 'CBL-00090-01' } : d));
    expect(partNumberReport(lib, withRef).duplicates).toEqual([]);
    const clash = { ...lib, products: [leads, { ...ys, partNumber: 'CBL-00090-01' }] };
    expect(partNumberReport(clash, withRef).duplicates.map((d) => d.pn)).toEqual(['CBL-00090-01']);
  });
});
