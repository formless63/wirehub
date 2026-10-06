# Standard work

An optional MIT module for operation-time estimates. It is not registered in the
default Studio manifest and ships no factory timing values. Install a signed
runtime bundle and enable it explicitly, or add it to your deployment's module
manifest (`docs/modules.md`). The inspector editing capability requires module API 1.4 or newer.

The cable inspector holds a table of operator-supplied times and sources. Each
operation has an explicit quantity and a `per-cable` or `per-batch` basis. Missing
times are invalid; an explicit zero is valid. An empty table may be saved to
clear the configuration, but has no estimate to adopt or export. Nothing infers
times from connector counts, contacts or bench instructions.

The saved value is `design.extensions['standard-work']`:

```ts
{
  schema: 1,
  operations: [
    { id, label, minutes, quantity, basis: 'per-cable' | 'per-batch', src }
  ],
  adoption?: { builds, minutes }
}
```

Use a measurement, an agreed work instruction or another traceable timing source
in every operation's `src`. The module starts with `operations: []`.

For build quantity `N`, the estimate is:

- `perCableMinutes = sum(minutes × quantity)` for per-cable operations;
- `batchMinutes = sum(minutes × quantity)` for per-batch operations;
- `runMinutes = N × perCableMinutes + batchMinutes`;
- `allocatedPerCableMinutes = perCableMinutes + batchMinutes / N`.

Totals round to six decimal places after calculation. Positive measurements too
small for that rounding remain positive. Up to 500 operations are accepted;
minutes and quantities are finite values from 0 to 1,000,000; build quantity is
a whole number from 1 to 1,000,000. Totals over 1,000,000,000 minutes are refused
before reporting or adoption, and monetary arithmetic is checked before rounding.

Saving operation edits preserves the existing design `labourMinutes` and its
prior adoption metadata. **Adopt labour** is a separate user action: it stores
the allocated per-cable time in `labourMinutes`, and records the chosen build
count and adopted minutes. Later time or build-count changes never recalculate
that saved labour automatically. Review and adopt again when needed. A prior
adoption records its calculation; it is not a claim that a later table is current.

The CSV exporter uses the saved table and an optional positive whole `builds`
option (default 1). It separates operation times, per-cable work, batch setup,
build total, allocated per-cable time and previously recorded labour. Prices use
the ordinary `db.rules.costing.labourRatePerHour` and `currency`; no rate or no
currency means blank, unpriced labour cost. An explicit zero hourly rate is
accepted. No exchange-rate conversion is applied. Rates must be finite values
from 0 to 1,000,000 per hour. Text fields are escaped against spreadsheet formulas.

The module supplies a validation rule for invalid stored settings, an inspector
panel and the CSV exporter. It has no catalog pack, integrations, commit hook or
automatic write path. Pure helpers are exported from `src/logic.ts`; all adoption
returns a detached design for the host's normal edit, save and read-only controls.

Build a runtime bundle using the normal module command, for example:

```bash
pnpm --filter studio wirehub-module build modules/standard-work \
  --out dist-module --key publisher.key --zip
```

The signing key belongs outside the repository. See `templates/store/README.md`
for store publishing. Test with
`pnpm --filter @wirehub/module-standard-work exec vitest run --maxWorkers=2`,
and build with `pnpm --filter @wirehub/module-standard-work build`.
