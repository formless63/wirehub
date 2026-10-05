/**
 * The device resolver over the API, one flow for both backends (`resolver.server.test.ts`,
 * `pg/resolver.server.test.ts`): a pack ships devices and a conditioning recipe; the hub resolves
 * a supply to a panel, derives the cable, saves it, sees drift when a joint goes, shadows a pack
 * device locally, sets a ranking policy, and loses the devices with the pack.
 */

import type { CableDesign } from '@wirehub/model';
import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';

export const OWNER: StudioUser = { name: 'Olive Owner', source: 'session', role: 'owner' };

export interface ResolverFlowHooks {
  call: (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;
}

const SRC = 'synthetic example';
export const SUPPLY = { id: 'bench-supply', label: 'Bench supply', kind: 'instrument', ports: [{ id: 'dc-out', label: 'DC out', interface: 'dc-2pin', gender: 'male', role: 'source', pins: { '1': { signal: 'pwr-v', dir: 'out', src: SRC } } }], src: SRC };
export const PANEL = { id: 'led-panel', label: 'LED panel', kind: 'instrument', ports: [{ id: 'dc-in', label: 'DC in', interface: 'dc-2pin', gender: 'male', role: 'sink', pins: { '1': { signal: 'pwr-v', dir: 'in', needs: ['series-resistor'], src: SRC } } }], src: SRC };
export const LIMIT = { id: 'led-limit-150r', label: 'LED current limit, 150 Ω', conditioning: 'series-resistor', parts: [{ component: 'r-150', placement: 'series' }], src: SRC };

const bundle = {
  format: 1,
  manifest: { format: 1, id: 'devices-pack', name: 'Devices pack', version: '1.0.0', license: 'CC0-1.0' },
  files: { 'devices.json': [SUPPLY, PANEL], 'conditioning-recipes.json': [LIMIT] },
};

export async function runResolverFlow({ call }: ResolverFlowHooks): Promise<void> {
  const empty = await call('GET', '/api/resolver', undefined, OWNER);
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  expect(empty.body.devices).toEqual([]);
  expect(empty.body.hazards.builtIn.map((h: any) => h.id)).toContain('power-into-signal');

  const installed = await call('POST', '/api/packs/install', { bundle, apply: true }, OWNER);
  expect(installed.status, JSON.stringify(installed.body)).toBe(200);
  const lib = await call('GET', '/api/resolver', undefined, OWNER);
  expect(lib.body.devices.map((d: any) => [d.id, d.origin, d.pack])).toEqual([
    ['bench-supply', 'pack', 'devices-pack'],
    ['led-panel', 'pack', 'devices-pack'],
  ]);
  expect(lib.body.recipes.map((r: any) => r.id)).toEqual(['led-limit-150r']);
  expect(lib.body.issues).toEqual([]);

  // which cable: the supply to the panel needs the resistor the panel asks for
  const q = 'source=bench-supply&destination=led-panel';
  const resolved = await call('GET', `/api/resolver/resolve?${q}`, undefined, OWNER);
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const best = resolved.body.options[0];
  expect(best.kind).toBe('conditioned');
  expect(best.links[0].recipes).toEqual(['led-limit-150r']);
  expect(resolved.body.stocks[best.id][0].id).toBe('dc-2core-24awg');
  expect((await call('GET', '/api/resolver/resolve?source=bench-supply', undefined, OWNER)).status).toBe(400);

  // derive (nothing written), then create it like any design
  const derived = await call('GET', `/api/resolver/derive?${q}&lengthMm=500&id=supply-to-panel`, undefined, OWNER);
  expect(derived.status, JSON.stringify(derived.body)).toBe(200);
  expect(derived.body.issues).toEqual([]);
  expect(derived.body.idTaken).toBe(false);
  const design = derived.body.design as CableDesign;
  expect(design.recipe).toMatchObject({ source: { device: 'bench-supply' }, destination: { device: 'led-panel' }, stock: 'dc-2core-24awg', lengthMm: 500 });
  expect(design.instances.components.map((c) => c.def)).toEqual(['r-150']);
  const created = await call('POST', '/api/designs', design, OWNER);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const inStep = await call('GET', '/api/resolver/designs/supply-to-panel', undefined, OWNER);
  expect(inStep.body.drift.state).toBe('in-step');
  expect(inStep.body.proposals).toEqual([]);

  // a joint removed by hand is drift: the report names it and the recipe proposes it back
  const current = await call('GET', '/api/designs/supply-to-panel', undefined, OWNER);
  const edited = { ...design, joints: design.joints.slice(1) };
  const saved = await call('PUT', '/api/designs/supply-to-panel', edited, OWNER, { 'if-match': current.headers?.ETag ?? '' });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const drift = await call('GET', '/api/resolver/designs/supply-to-panel', undefined, OWNER);
  expect(drift.body.drift.state).toBe('drift');
  expect(drift.body.drift.differences.length).toBe(1);
  expect(drift.body.proposals.map((p: any) => p.joint)).toEqual([design.joints[0]]);
  expect(drift.body.rederived.joints.length).toBe(design.joints.length);

  // a hand design without a recipe gets one inferred
  const hand = { ...design, id: 'hand-lead', recipe: undefined };
  delete (hand as { recipe?: unknown }).recipe;
  expect((await call('POST', '/api/designs', hand, OWNER)).status).toBe(201);
  const inferred = await call('GET', '/api/resolver/designs/hand-lead', undefined, OWNER);
  expect(inferred.body.recipe).toBeNull();
  expect(inferred.body.inference).toMatchObject({ ok: true, state: 'identical' });

  // this hub's own devices: If-Match required, a broken list refused, a pack device shadowed
  expect((await call('PUT', '/api/resolver/devices', { devices: [] }, OWNER)).status).toBe(428);
  const tag = lib.body.etags.devices as string;
  const broken = await call('PUT', '/api/resolver/devices', { devices: [{ ...PANEL, id: 'odd', ports: [{ id: 'x', interface: 'no-such-pinout' }] }] }, OWNER, { 'if-match': tag });
  expect(broken.status).toBe(422);
  const shadow = await call('PUT', '/api/resolver/devices', { devices: [{ ...PANEL, label: 'LED panel (our build)' }] }, OWNER, { 'if-match': tag });
  expect(shadow.status, JSON.stringify(shadow.body)).toBe(200);
  expect(shadow.body.devices.map((d: any) => [d.id, d.label, d.origin]).sort()).toEqual([
    ['bench-supply', 'Bench supply', 'pack'],
    ['led-panel', 'LED panel (our build)', 'pack'],
  ]);
  expect(shadow.body.devices.find((d: any) => d.id === 'led-panel').held).toBe(true);

  // the ranking policy
  const badPolicy = await call('PUT', '/api/resolver/policy', { policy: { order: ['cheapest'], src: SRC } }, OWNER, { 'if-match': lib.body.etags.policy });
  expect(badPolicy.status).toBe(422);
  const policy = await call('PUT', '/api/resolver/policy', { policy: { order: ['parts', 'missing'], src: SRC } }, OWNER, { 'if-match': lib.body.etags.policy });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  expect(policy.body.policy.inForce.order).toEqual(['parts', 'missing']);
  expect((await call('GET', `/api/resolver/resolve?${q}`, undefined, OWNER)).body.options[0].score).toHaveLength(2);

  // the pack cannot go while a design's recipe names its devices; once they are gone, it takes its records along
  const refused = await call('DELETE', '/api/packs/devices-pack', undefined, OWNER);
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body.plan.references)).toMatch(/recipe\.source\.device/);
  for (const id of ['supply-to-panel', 'hand-lead']) expect((await call('DELETE', `/api/designs/${id}`, { confirm: id }, OWNER)).status).toBe(200);
  const gone = await call('DELETE', '/api/packs/devices-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const after = await call('GET', '/api/resolver', undefined, OWNER);
  // a layered pack leaves the local shadow behind; a merged one takes its record, edited or not
  expect(after.body.devices.every((d: any) => d.id === 'led-panel' && d.origin === 'local')).toBe(true);
  expect(after.body.recipes).toEqual([]);
}
