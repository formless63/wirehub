/**
 * Products and their variants, the lineup, and how a part is made or bought (`docs/products.md`).
 *
 * A **product family** (`products.json`, `Db.products`) groups the designs a shop sells as one
 * product: its number (often a family number whose variant segment the scheme fills, `CBL-00010-XX`),
 * the names and numbers it is also known by (`aliases`), the option axes its builds differ on
 * (length is built in; colour, connector style … are declared), and its **variants**: each a build
 * documented by one design, with its own number, length and option values.
 *
 * Products merge (two families sold as one: the variants move, the merged family's id and numbers
 * become aliases) and split (some variants become a family of their own). The **lineup** is every
 * variant of every family as a row — number, design, options, the design's released revision, its
 * cost roll-up and route — for a catalog, a shop or an ERP to read (JSON or CSV).
 *
 * A **route** says how a part or a cable is sourced: `make` (in house), `contract` (a contract
 * manufacturer builds it) or `buy` (bought in finished). A bought-in part should name a supplier and
 * a contract-made one its maker (`routeIssues`, warnings).
 *
 * Pure: records in, records and issues out.
 */

import type { CableDesign, DesignStatus, Issue } from './model.ts';
import { DESIGN_STATUSES } from './model.ts';
import type { KnownPartNumber, PartNumberScheme, PnSuggestion } from './part-numbers.ts';
import type { RecordMeta } from './provenance.ts';

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export type PartRoute = 'make' | 'contract' | 'buy';

export const PART_ROUTES: readonly PartRoute[] = ['make', 'contract', 'buy'];

export const ROUTE_LABELS: Readonly<Record<PartRoute, string>> = { make: 'In house', contract: 'Contract manufacturer', buy: 'Bought in' };

/** Who sells a part. */
export interface PartSupplier {
  supplier: string;
  /** the supplier's own number for it */
  number?: string;
  note?: string;
}

/** The fields a part or a design carries about how it is sourced. */
export interface Sourcing {
  route?: PartRoute;
  /** bought in: who sells it (a component's `suppliers` are this list) */
  suppliers?: readonly PartSupplier[];
  /** contract-manufactured: who builds it (a name, no address) */
  maker?: string;
}

/** The shape of the sourcing fields, as errors (any record or design). */
export function sourcingShapeIssues(record: object, where: string): Issue[] {
  const r = record as Record<string, unknown>;
  const out: Issue[] = [];
  const bad = (message: string): void => void out.push({ code: 'invalid-route', severity: 'error', message: `${where}: ${message}`, where });
  if (r['route'] !== undefined && !(PART_ROUTES as readonly unknown[]).includes(r['route'])) bad(`route must be one of ${PART_ROUTES.join(', ')}`);
  if (r['maker'] !== undefined && (typeof r['maker'] !== 'string' || r['maker'].trim() === '')) bad('maker must be a name');
  if (r['suppliers'] !== undefined) {
    if (!Array.isArray(r['suppliers'])) bad('suppliers must be a list of { supplier, number? }');
    else for (const s of r['suppliers']) if (typeof s !== 'object' || s === null || typeof (s as { supplier?: unknown }).supplier !== 'string') bad('every supplier needs a name (supplier)');
  }
  return out;
}

/**
 * What a route asks for, as warnings: a bought-in part names a supplier (or, for a component, its
 * manufacturer and part number), a contract-made one its maker.
 */
