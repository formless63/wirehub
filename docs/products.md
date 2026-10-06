# Products, variants, the lineup and routes

A design documents one cable. A shop **sells products**: a family of builds that differ in length,
colour or an option, each documented by a design, each with its own number. WireHub keeps those
families as data, checks them against the designs and the numbering scheme, and lists them as a
**lineup** a catalog, a web shop or an ERP can read. Every part and design may also say how it is
**sourced** — made in house, by a contract manufacturer, or bought in.

The engine is in the base (`@wirehub/model` `products.ts`); the products themselves are data
(`products.json`, edited in the app, or shipped by a pack).

The cable list shows each design's family and variant in the Product column. An open cable's
header links those memberships to the family pages. Both the cable list and Quick open search
family names, declared aliases, variant names and ids, and family and variant part numbers.
Membership comes from the variant's design reference; matching a part number alone does not
make a design part of a family.

## Product families

```json
{
  "id": "dc-leads", "label": "DC leads", "partNumber": "CBL-00090-XX",
  "aliases": ["Power leads", "CBL-00012"],
  "options": [{ "id": "colour", "label": "Colour", "values": [{ "id": "black", "label": "Black" }, { "id": "red", "label": "Red" }] }],
  "variants": [
    { "id": "led", "label": "LED lead", "design": "dc-led-lead", "partNumber": "CBL-00090-01", "options": { "colour": "black" } },
    { "id": "pigtail-300", "design": "dc-pigtail-lead", "partNumber": "CBL-00090-02", "lengthMm": 300, "options": { "colour": "red" } }
  ],
  "src": "synthetic example"
}
```

- `partNumber`: the family's number — one number, or a **family pattern** whose `X`s the
  variants fill (`CBL-00090-XX` → `CBL-00090-01`), the same notation as a drawing's length family.
- `aliases`: the names and numbers the product is also known by (an old number, a marketing name,
  a family merged into this one). Search and the lineup carry them.
- `options`: the axes the builds differ on besides length; a variant names a value per axis.
- `variants`: each a build, documented by one `design`, with its own `partNumber`, its
  `lengthMm` (the design's trunk length otherwise), its option values, a `status` and a `note`.
- `status`, `tags`, `description`, and the licence and provenance fields like any record.

### Checks

`productIssues(products, { designs, scheme, released })` — run by the API on every save (errors
refuse it) and shown on the product pages:

| Code | Severity | |
| --- | --- | --- |
| `product-duplicate`, `product-bad-id`, `product-no-label`, `product-variant-duplicate` | error | ids |
| `product-variant-design` | error | a variant names a design that does not exist |
| `product-option-unknown` | error | a variant sets an axis or a value the family does not declare |
| `product-variants-ambiguous` | warning | two variants of one family are the same design, length and options |
| `product-design-shared` | warning | one design is a variant of two families |
| `product-variant-pn` | warning | a variant's number is outside its family's pattern |
| `product-pn-format` | warning | the numbering scheme objects to a number |
| `product-variant-unreleased` | warning | a sold (active) variant's design has no released revision (the approved one when approvals are on) |

`validateDb` runs the structural checks on `Db.products` too.

### Part numbers

Product and variant numbers are part numbers like any other: they count as taken for every
suggestion (`knownPartNumbers`), and the Part numbers page reports a number used twice. A variant
numbered like its own design's `productRef` is the same thing, not a duplicate. **Next number** on
a family asks the scheme for its next variant (`suggestVariantNumber`, the scheme's `variantOf`): a
declarative scheme with a variant segment proposes the next free variant of the family's number.
Nothing is written until a person accepts it.

## Merge and split

- **Merge** (`mergeProducts`): families once sold separately become one. The variants move into the
  target (ids made unique), option axes join, and each merged family's id, name, number and aliases
  become aliases of the target; the merged families are removed.
- **Split** (`splitProduct`): variants that should be sold on their own become a new family, with the
  option axes they use. At least one variant stays behind.

Both are one change set and raise `product.changed` for every family they touch.

## The lineup

`lineupRows(products, { designs, released, costs })` lists every variant of every family as a row:
family, variant, number, design, status, route and maker, length, option values (by label), the
design's **released revision**, its **cost roll-up** for one cable (the BOM's, from the parts'
prices and the labour, `docs/interop.md`) with its currency, and the family's aliases. Retired
variants are left out unless asked for. `lineupCsv` writes it as CSV (one column per option axis).

## Routes: make, contract, buy

Any library record (`RecordMeta`) and any design may carry:

- `route`: `make` (in house), `contract` (a contract manufacturer builds it) or `buy` (bought in finished);
- `maker`: who builds it, for `contract`;
- `suppliers`: `[{ supplier, number?, note? }]`, who sells it, for `buy` (a component's existing
  `suppliers`, or its `manufacturer` and `mpn`, count too).

`validateDb` and `validateDesign` warn about a `buy` record with no supplier
(`route-buy-no-supplier`) and a `contract` one with no maker (`route-contract-no-maker`); a route
that is not one of the three is an error (`invalid-route`). Declarative validation rules can select
by it too (`docs/validation-rules.md`). The cable list shows a `MAKE` / `CM` / `BUY` badge, the
Library a flag, and the lineup a column. The editor's Notes tab sets a design's route; each part
editor has a Sourcing section.

## In the app

- **Products** (`/products`, the rail): the families with their number, variants and problems,
  **New product…**, and the **Lineup** tab with JSON and CSV downloads.
- **A family's page** (`/products/<id>`): its variants with their designs, numbers, lengths, options,
  released revisions, costs and routes; **Add a variant…** (pick a design, **Suggest** a number,
  pick options), **Merge** other families in, **Split** variants off, **Edit as JSON…**.

## The API

| Route | |
| --- | --- |
| `GET /api/products` | the families (with `origin`: `local` / `pack`), their issues, the ETag |
| `PUT /api/products` | `{ products: [...] }`: this hub's own families (If-Match); refused (422) with errors |
| `GET /api/products/:id` | one family, its variants as lineup rows, its issues |
| `POST /api/products/:id/merge` | `{ from: [ids] }` |
| `POST /api/products/:id/split` | `{ variants: [ids], id, label, partNumber? }` |
| `GET /api/products/:id/next-number` | the scheme's proposal for the family's next variant |
| `GET /api/lineup`, `GET /api/lineup.csv` | the lineup (`?retired=1` includes retired variants) |

The families are the catalog document `data/products.json`, written through the unit of work on
both backends. Every change raises the **`product.changed`** webhook (`docs/webhooks.md`), whose
payload links the family and the lineup.

## What a private pack supplies

Only data: its product families, their numbers and aliases, its routes and makers on its own records.
