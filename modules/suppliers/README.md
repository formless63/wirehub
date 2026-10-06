# Optional supplier connections

This MIT module adds manual Mouser, DigiKey and LCSC lookups, a Library offers
panel, a Suppliers page and procurement CSV downloads. It is absent from the
default Studio module list. Each provider starts disabled, and requires an
approved API account and deployment-owned credentials.

## Install

Build a signed runtime bundle from this checkout:

```sh
pnpm --filter studio wirehub-module build ../../modules/suppliers \
  --export suppliers --out /tmp/wirehub-modules --zip \
  --key /path/to/publisher-private-key.pem \
  --publisher-id your-publisher --publisher-name 'Your publisher'
```

An owner pins the publisher's public key in Settings, then uploads the signed ZIP
and reviews its code permissions. Runtime code must be enabled on the host. The
builder targets this checkout's module API; a bundle built here currently needs
API 1.3, so use a matching host rather than the released v0.4.0 image.

## Deployment configuration

Set `WIREHUB_SUPPLIERS_PROVIDERS=mouser,digikey,lcsc` to enable the adapters you
want; omit names to disable them. Credentials stay on the server:

| Provider | Environment variables | Official access/documentation |
| --- | --- | --- |
| Mouser | `WIREHUB_SUPPLIERS_MOUSER_KEY` | [Search API registration](https://www.mouser.com/en/api-search/), [V2 schema](https://api.mouser.com/api/docs/V2) |
| DigiKey | `WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_ID`, `WIREHUB_SUPPLIERS_DIGIKEY_CLIENT_SECRET`, `WIREHUB_SUPPLIERS_DIGIKEY_ACCOUNT_ID` | [Developer resources](https://developer.digikey.com/resources); Product Information V4, client credentials with Account ID |
| LCSC | `WIREHUB_SUPPLIERS_LCSC_KEY`, `WIREHUB_SUPPLIERS_LCSC_SECRET` | [Approved agent access](https://www.lcsc.com/agent), [current documentation](https://www.lcsc.com/docs/index.html), [linked v3.4 guide](https://wmsc.lcsc.com/crm/download/api/doc) |

LCSC uses the current `api.lcsc.com` API with SHA-256 request signatures. The
older `ips.lcsc.com` SHA-1 documentation describes a different API.

Supply configuration to both Studio and its worker when using Postgres jobs.
The host's `NAME_FILE` secret convention can load values from mounted files.
The Settings panel reports enabled/configured flags and never returns keys.
Credentials are deployment-wide; this version has no per-organization secret
editor. Ordinary WireHub use works with all suppliers disabled.

## Lookup and review

Lookups require an exact supplier number or manufacturer part number. An optional
manufacturer narrows matches. Quantity, currency and country are explicit.
Results include observation time, available price breaks, stock, MOQ, order
multiples and packaging when the API supplies them. Unsupported or mismatched
currency leaves prices unavailable; there is no currency conversion. There is
no automatic refresh or cache: each lookup consumes provider quota. Requests
have bounded response sizes and deadlines; retry hints remain visible for manual
retry. Stopping polling does not cancel an already queued job.

Pricing units often remain unconfirmed because a packaging description does not
establish each-versus-metre pricing. Confirm the basis before downloading a
selected quote. Import that `.supplier-quote.json` through the normal reviewed
import flow to propose a cost and supplier-number update for an editable record.
Fork installed pack records first. Review currency, tiers, MOQ, packaging and
order multiples before applying; incompatible existing MPN/manufacturer values
are rejected. Importing appends source/provenance and a supplier-terms licence
reference. It does not silently refresh canonical costs or existing revisions.

Offers and downloaded quotes are private deployment data, subject to the
provider's account and redistribution terms. Do not publish imported quotes as
CC0 catalog data. This repository contains synthetic fixtures only. Supplier
fees, shipping, tax and foreign exchange are not included in unit prices.

The cable procurement CSV derives quantities from the ordinary BOM, optionally
multiplied by build quantity. PCBAs remain whole parts; board-parts purchasing
is outside this module. There is no automatic substitution or purchasing.

## Validation

```sh
pnpm --filter @wirehub/module-suppliers exec vitest run --maxWorkers=2
pnpm --filter @wirehub/module-suppliers build
pnpm --filter studio exec vitest run test/suppliers.dom.test.tsx test/suppliers-build.server.test.ts --maxWorkers=2
```

Synthetic tests exercise all three schemas, signing, failure handling, exact
matching and reviewed adoption. Signed server/browser bundles are tested without
network access. Live account acceptance requires the owner's approved credentials;
it has not been performed with public fixtures.