export function routeIssues(record: Sourcing & { manufacturer?: string; mpn?: string }, where: string): Issue[] {
  if (record.route === 'buy' && (record.suppliers ?? []).length === 0 && !(record.manufacturer !== undefined && record.mpn !== undefined)) {
    return [{ code: 'route-buy-no-supplier', severity: 'warning', message: `${where} is bought in but names no supplier (or manufacturer and part number)`, where }];
  }
  if (record.route === 'contract' && (record.maker === undefined || record.maker.trim() === '')) {
    return [{ code: 'route-contract-no-maker', severity: 'warning', message: `${where} is made by a contract manufacturer but does not name it (maker)`, where }];
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Products
 * ------------------------------------------------------------------ */

export interface ProductOptionValue {
  id: string;
  label: string;
}

/** An axis the variants of a family differ on (colour, connector style …); length is built in. */
export interface ProductOptionAxis {
  id: string;
  label: string;
  values: ProductOptionValue[];
}

export interface ProductVariant {
  /** unique within the family */
  id: string;
  label?: string;
  /** the design that documents this build */
  design: string;
  /** the variant's own number (the scheme's variant of the family's number) */
  partNumber?: string;
  /** the length this build is cut to (the design's trunk otherwise) */
  lengthMm?: number;
  /** option axis id → value id */
  options?: Record<string, string>;
  status?: DesignStatus;
  note?: string;
}

export interface ProductFamily extends RecordMeta {
  id: string;
  label: string;
  /** the family's number: one number, or a family pattern whose variant segment its variants fill (`CBL-00010-XX`) */
  partNumber?: string;
  /** other names and numbers the product is known by (a merged family's, a marketing name, an old number) */
  aliases?: string[];
  description?: string;
  status?: DesignStatus;
  tags?: string[];
  options?: ProductOptionAxis[];
  variants: ProductVariant[];
  src: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function findProduct(products: readonly ProductFamily[] | undefined, id: string): ProductFamily | undefined {
  return (products ?? []).find((p) => p.id === id);
}

/** The families and variants a design documents. */
export function productsOfDesign(products: readonly ProductFamily[] | undefined, designId: string): { product: ProductFamily; variant: ProductVariant }[] {
  const out: { product: ProductFamily; variant: ProductVariant }[] = [];
  for (const product of products ?? []) for (const variant of product.variants) if (variant.design === designId) out.push({ product, variant });
  return out;
}

/** Whether `pn` is one of the numbers a family pattern stands for (`CBL-00010-XX` → `CBL-00010-03`). */
export function isVariantNumber(familyPn: string, pn: string): boolean {
  if (!/X/.test(familyPn)) return false;
  const escaped = familyPn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/X/g, '[0-9A-Z]');
  return new RegExp(`^${escaped}$`, 'i').test(pn.trim());
}

export interface ProductCheckContext {
  /** the designs the variants name (by id); absent = not checked */
  designs?: readonly Pick<CableDesign, 'id' | 'status' | 'productRef'>[];
  scheme?: PartNumberScheme;
  /** design id → its released revision (approved when approvals are on); a design missing from the map has none */
  released?: ReadonlyMap<string, number | undefined>;
}

/**
 * Everything wrong with the products: duplicate or malformed ids, a variant naming a design that
 * does not exist or an option the family does not declare (errors); two variants nobody could
 * tell apart, a design in two families, a number the scheme objects to, a variant number outside
 * its family's pattern, an active variant whose design has nothing released (warnings).
 */
export function productIssues(products: readonly ProductFamily[], ctx: ProductCheckContext = {}): Issue[] {
  const out: Issue[] = [];
  const issue = (code: string, message: string, where: string, severity: Issue['severity'] = 'error'): void => void out.push({ code, severity, message, where });
  const ids = new Set<string>();
  const designs = ctx.designs === undefined ? undefined : new Map(ctx.designs.map((d) => [d.id, d]));
  const familyOf = new Map<string, string>();
  for (const p of products) {
    const at = `products/${p.id}`;
    if (typeof p.id !== 'string' || !KEBAB.test(p.id)) issue('product-bad-id', `'${String(p.id)}' is not a kebab-case id`, at);
    if (ids.has(p.id)) issue('product-duplicate', `two products '${p.id}'`, at);
    ids.add(p.id);
    if (typeof p.label !== 'string' || p.label.trim() === '') issue('product-no-label', `product '${p.id}' has no name`, at);
    if (!p.src) issue('missing-src', `product '${p.id}' has no src`, at, 'warning');
    if (p.status !== undefined && !DESIGN_STATUSES.includes(p.status)) issue('product-status', `product '${p.id}' has status '${String(p.status)}'`, at);
    if (!Array.isArray(p.variants)) {
      issue('product-variants', `product '${p.id}' has no variants list`, at);
      continue;
    }
    const axes = new Map((p.options ?? []).map((a) => [a.id, new Set(a.values.map((v) => v.id))]));
    if (p.partNumber !== undefined && ctx.scheme !== undefined && !/X/.test(p.partNumber)) {
      for (const f of ctx.scheme.check(p.partNumber, 'design')) issue('product-pn-format', `${p.id}: ${f.message}`, at, 'warning');
    }
    const variantIds = new Set<string>();
    const shapes = new Map<string, string>();
    for (const v of p.variants) {
      const vat = `${at}/variants/${v.id}`;
      if (typeof v.id !== 'string' || !KEBAB.test(v.id)) issue('product-bad-id', `variant '${String(v.id)}' is not a kebab-case id`, vat);
      if (variantIds.has(v.id)) issue('product-variant-duplicate', `${p.id} has two variants '${v.id}'`, vat);
      variantIds.add(v.id);
      if (typeof v.design !== 'string' || v.design === '') {
        issue('product-variant-design', `variant '${v.id}' names no design`, vat);
        continue;
      }
      const design = designs?.get(v.design);
      if (designs !== undefined && design === undefined) issue('product-variant-design', `variant '${v.id}' names design '${v.design}', which does not exist`, vat);
      if (v.lengthMm !== undefined && !(typeof v.lengthMm === 'number' && v.lengthMm > 0)) issue('product-variant-length', `variant '${v.id}' has length ${String(v.lengthMm)}`, vat);
      for (const [axis, value] of Object.entries(v.options ?? {})) {
        const values = axes.get(axis);
        if (values === undefined) issue('product-option-unknown', `variant '${v.id}' sets option '${axis}', which ${p.id} does not declare`, vat);
        else if (!values.has(value)) issue('product-option-unknown', `variant '${v.id}' sets ${axis} to '${value}', which is not one of its values`, vat);
      }
      const shape = JSON.stringify([v.design, v.lengthMm ?? null, Object.entries(v.options ?? {}).sort()]);
      const twin = shapes.get(shape);
      if (twin !== undefined) issue('product-variants-ambiguous', `${p.id}: variants '${twin}' and '${v.id}' are the same design, length and options`, vat, 'warning');
      else shapes.set(shape, v.id);
      const elsewhere = familyOf.get(v.design);
      if (elsewhere !== undefined && elsewhere !== p.id) issue('product-design-shared', `design '${v.design}' is a variant of ${elsewhere} and of ${p.id}`, vat, 'warning');
      familyOf.set(v.design, p.id);
      if (v.partNumber !== undefined) {
        if (p.partNumber !== undefined && /X/.test(p.partNumber) && !isVariantNumber(p.partNumber, v.partNumber)) {
          issue('product-variant-pn', `variant '${v.id}' is numbered ${v.partNumber}, outside its family's ${p.partNumber}`, vat, 'warning');
        }
        for (const f of ctx.scheme?.check(v.partNumber, 'design') ?? []) issue('product-pn-format', `${p.id}/${v.id}: ${f.message}`, vat, 'warning');
      }
      const status = v.status ?? p.status ?? 'active';
      if (status === 'active' && ctx.released !== undefined && design !== undefined && ctx.released.get(v.design) === undefined) {
        issue('product-variant-unreleased', `variant '${v.id}' is sold, and its design '${v.design}' has no released revision`, vat, 'warning');
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Merge and split
 * ------------------------------------------------------------------ */

export type ProductEdit = { ok: true; products: ProductFamily[]; changed: string[] } | { ok: false; reason: string };

const unique = (taken: ReadonlySet<string>, id: string, prefix: string): string => {
  if (!taken.has(id)) return id;
  let candidate = `${prefix}-${id}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${prefix}-${id}-${n}`;
  return candidate;
};

function mergeAxes(into: readonly ProductOptionAxis[] | undefined, from: readonly ProductOptionAxis[] | undefined): ProductOptionAxis[] | undefined {
  if (into === undefined && from === undefined) return undefined;
  const out = (into ?? []).map((a) => ({ ...a, values: [...a.values] }));
  for (const axis of from ?? []) {
    const have = out.find((a) => a.id === axis.id);
    if (have === undefined) out.push({ ...axis, values: [...axis.values] });
    else for (const v of axis.values) if (!have.values.some((x) => x.id === v.id)) have.values.push(v);
  }
  return out;
}

/**
 * Merge families into one: `into` keeps its id and number; each of `from` hands over its variants
 * (ids made unique), its option axes (values joined) and its id, name, number and aliases as
 * aliases, and is removed.
 */
export function mergeProducts(products: readonly ProductFamily[], into: string, from: readonly string[]): ProductEdit {
  const target = findProduct(products, into);
  if (target === undefined) return { ok: false, reason: `there is no product '${into}'` };
  if (from.length === 0) return { ok: false, reason: 'name at least one product to merge in' };
  let merged: ProductFamily = { ...target, variants: [...target.variants], ...(target.aliases === undefined ? {} : { aliases: [...target.aliases] }) };
  for (const id of from) {
    if (id === into) return { ok: false, reason: `'${into}' cannot be merged into itself` };
    const source = findProduct(products, id);
    if (source === undefined) return { ok: false, reason: `there is no product '${id}'` };
    const taken = new Set(merged.variants.map((v) => v.id));
    const moved = source.variants.map((v) => {
      const vid = unique(taken, v.id, source.id);
      taken.add(vid);
      return { ...v, id: vid };
    });
    const aliases = [...(merged.aliases ?? []), source.id, source.label, ...(source.partNumber === undefined ? [] : [source.partNumber]), ...(source.aliases ?? [])];
    const axes = mergeAxes(merged.options, source.options);
    merged = { ...merged, variants: [...merged.variants, ...moved], aliases: [...new Set(aliases)].filter((a) => a !== merged.id && a !== merged.label && a !== merged.partNumber), ...(axes === undefined ? {} : { options: axes }) };
  }
  const gone = new Set(from);
  return { ok: true, products: products.filter((p) => !gone.has(p.id)).map((p) => (p.id === into ? merged : p)), changed: [into, ...from] };
}

/**
 * Split variants off into a new family: the named variants move (with the option axes they use),
 * the rest stay. The new family starts unnumbered unless given a number.
 */
export function splitProduct(
  products: readonly ProductFamily[],
  from: string,
  variantIds: readonly string[],
  next: { id: string; label: string; partNumber?: string; src?: string },
): ProductEdit {
  const source = findProduct(products, from);
  if (source === undefined) return { ok: false, reason: `there is no product '${from}'` };
  if (!KEBAB.test(next.id)) return { ok: false, reason: `'${next.id}' is not a kebab-case id` };
  if (findProduct(products, next.id) !== undefined) return { ok: false, reason: `a product '${next.id}' exists already` };
  const picked = new Set(variantIds);
  const moving = source.variants.filter((v) => picked.has(v.id));
  if (moving.length === 0) return { ok: false, reason: 'pick at least one variant to split off' };
  if (moving.length !== picked.size) return { ok: false, reason: `${from} does not have every one of those variants` };
  if (moving.length === source.variants.length) return { ok: false, reason: 'a split leaves at least one variant behind (rename the product instead)' };
  const used = new Set(moving.flatMap((v) => Object.keys(v.options ?? {})));
  const options = (source.options ?? []).filter((a) => used.has(a.id));
  const created: ProductFamily = {
    id: next.id,
    label: next.label,
    ...(next.partNumber === undefined ? {} : { partNumber: next.partNumber }),
    ...(options.length === 0 ? {} : { options }),
    variants: moving,
    src: next.src ?? `split from ${source.id}`,
  };
  const kept: ProductFamily = { ...source, variants: source.variants.filter((v) => !picked.has(v.id)) };
  const out: ProductFamily[] = [];
  for (const p of products) {
    if (p.id !== from) out.push(p);
    else out.push(kept, created);
  }
  return { ok: true, products: out, changed: [from, next.id] };
}

/** The next number for a variant of a family, through the scheme (a proposal; nothing is written). */
export function suggestVariantNumber(scheme: PartNumberScheme, product: Pick<ProductFamily, 'label' | 'partNumber'>, known: readonly KnownPartNumber[]): PnSuggestion | undefined {
  return scheme.suggest({ kind: 'design', label: product.label, ...(product.partNumber === undefined ? {} : { variantOf: product.partNumber }) }, known);
}

/** The numbers products hold, for a scheme's `suggest` (so it never proposes one that is taken). */
export function productPartNumbers(products: readonly ProductFamily[] | undefined): KnownPartNumber[] {
  const out: KnownPartNumber[] = [];
  for (const p of products ?? []) {
    if (p.partNumber !== undefined && !/X/.test(p.partNumber)) out.push({ pn: p.partNumber, kind: 'design', label: p.label, source: `products/${p.id}` });
    for (const v of p.variants) if (v.partNumber !== undefined) out.push({ pn: v.partNumber, kind: 'design', label: `${p.label} ${v.label ?? v.id}`, source: `products/${p.id}/${v.id}` });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The lineup
 * ------------------------------------------------------------------ */

export interface LineupRow {
  product: string;
  productLabel: string;
  productPartNumber?: string;
  variant: string;
  variantLabel?: string;
  partNumber?: string;
  design: string;
  designLabel?: string;
  status: DesignStatus;
  route?: PartRoute;
  maker?: string;
  lengthMm?: number;
  options: Record<string, string>;
  /** the design's released revision (approved, when approvals are on) */
  releasedRev?: number;
  /** the design's cost roll-up for one cable, and its currency */
  cost?: number;
  currency?: string;
  aliases: string[];
}

export interface LineupInputs {
  designs?: readonly Pick<CableDesign, 'id' | 'label' | 'status' | 'productRef' | 'route' | 'maker' | 'instances'>[];
  released?: ReadonlyMap<string, number | undefined>;
  costs?: ReadonlyMap<string, { total: number; currency?: string } | undefined>;
}

/** Every variant of every family as a row, in product then variant order. Retired ones are left out unless asked for. */
export function lineupRows(products: readonly ProductFamily[], inputs: LineupInputs = {}, options: { retired?: boolean } = {}): LineupRow[] {
  const designs = new Map((inputs.designs ?? []).map((d) => [d.id, d]));
  const rows: LineupRow[] = [];
  for (const p of products) {
    const labels = new Map((p.options ?? []).map((a) => [a.id, new Map(a.values.map((v) => [v.id, v.label]))]));
    for (const v of p.variants) {
      const design = designs.get(v.design);
      const status = v.status ?? p.status ?? design?.status ?? 'active';
      if (status === 'retired' && options.retired !== true) continue;
      const trunk = design?.instances.segments[0]?.lengthMm;
      const length = v.lengthMm ?? trunk;
      const opts: Record<string, string> = {};
      for (const [axis, value] of Object.entries(v.options ?? {})) opts[axis] = labels.get(axis)?.get(value) ?? value;
      const released = inputs.released?.get(v.design);
      const cost = inputs.costs?.get(v.design);
      rows.push({
        product: p.id,
        productLabel: p.label,
        ...(p.partNumber === undefined ? {} : { productPartNumber: p.partNumber }),
        variant: v.id,
        ...(v.label === undefined ? {} : { variantLabel: v.label }),
        ...(v.partNumber === undefined ? (design?.productRef === undefined ? {} : { partNumber: design.productRef }) : { partNumber: v.partNumber }),
        design: v.design,
        ...(design === undefined ? {} : { designLabel: design.label }),
        status,
        ...(design?.route === undefined ? {} : { route: design.route }),
        ...(design?.maker === undefined ? {} : { maker: design.maker }),
        ...(length === undefined ? {} : { lengthMm: length }),
        options: opts,
        ...(released === undefined ? {} : { releasedRev: released }),
        ...(cost === undefined ? {} : { cost: cost.total, ...(cost.currency === undefined ? {} : { currency: cost.currency }) }),
        aliases: p.aliases ?? [],
      });
    }
  }
  return rows;
}

const csvCell = (value: unknown): string => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The lineup as CSV (RFC 4180): one row per variant, one column per option axis. */
export function lineupCsv(rows: readonly LineupRow[]): string {
  const axes = [...new Set(rows.flatMap((r) => Object.keys(r.options)))].sort();
  const header = ['product', 'product_label', 'product_part_number', 'variant', 'variant_label', 'part_number', 'design', 'design_label', 'status', 'route', 'maker', 'length_mm', ...axes.map((a) => `option_${a}`), 'released_rev', 'cost', 'currency', 'aliases'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.product, r.productLabel, r.productPartNumber, r.variant, r.variantLabel, r.partNumber, r.design, r.designLabel, r.status, r.route, r.maker, r.lengthMm, ...axes.map((a) => r.options[a]), r.releasedRev, r.cost, r.currency, r.aliases.join('; ')]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
