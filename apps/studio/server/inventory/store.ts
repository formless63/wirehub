/**
 * The inventory storage seam: one transaction interface (`InvTx`) the engine (`engine.ts`) works
 * through, implemented in memory / on files here and on Postgres in `pg/inventory.ts`. The engine
 * holds every rule; a store only reads, locks and writes rows.
 *
 * Files: `<dir>/state.json` (locations, lots with their materialised balances, reservations) is the
 * commit point, written atomically; `<dir>/ledger.jsonl` is the append-only ledger. A movement is
 * appended before the state that counts it is written, and a ledger line past the state's `lastSeq`
 * (a crash between the two) is dropped on the next load. One writer at a time (a promise queue).
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.ts';
import { itemKey, type Batch, type ItemRef, type Location, type Lot, type Movement, type Reservation } from './types.ts';

export interface MovementFilter {
  lot?: string;
  item?: ItemRef;
  reservation?: string;
  /** only movements with a smaller seq (paging back) */
  before?: number;
  limit?: number;
}

export interface LotFilter {
  item?: ItemRef;
  location?: string;
  /** include lots with nothing on hand (default: false) */
  empty?: boolean;
}

export interface BatchFilter {
  item?: ItemRef;
  reservation?: string;
  limit?: number;
}

export interface InvTx {
  readonly actor: string;
  now(): string;
  newId(prefix: 'loc' | 'lot' | 'res' | 'bat'): string;
  locations(): Promise<Location[]>;
  location(id: string): Promise<Location | undefined>;
  /** with `lock`, the row is held until the transaction ends (Postgres `FOR UPDATE`) */
  lot(id: string, lock?: boolean): Promise<Lot | undefined>;
  lots(filter: LotFilter, lock?: boolean): Promise<Lot[]>;
  reservation(id: string, lock?: boolean): Promise<Reservation | undefined>;
  reservations(filter: { design?: string; status?: 'open' | 'closed' }): Promise<Reservation[]>;
  movements(filter: MovementFilter): Promise<Movement[]>;
  /** newest first */
  batches(filter: BatchFilter): Promise<Batch[]>;
  putLocation(location: Location): Promise<void>;
  deleteLocation(id: string): Promise<void>;
  putLot(lot: Lot): Promise<void>;
  putReservation(reservation: Reservation): Promise<void>;
  /** append to the ledger; the store assigns `seq` */
  append(movement: Omit<Movement, 'seq'>): Promise<Movement>;
  /** record a batch; written once, never changed */
  addBatch(batch: Batch): Promise<void>;
}

export interface InventoryStore {
  /** run `fn` as one transaction: everything it wrote commits together, or nothing does */
  transact<T>(actor: string, fn: (tx: InvTx) => Promise<T>): Promise<T>;
  read<T>(fn: (tx: InvTx) => Promise<T>): Promise<T>;
  /** `pg` or `files`, for the API's answer */
  readonly backend: 'pg' | 'files' | 'memory';
}

export const newInventoryId = (prefix: string): string => `${prefix}-${randomBytes(5).toString('hex')}`;

interface State {
  lastSeq: number;
  locations: Location[];
  lots: Lot[];
  reservations: Reservation[];
  batches: Batch[];
}

const emptyState = (): State => ({ lastSeq: 0, locations: [], lots: [], reservations: [], batches: [] });
const clone = <T,>(value: T): T => structuredClone(value);

function matchesLot(lot: Lot, filter: LotFilter): boolean {
  if (filter.item !== undefined && itemKey(lot.item) !== itemKey(filter.item)) return false;
  if (filter.location !== undefined && lot.location !== filter.location) return false;
  if (filter.empty !== true && lot.onHand <= 0 && lot.reserved <= 0) return false;
  return true;
}

function matchesMovement(m: Movement, filter: MovementFilter): boolean {
  if (filter.lot !== undefined && m.lot !== filter.lot && m.otherLot !== filter.lot) return false;
  if (filter.item !== undefined && itemKey(m.item) !== itemKey(filter.item)) return false;
  if (filter.reservation !== undefined && m.reservation !== filter.reservation) return false;
  if (filter.before !== undefined && m.seq >= filter.before) return false;
  return true;
}

