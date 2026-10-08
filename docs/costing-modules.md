# Optional FX and operation-time costing

The `fx-rates` and `standard-work` modules are installed separately as signed
runtime modules. They are absent from the default module list. Their saved
settings live in the cable design's extensions, so revisions retain the rates
and timings selected for them. A bundle built from this checkout records its module API version
(`MODULE_API_VERSION`, now 1.5) and runs on a hub at that version or a newer minor.

## FX reference rates

In the cable inspector, retrieve the current ECB reference-rate snapshot, select
the report currency and build quantity, and save the snapshot. Retrieval is manual; opening a design
or generating a document never fetches rates. The selected snapshot shows its
observation date, retrieval time and source. A failed retrieval keeps the previous
snapshot available.

Download an FX costing CSV from the panel, or export using the saved snapshot in
Documents. The report retains original amounts and currencies alongside converted
amounts. It applies quantity breaks at the chosen build quantity and includes
priced subassembly details without counting their roll-ups twice. Missing prices,
rates and currencies stay explicitly excluded; the reported sum is labelled a
subtotal. Reference rates describe an estimate; settlement fees and transaction
rates are outside this report. Catalog prices are preserved.

The rate table expresses currency units per euro. Conversion from currency A to B
uses `amount / rate[A] * rate[B]`, with the euro rate equal to one. A known amount
already in the target currency needs no conversion. The underlying BOM continues
using the base's conservative, offline cost rules.

## Standard work

Add named operations with explicit minutes, quantity, timing basis and source.
Use per-cable rows for repeated assembly work and per-batch rows for setup. New
rows start with an unknown time; there are no invented factory measurements.

For N cables, the estimate is:

```
run minutes = N * per-cable minutes + batch minutes
allocated minutes per cable = per-cable minutes + batch minutes / N
```

Saving the operation table records settings without changing the design's existing
`labourMinutes`. Choose **Adopt labour estimate** to write the allocated minutes
to the working design explicitly, then save normally. Adoption records the chosen
build count and minutes in the extension. Re-adopt when timings or batch quantity
change; subsequent edits do not silently update the adopted total.

The labour CSV separates operations, setup and the batch total. It uses the
engineering settings' explicit hourly rate and currency when both are present;
otherwise labour remains unpriced. A valid explicit zero is supported, but an
empty table or missing measurement cannot be adopted as free labour.

## Editing and revisions

Both panels use the editor's normal draft, validation, undo and save path. Locked
designs and saved revisions expose no edit callback. A stale callback cannot
replace a newer draft or another cable. Document exports read saved module settings;
panel downloads can report the selected draft settings before they are saved.

See the module READMEs for signed build/upload instructions and provider details:
[FX rates](../modules/fx-rates/README.md) and
[standard work](../modules/standard-work/README.md).
