/** Built units and their test results over the workbench API (`server/units/api.ts`, `src/units.ts`). */

import type { Outcome } from '@wirehub/editor-react';

import { request } from './definitions.browser.ts';
import type { FirmwareCommission } from './firmware-commission.ts';
import type { BuiltUnit, UnitTestInput, UnitTestView } from './units.ts';

// under the inventory key: any inventory write (a new batch, a result) refetches them
export const unitsKey = (design?: string) => (design === undefined ? (['inventory', 'units'] as const) : (['inventory', 'units', design] as const));
export const unitKey = (id: string) => ['inventory', 'unit', id] as const;
export const unitCommissionsKey = (id: string) => ['inventory', 'unit', id, 'commissions'] as const;

const enc = encodeURIComponent;

export const fetchUnits = (design?: string): Promise<Outcome<{ units: BuiltUnit[] }>> => request(`/api/units${design === undefined ? '' : `?design=${enc(design)}`}`);
export const fetchUnit = (id: string): Promise<Outcome<{ unit: BuiltUnit; tests: UnitTestView[] }>> => request(`/api/units/${enc(id)}`);
export const recordUnitTest = (id: string, input: UnitTestInput): Promise<Outcome<{ test: UnitTestView }>> => request(`/api/units/${enc(id)}/tests`, { method: 'POST', body: input });

type Listed = FirmwareCommission & { projectLabel?: string };

/** Commissioning of a unit, by its id and (for records made before the link) its serial. */
export async function fetchUnitCommissions(unit: Pick<BuiltUnit, 'id' | 'serial'>): Promise<Listed[]> {
  const out = new Map<string, Listed>();
  for (const ref of [unit.id, unit.serial]) {
    if (ref === undefined) continue;
    const got = await request<{ commissions: Listed[] }>(`/api/firmware/commissions?unit=${enc(ref)}`);
    if (got.ok) for (const c of got.value.commissions) out.set(c.id, c);
  }
  return [...out.values()].sort((a, b) => b.performedAt.localeCompare(a.performedAt));
}
