/**
 * A data pack that carries a numbering scheme and validation rules, one flow for both backends
 * (`declarative-packs.server.test.ts`, `pg/declarative-packs.server.test.ts`): installing never
 * switches the scheme (Settings offers it, an owner confirms), the pack's rules run and can be
 * shadowed locally, a bad scheme refuses the pack, disabling removes the pack's rules.
 */

import { validateDesign, type CableDesign, type Db } from '@wirehub/model';
import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';

export const OWNER: StudioUser = { name: 'Olive Owner', source: 'session', role: 'owner' };
export const EDITOR: StudioUser = { name: 'Ed Editor', source: 'session', role: 'editor' };

export const PACK_SCHEME = {
  type: 'declarative',
  id: 'pack-level-seq',
  label: 'Pack scheme: level and sequence',
  template: '{level}-{seq}',
  segments: [
    { id: 'level', type: 'choice', values: [{ value: 'A', kinds: ['connector'] }, { value: 'B', kinds: ['design'] }] },
    { id: 'seq', type: 'counter', width: 5, per: ['level'] },
  ],
  src: 'synthetic example',
};

export const PACK_RULE = {
  id: 'pack-no-bare-design',
  label: 'Every cable names a product reference',
  severity: 'warning',
  each: 'design',
  require: { exists: { path: 'productRef' } },
  message: '{id} has no product reference',
  src: 'synthetic example: a pack rule',
};

export interface PackFlowHooks {
  call: (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;
}

const bundle = (version: string, manifestExtra: object = {}) => ({
  format: 1,
  manifest: { format: 1, id: 'rules-pack', name: 'Rules pack', version, license: 'CC0-1.0', ...manifestExtra },
  files: { 'components.json': [{ id: 'rules-pack-r', label: '1 ohm resistor', kind: 'resistor', value: '1', terminals: [{ id: 'a' }, { id: 'b' }], src: 'synthetic example' }], 'validation-rules.json': [PACK_RULE] },
});

export async function runDeclarativePackFlow({ call }: PackFlowHooks): Promise<void> {
  // a pack whose scheme is not usable is refused whole
  const bad = await call('POST', '/api/packs/install', { bundle: bundle('1.0.0', { partNumberScheme: { type: 'declarative', template: '{x}', segments: [] } }), apply: true }, OWNER);
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toMatch(/partNumberScheme/);

  // …and so is one whose rules cannot be used
  const badRules = bundle('1.0.0');
  badRules.files['validation-rules.json'] = [{ ...PACK_RULE, require: { run: 'code' } }] as never;
  const refused = await call('POST', '/api/packs/install', { bundle: badRules, apply: true }, OWNER);
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.body)).toMatch(/validation-rules\.json/);

  // install: the diff shows the rule, the offer rides along, and applying changes no numbering
  const preview = await call('POST', '/api/packs/install', { bundle: bundle('1.0.0', { partNumberScheme: PACK_SCHEME }) }, OWNER);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.offers.partNumberScheme.id).toBe('pack-level-seq');
  const done = await call('POST', '/api/packs/install', { bundle: bundle('1.0.0', { partNumberScheme: PACK_SCHEME }), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.installed).toBe(true);
  expect(done.body.offers.partNumberScheme.id).toBe('pack-level-seq');
  const settings = await call('GET', '/api/settings/part-numbers', undefined, OWNER);
  expect(settings.body.config).toBeNull();
  expect(settings.body.effective.kind).toBe('default');
  expect(settings.body.offers).toEqual([{ pack: 'rules-pack', version: '1.0.0', scheme: PACK_SCHEME, problems: [] }]);

  // the pack's rule is in force, read-only here, and runs inside validateDesign
  const rules = await call('GET', '/api/rules', undefined, OWNER);
  expect(rules.body.rules.map((r: any) => [r.id, r.origin, r.pack])).toEqual([['pack-no-bare-design', 'pack', 'rules-pack']]);
  const db = (await call('GET', '/api/db')).body as Db;
  expect(db.validationRules?.map((r) => r.id)).toEqual(['pack-no-bare-design']);
  const design = (await call('GET', '/api/designs/de9-crossover')).body as CableDesign;
  const issues = validateDesign(design, db).filter((i) => i.code === 'rule:pack-no-bare-design');
  expect(issues).toEqual([{ code: 'rule:pack-no-bare-design', severity: 'warning', message: 'de9-crossover has no product reference', where: 'de9-crossover' }]);

  // a local record of the same id shadows it: switched off here, the pack's copy untouched
  const off = await call('PUT', '/api/rules', { rules: [{ ...PACK_RULE, enabled: false }] }, OWNER);
  expect(off.status).toBe(428);
  const tag = rules.headers?.ETag ?? '';
  const shadow = await callWithTag(call, 'PUT', '/api/rules', { rules: [{ ...PACK_RULE, enabled: false }] }, tag);
  expect(shadow.status, JSON.stringify(shadow.body)).toBe(200);
  const afterShadow = (await call('GET', '/api/db')).body as Db;
  expect(afterShadow.validationRules?.map((r) => [r.id, r.enabled])).toEqual([['pack-no-bare-design', false]]);
  expect(validateDesign(design, afterShadow).filter((i) => i.code.startsWith('rule:'))).toEqual([]);
  expect((await call('GET', '/api/rules', undefined, OWNER)).body.rules[0]).toMatchObject({ id: 'pack-no-bare-design', origin: 'pack', enabled: false });

  // the offered scheme: an editor may not confirm it, an owner may, and then proposals follow it
  const settingsAgain = await call('GET', '/api/settings/part-numbers', undefined, OWNER);
  const etag = settingsAgain.headers?.ETag ?? '';
  expect((await callWithTag(call, 'PUT', '/api/settings/part-numbers', { adoptFrom: 'rules-pack' }, etag, EDITOR)).status).toBe(403);
  expect((await callWithTag(call, 'PUT', '/api/settings/part-numbers', { adoptFrom: 'no-such-pack' }, etag, OWNER)).status).toBe(404);
  const adopted = await callWithTag(call, 'PUT', '/api/settings/part-numbers', { adoptFrom: 'rules-pack' }, etag, OWNER);
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  expect(adopted.body.effective).toMatchObject({ kind: 'declarative', id: 'pack-level-seq', shape: '<level>-NNNNN' });
  const preview2 = await call('POST', '/api/settings/part-numbers/preview', { scheme: PACK_SCHEME, suggest: [{ kind: 'connector' }, { kind: 'design' }] }, OWNER);
  expect(preview2.body.suggestions.map((s: any) => s.suggestion?.pn)).toEqual(['A-00001', 'B-00001']);

  // disabling the pack takes its records with it (a layer leaves a local shadow of the rule, a merged pack takes it along)
  const gone = await call('DELETE', '/api/packs/rules-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const final = (await call('GET', '/api/db')).body as Db;
  expect(final.components.some((c) => c.id === 'rules-pack-r')).toBe(false);
  expect(validateDesign(design, final).filter((i) => i.code.startsWith('rule:'))).toEqual([]);
}

function callWithTag(call: PackFlowHooks['call'], method: string, path: string, body: unknown, etag: string, user: StudioUser = OWNER) {
  return call(method, path, body, user, { 'if-match': etag });
}
