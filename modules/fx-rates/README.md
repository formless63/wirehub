# Optional FX reference rates

This MIT module provides an explicit manual ECB refresh, a saved design snapshot
and a CSV cost estimate. It is absent from the default Studio module list and
requires no API key. Installing the module opts into the manual network route;
loading a design, opening a revision and exporting never fetches rates.

## Install and use

Build a signed runtime bundle from this checkout with the standard module CLI:

```sh
pnpm --filter studio wirehub-module build ../../modules/fx-rates \
  --export fxRates --out /tmp/wirehub-modules --zip \
  --key /path/to/publisher-private-key.pem \
  --publisher-id your-publisher --publisher-name 'Your publisher'
```

An owner reviews the permissions and installs the signed ZIP with a pinned
publisher public key on a compatible host. This checkout's editable panel API
requires module API 1.4; the released v0.4.0 image does not provide it.

The cable inspector fetches only when the user requests it. Preview the rates,
choose a target currency and explicitly save to the working design. The snapshot
is stored under `design.extensions['fx-rates']`:

```json
{
  "schema": 1,
  "snapshot": {
    "base": "EUR",
    "date": "2026-01-02",
    "rates": { "USD": 2, "GBP": 0.5 },
    "source": "synthetic example",
    "retrievedAt": "2026-01-03T04:05:06Z"
  },
  "target": "USD"
}
```

These example rates are synthetic. A fetched snapshot records the fixed ECB
source URL, the observation date and the separate retrieval time. Each rate is
currency units per EUR; EUR itself is implicitly one. Save a design revision to
pin that snapshot with the revision. Refreshing never rewrites catalog prices,
labour rates, existing revisions or the design automatically.

## Reports

The saved-snapshot exporter keeps original currency, purchasing unit, unit price
and extended amount alongside the conversion factor and converted values. Build
quantity selects the ordinary BOM's applicable price tiers. Subassembly details
use their working or pinned design and definitions, scale quantities through the
hierarchy and include child prices once. Child foreign-currency costs are retained
rather than converting an incomplete base subtotal. Labour needs an explicit
organisation currency; a material price does not establish labour's currency.

A source currency absent from both the price and organisation settings is unknown.
Missing prices and unsupported rates are excluded with a reason and the included
amount is labelled **subtotal**. Same-currency amounts use factor one. Cross rates
use `target rate / source rate` through EUR. Currency conversion adds no shipping,
tax, bank fee, spread or transaction guarantee. The report changes no engineering
or cost data; opening an older revision keeps that revision's saved snapshot.

## ECB data and conditions

The module uses the ECB's [daily XML download](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml)
linked from its [reference-rate page](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html).
The ECB normally updates on working days; weekends and closing days can therefore
leave the latest observation older than retrieval. The ECB describes these rates
as informational and discourages using them for transactions. Reports are derived
reference estimates, not executable currency quotes.

The ECB also offers [Data Portal API information](https://data.ecb.europa.eu/help/api/overview)
for broader datasets; this module deliberately reads only the daily download.
Its [data-use conditions](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)
require accurate reproduction and source attribution, explicit identification of
modifications, and additional notices when information is incorporated in sold
documents. Reports retain the ECB source and dates and label converted values as
derived. A publisher selling reports must provide the required free-source notice.
The MIT licence covers the module's code, not a new licence for ECB data. Only
synthetic data is committed in this repository.

Network reads use one fixed HTTPS endpoint, refuse redirects, cap decoded content
at 64 KiB and have a ten-second deadline. The strict daily XML parser rejects
entities, DTDs, unknown structure, duplicate currencies and invalid rates or dates.
The route returns a validated snapshot or a generic error, never a raw response.

## Validation

```sh
pnpm --filter @wirehub/module-fx-rates exec vitest run test/logic.test.ts test/network.test.ts --maxWorkers=2
pnpm --filter @wirehub/module-fx-rates build
```

Pure and network tests use synthetic fixtures and injected transport/clock;
no network response becomes bundled catalog data.
