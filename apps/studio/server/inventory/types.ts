/**
 * Workshop inventory (`docs/inventory.md`): locations, lots of a library item, the append-only
 * ledger of movements and reservations against a design build. Not catalog data: no change set,
 * catalog export or git mirror reads it; the stores keep it beside the catalog (files) or in its
 * own tables (Postgres, migration 0028).
 *
 * Quantities are kept in one base unit per dimension — count in `ea`, length in `mm`, mass in
 * `g`, volume (resin) in `ml` — and converted at the edge (`toBase`, `fromBase`). Costs are optional and never a gate.
 */

/** The library kinds a lot can be of; `designs` is a built cable or sub-assembly kept in stock. */
export type ItemKind = 'connectors' | 'wires' | 'components' | 'pcbas' | 'mechanicals' | 'designs';
export const ITEM_KINDS: readonly ItemKind[] = ['connectors', 'wires', 'components', 'pcbas', 'mechanicals', 'designs'];

export interface ItemRef {
  kind: ItemKind;
  id: string;
}

export const itemKey = (item: ItemRef): string => `${item.kind}:${item.id}`;

export type Dimension = 'count' | 'length' | 'mass' | 'volume';
export const DIMENSIONS: readonly Dimension[] = ['count', 'length', 'mass', 'volume'];
export const BASE_UNIT: Readonly<Record<Dimension, string>> = { count: 'ea', length: 'mm', mass: 'g', volume: 'ml' };

/** Every unit a quantity may be entered in, with its dimension and its size in the base unit. */
export const UNITS: Readonly<Record<string, { dim: Dimension; factor: number }>> = {
  ea: { dim: 'count', factor: 1 },
  mm: { dim: 'length', factor: 1 },
  cm: { dim: 'length', factor: 10 },
  m: { dim: 'length', factor: 1000 },
  in: { dim: 'length', factor: 25.4 },
  ft: { dim: 'length', factor: 304.8 },
  g: { dim: 'mass', factor: 1 },
  kg: { dim: 'mass', factor: 1000 },
  oz: { dim: 'mass', factor: 28.349523125 },
  lb: { dim: 'mass', factor: 453.59237 },
  ml: { dim: 'volume', factor: 1 },
  l: { dim: 'volume', factor: 1000 },
};

/** Base quantities keep six decimals: no float dust in a ledger that is summed for years. */
export function roundQty(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0;
}

export function toBase(qty: number, unit: string): { dim: Dimension; value: number } | undefined {
  const u = UNITS[unit];
  return u === undefined ? undefined : { dim: u.dim, value: roundQty(qty * u.factor) };
}

/** The dimension a new lot of this kind is counted in when the receipt does not say. */
export function defaultDimension(kind: ItemKind): Dimension {
  return kind === 'wires' ? 'length' : 'count';
}

export interface Location {
  id: string;
  name: string;
  /** the containing location; absent = a top-level location */
  parent?: string;
  note?: string;
  version: number;
  createdAt: string;
}

export interface Lot {
  id: string;
  item: ItemRef;
  dim: Dimension;
  location: string;
  /** the maker's or supplier's lot / batch / reel code */
  lotCode?: string;
  supplier?: string;
  /** the supplier's order or delivery reference */
  supplierRef?: string;
  /** optional price per base unit (ea, mm or g); never required */
  unitCost?: number;
  currency?: string;
  note?: string;
  /** the lot this one was split from (a partial move) */
  parent?: string;
  receivedAt: string;
  /** materialised from the ledger: the sum of this lot's movements */
  onHand: number;
  /** materialised from the open reservations: allocated and not yet consumed */
  reserved: number;
  version: number;
}

/** `edit`: a lot's details (code, supplier, cost, note) changed; quantity 0, the change in `note` */
export type MovementKind = 'receive' | 'move' | 'split' | 'adjust' | 'consume' | 'return' | 'edit';
export const MOVEMENT_KINDS: readonly MovementKind[] = ['receive', 'move', 'split', 'adjust', 'consume', 'return', 'edit'];

/** One line of the ledger. Never changed or removed once written. */
export interface Movement {
  /** ledger order, assigned by the store */
  seq: number;
  at: string;
  /** who: a person's name or email, a token's holder */
  by: string;
  kind: MovementKind;
  lot: string;
  item: ItemRef;
  /** signed, in the lot's base unit; 0 for a whole-lot move */
  qty: number;
  onHandAfter: number;
  from?: string;
  to?: string;
  reason?: string;
  reservation?: string;
  /** a split's other half */
  otherLot?: string;
  /** the batch (built units, a print) this consumption or receipt belongs to */
  batch?: string;
  note?: string;
}

export interface Allowance {
  /** extra length cut per piece (strip, trim, service), mm */
  perCutMm: number;
  /** extra on every line, percent (scrap, test pieces) */
  pct: number;
}

export interface Allocation {
  lot: string;
  qty: number;
  consumed: number;
  returned: number;
}

export interface ReservationLine {
  item: ItemRef;
  dim: Dimension;
  label: string;
  /** what the build needs, base unit, allowance included */
  needed: number;
  /** what one finished unit takes (allowance included): what consuming one unit takes */
  perUnit?: number;
  allocations: Allocation[];
  /** released: nothing more is held for this line */
  released?: boolean;
}

export interface Reservation {
  id: string;
  design: string;
  /** a saved revision; absent = the working copy at the time */
  rev?: number;
  buildQty: number;
  label?: string;
  status: 'open' | 'closed';
  allowance: Allowance;
  lines: ReservationLine[];
  createdAt: string;
  createdBy: string;
  closedAt?: string;
  /** finished units recorded against this build so far (`completeUnits`); absent = none */
  unitsDone?: number;
  version: number;
}

/** What was measured on a batch: actual time and the mass of one good unit. Both optional. */
export interface Measured {
  /** wall-clock time the batch took (a print's actual print time), seconds */
  durationS?: number;
  /** mass of one finished good unit, g */
  unitMassG?: number;
}

/**
 * A batch of made units: finished units of a design build (against its reservation) or a print
 * of a mechanical record (against a manufacturing variant). Written once and never changed, like
 * the ledger; what it consumed and the stock it produced are ledger movements carrying its id.
 */
export interface Batch {
  id: string;
  item: ItemRef;
  /** the design revision built (from the reservation) */
  rev?: number;
  reservation?: string;
  /** the print manufacturing variant used */
  variant?: string;
  /** good units made */
  units: number;
  /** units started and scrapped (a failed print, a reworked lead) */
  failed: number;
  batchCode?: string;
  /** one per good unit, in order, when they are serialised */
  serials: string[];
  measured: Measured;
  /** the lot the good units were received into, when kept in stock */
  outputLot?: string;
  note?: string;
  at: string;
  by: string;
}

/** A refusal the API answers with: status, message, hint. Nothing is written. */
export class InventoryError extends Error {
  readonly status: number;
  readonly hint: string | undefined;
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/** Serial numbers: printable, no spaces at the ends, up to 64 characters. */
export const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._\/#:-]{0,63}$/;

/** The quoted version tag of a location, lot or reservation (`If-Match`). */
export function versionTag(record: { id: string; version: number }): string {
  return `"${record.id}.v${record.version}"`;
}

/** The free part of a lot: on hand and not held for a build. */
export const freeOf = (lot: Pick<Lot, 'onHand' | 'reserved'>): number => roundQty(lot.onHand - lot.reserved);
