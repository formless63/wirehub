# Workshop inventory

What a workshop has on its shelves, where, and what a build of a design takes from it. Inventory
is optional: nothing in design work waits for it, and costs are never required. It is not an ERP:
no purchasing, invoicing or accounting.

## Records

- **Locations** form a tree (a room, a shelf in it, a bin on the shelf). A location with lots or
  locations in it cannot be removed.
- A **lot** is stock of one library record (connector, wire, component, board, part) or of a
  design kept built (a lead used as a sub-assembly). It sits in one location and is counted in one
  dimension: **count** (`ea`), **length** (entered in `mm`, `cm`, `m`, `in` or `ft`, kept in mm) or
  **mass** (`g`, `kg`, `oz`, `lb`, kept in g) or **volume** (`ml`, `l`, kept in ml: resin). Wire
  defaults to length, everything else to count.
  A lot may carry a lot or reel code, a supplier and the supplier's reference, a unit cost and a
  note. These details can be corrected after receipt (**Details…** on a lot); the quantity cannot,
  except through a movement.
- The **ledger** lists every movement: receive, move, split, adjust (with a reason), consume,
  return, and edit (a lot's details changed: quantity 0, the note says what each field was and is). It is append-only: on Postgres the app's role may insert into it and never change it.
  A lot's on-hand balance is the sum of its movements, kept materialised beside it in the same
  transaction; what is held for builds is materialised the same way. Neither can go below zero,
  and on hand never drops below what is held.
- A **reservation** holds stock for a build of a design: `qty` finished units of its working copy
  (or a saved revision). It counts the units finished against it so far.
- A **batch** records units made: finished units of a design build (against its reservation) or a
  print of a part (against one of its manufacturing variants). It holds the good and the failed
  count, optional serials (one per good unit, unique per item) and a batch code, and what was
  measured: the time it took and the mass of one good unit. Like the ledger it is written once and
  never changed; the stock it used and the lot it produced are ledger movements carrying its id.
  A measured unit mass is shown beside the one derived from the parts' recorded masses
  (`405.1 g measured · ≥ 398 g derived`, `docs/mass.md`); the derived one is an estimate only.

## A build of a design

What a build needs comes from the design's BOM (`deriveBom`): one line per library item. A board
is one item; a purchased assembled board never adds its own components. A placed sub-assembly is
one item (a built design from stock), or, with *sub-assembly parts*, its parts are listed instead.

Wire is planned as cut pieces. Two allowances are set per build and default to none: extra length
per cut (strip, trim, service) and a scrap percentage on cut or weighed stock (never on counted
parts). A wire line without a length is **unknown**, not zero: the line names each run that has
no length yet (on hover) and still shows a floor, `≥ 1.2 m`, from the runs that do; its shortage
is then `≥` too. A shortage is `≤` when lots counted another way might cover part of it.

The shortage view answers, per item: needed, free (on hand and not held), held by this design's
open builds, already used by them, and short. Lots counted another way (a reel weighed instead of
measured) are shown, never added in. A short item carries a make/buy hint from its record's
route; without a route, a design is assumed made and a part bought, and the hint says so.

Reserving holds counted and weighed stock oldest-first. Length is held cut by cut, each cut from
one lot (best fit), so a reservation never promises a cut that would span two reels. What cannot
be held stays short on the reservation. Consuming takes stock out per finished unit (counted parts
whole) or per named lot; a cut-off goes back onto its reel with **Return**; **Release** frees what
is still held. A reservation with nothing left held closes. After the last unit is finished,
**Return leftover…** remains available on the completed batch in the design's Build panel and
**Inventory → Made**; it returns material to the original named lot.

**Finish units** records part of a build (3 of 10 today) or the rest. Each good or failed unit
takes its share of what the reservation holds; a failed unit on top of the plan takes its share
from the same lots' free stock as far as there is any (the record is never refused for it). The
batch keeps serials, code, time and note, and with *put in stock* the good units are received as a
counted lot of the design, coded with the batch. Once every unit is done, whatever is still held is
let go and the reservation closes; until then it stays open even if its holds ran out.

## Offers, cost and wire waste (optional)

A library record may carry **dated supplier offers** (its *Offers* section, or *Supplier offer…*
in its Add menu): supplier, their number, price and currency per a unit, the pack it comes in, the
day. Every part but the supplier is optional, and an offer is never changed: a newer price is a
newer offer, and the newest one per supplier (on or before today) is the current one.

When anything is priced, the build view adds a **Cost** column and one footer line. What comes from
stock is priced at its lots' own unit costs, oldest received first; what must be bought, at the
cheapest current offer (in whole packs when it names one), else the record's catalog `cost`. A line
with no price, or whose prices mix currencies, is *unpriced* and left out of the total; totals are
kept per currency (no exchange rates are applied). An open need is priced on its floor (`≥`).

For each wire whose cuts are known, the build also projects where the length goes (hover the
*Needed* cell): the cuts, the per-cut allowance and scrap, the cuts placed on free reels (best fit,
longest first, never spanning two reels), the **drops** left on those reels shorter than any cut,
and what must be bought, as packs when a current offer names a pack size. The footer sums the wire
waste. None of it gates a reservation or a build.

## Prints

A part's **Prepare print** panel lists its manufacturing variants (`docs/jobs-and-tool-packs.md`) and,
under them, the prints made. **Record a print** takes the variant, good and failed parts, the
actual print time and part mass (shown beside the slicer's estimate), the filament used from a
weighed lot or the resin from a lot counted by volume (empty: the estimate times the prints), and
optionally a location for the good parts. Nothing is sent to a printer; it records what a person did.

**+ New spool…** (in *Filament from* / *Resin from*, and in Receive's item picker) makes a part for a
spool or bottle that is not in the library yet and receives its first lot in the same action (and a
"Workshop" location when the hub has none).

## Units and test results

Each good unit of a design batch is a **built unit**, named by its serial (or by its batch code and
place, `B-12 #3`); its id is the batch id and its place (`bat-0123456789.3`). The design's Build
panel and the inventory's **Units** tab list them. A unit may carry test results — continuity or
bench, pass or fail, an optional note — recorded with **Result…**. Nothing asks for one, and a
re-test is a new record; a result is never changed.

A result keeps a fingerprint of what it covered at the design state the unit was built to (the
batch's revision; for a unit built from the working copy, the working copy when the result is
recorded). Continuity covers the derived continuity spec as a meter sees it — nets by their ports,
paths and whether DC reads through, isolation pairs, deliberate opens, pigtail landings — so a
renamed label does not touch it and a moved wire does. Bench covers the whole design. On read it is
compared with the design's latest saved version: unchanged, the result applies (`current`, or
`carried` onto a newer revision); changed, it is **stale**, with a few words on what changed
(`Rev 3: 2 checks added`). Staleness only informs; it blocks nothing.

Firmware commissioning (`docs/firmware.md`) links a record to a built unit when its unit reference
is a unit id or a serial exactly one built unit carries; the unit's panel lists its commissioning.

## Several people at once

Every write raises the `inventory` server event (`GET /api/events`; on Postgres a `NOTIFY
studio_inventory` at commit, so every process's browsers hear it), and open pages refetch their
inventory views: another person's receipt or build shows without a reload.

Lots are locked for a change in id order, so two people consuming the same reel serialise. Two
builds can still lock lots of different items in opposite orders (their BOMs list the same parts
differently); Postgres then breaks the deadlock by failing one transaction (`40P01`). The engine's
transactions are pure over the store, so the store runs the failed one again (twice at most); one
that keeps losing answers **409** "try again". Nothing is ever half-written, and a deadlock is never
a 500.

## Where it is kept

The inventory has its own storage seam (`apps/studio/server/inventory/store.ts`): the file backend
keeps it under the data directory (`.inventory/state.json`, the append-only `ledger.jsonl` and `offers.json`,
never part of the catalog or its git export); the database backend keeps it in its own tables
(migrations `0028_inventory.sql`, `0032_inventory_batches.sql`, `0033_inventory_volume.sql`, `0034_unit_tests.sql` and `0035_inventory_offers.sql`, row-level security per
organisation; the app may only insert into the ledger, the batches and the unit test results). Unit test results are
`.inventory/unit-tests.jsonl` on files. It is not catalog data:
no change set, history entry or catalog export carries it. Back it up with the data directory or
the database.

## API

`/api/inventory` (locations, lots, open reservations), `POST /api/inventory/locations`,
`PATCH|DELETE /api/inventory/locations/:id`, `POST /api/inventory/receive`,
`GET|PATCH /api/inventory/lots/:id`, `POST /api/inventory/lots/:id/move|adjust`,
`GET /api/inventory/items/:kind/:id`, `GET /api/inventory/movements`,
`GET /api/inventory/builds/:design?qty=&perCutMm=&pct=&explode=1&rev=`,
`GET|POST /api/inventory/reservations`, `GET /api/inventory/reservations/:id`,
`POST /api/inventory/reservations/:id/consume|return|release|complete`,
`GET|POST /api/inventory/batches` (`?item=kind:id`, `?reservation=`),
`GET|POST /api/inventory/offers` (`?item=kind:id`), `DELETE /api/inventory/offers/:id`.
`GET /api/units?design=` (built units, latest result per kind with `applies`), `GET /api/units/:unit`,
`POST /api/units/:unit/tests` (`{ kind: continuity|bench, result: pass|fail, note? }`).

A build answers `sourcing` beside its lines: per line `cost` (`parts` from stock, an offer or the
catalog, `amount` and `currency` when whole, `atLeast`, `reason`) and, for cut stock, `waste`
(`cut`, `allowance`, `scrap`, `fromStock`, `drop`, `buy`, `packs`, `pack`, `leftover`); `totals` per
currency and the `unpriced` count. An offer is `{ item, supplier, offeredOn?, price?, currency?,
unit, pack?, supplierRef?, note? }` (`offeredOn` defaults to today).

A build also answers `massEstimate: { g, bound, missing }`, one unit's derived mass (`docs/mass.md`);
`GET /batches` (and a build's `batches`) add `massEstimate: { g, bound }` beside each batch with a measured
`unitMassG`: a design build weighed at the batch's revision (else the working copy), a printed part by its
record's `mass`. `measured` is never changed, and neither figure goes into an export.

`complete` takes `{ units, failed?, serials?, batchCode?, measured?: { durationS?, unitMassG? },
into?, note? }` with the reservation's `If-Match`; `POST /batches` takes the same plus `item`,
`variant?` and `consume: [{ lot, qty, unit }]`. `PATCH /lots/:id` takes any of `lotCode`,
`supplier`, `supplierRef`, `unitCost` (with `unit`, the unit the price is per), `currency`, `note`
(`null` clears) and needs `If-Match` (428 without it).

Viewers read; owners and editors write; an API token writes with `catalog:write`. Lots, locations
and reservations answer an `ETag` and refuse a stale `If-Match` (409); balances are guarded by the
transaction itself. Every write but an offer raises the `inventory.changed` webhook event (`docs/webhooks.md`; a batch's subject
kind is `batch`).