/** A transaction over a working copy of the state; `commit` hands back what to persist. */
function stateTx(state: State, ledger: Movement[], actor: string, now: () => string): { tx: InvTx; appended: Movement[] } {
  const appended: Movement[] = [];
  const tx: InvTx = {
    actor,
    now,
    newId: (prefix) => newInventoryId(prefix),
    locations: async () => clone(state.locations),
    location: async (id) => clone(state.locations.find((l) => l.id === id)),
    lot: async (id) => clone(state.lots.find((l) => l.id === id)),
    lots: async (filter) => clone(state.lots.filter((l) => matchesLot(l, filter))),
    reservation: async (id) => clone(state.reservations.find((r) => r.id === id)),
    reservations: async (filter) => clone(state.reservations.filter((r) => (filter.design === undefined || r.design === filter.design) && (filter.status === undefined || r.status === filter.status))),
    movements: async (filter) => {
      const all = [...ledger, ...appended].filter((m) => matchesMovement(m, filter)).sort((a, b) => b.seq - a.seq);
      return clone(filter.limit === undefined ? all : all.slice(0, filter.limit));
    },
    batches: async (filter) => {
      const all = state.batches
        .filter((b) => (filter.item === undefined || itemKey(b.item) === itemKey(filter.item)) && (filter.reservation === undefined || b.reservation === filter.reservation))
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      return clone(filter.limit === undefined ? all : all.slice(0, filter.limit));
    },
    putLocation: async (location) => {
      const at = state.locations.findIndex((l) => l.id === location.id);
      if (at === -1) state.locations.push(clone(location));
      else state.locations[at] = clone(location);
    },
    deleteLocation: async (id) => {
      state.locations = state.locations.filter((l) => l.id !== id);
    },
    putLot: async (lot) => {
      const at = state.lots.findIndex((l) => l.id === lot.id);
      if (at === -1) state.lots.push(clone(lot));
      else state.lots[at] = clone(lot);
    },
    putReservation: async (reservation) => {
      const at = state.reservations.findIndex((r) => r.id === reservation.id);
      if (at === -1) state.reservations.push(clone(reservation));
      else state.reservations[at] = clone(reservation);
    },
    append: async (movement) => {
      state.lastSeq += 1;
      const written = { seq: state.lastSeq, ...clone(movement) } as Movement;
      appended.push(written);
      return clone(written);
    },
    addBatch: async (batch) => {
      if (state.batches.some((b) => b.id === batch.id)) throw new Error(`batch ${batch.id} already recorded`);
      state.batches.push(clone(batch));
    },
  };
  return { tx, appended };
}

/** In memory: tests and a hub with no place to keep it. */
export function memoryInventoryStore(now: () => string = () => new Date().toISOString()): InventoryStore {
  let state = emptyState();
  const ledger: Movement[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  return {
    backend: 'memory',
    read: async (fn) => fn(stateTx(clone(state), ledger, '', now).tx),
    transact: (actor, fn) => {
      const run = queue.then(async () => {
        const working = clone(state);
        const { tx, appended } = stateTx(working, ledger, actor, now);
        const out = await fn(tx);
        ledger.push(...appended);
        state = working;
        return out;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** On files, beside the catalog and never part of it (`data/.inventory/`). */
export function fileInventoryStore(dir: string, now: () => string = () => new Date().toISOString()): InventoryStore {
  const statePath = join(dir, 'state.json');
  const ledgerPath = join(dir, 'ledger.jsonl');
  const load = (): { state: State; ledger: Movement[] } => {
    const state: State = existsSync(statePath) ? { ...emptyState(), ...(JSON.parse(readFileSync(statePath, 'utf8')) as Partial<State>) } : emptyState();
    const lines = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
    const ledger: Movement[] = [];
    for (const line of lines) {
      try {
        const m = JSON.parse(line) as Movement;
        // past the commit point: a write that never finished
        if (m.seq <= state.lastSeq) ledger.push(m);
      } catch {
        // a torn last line from a crash: not committed
      }
    }
    if (ledger.length !== lines.length) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(ledgerPath, ledger.map((m) => `${JSON.stringify(m)}\n`).join(''));
    }
    return { state, ledger };
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    backend: 'files',
    read: async (fn) => {
      const { state, ledger } = load();
      return fn(stateTx(state, ledger, '', now).tx);
    },
    transact: (actor, fn) => {
      const run = queue.then(async () => {
        const { state, ledger } = load();
        const { tx, appended } = stateTx(state, ledger, actor, now);
        const out = await fn(tx);
        mkdirSync(dir, { recursive: true });
        if (appended.length > 0) appendFileSync(ledgerPath, appended.map((m) => `${JSON.stringify(m)}\n`).join(''));
        writeFileAtomic(statePath, `${JSON.stringify(state, null, 1)}\n`);
        return out;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
