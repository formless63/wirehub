import { loadDb, loadDesign } from '@wirehub/catalog';
import { createRegistry, manifestProblems } from '@wirehub/modules';
import { expect, it } from 'vitest';
import { standardWork } from '../src/index.ts';
import { adoptLabour } from '../src/logic.ts';

it('registers only an inspector, exporter and validation rule without automatic labour writes', () => {
  expect(manifestProblems([standardWork])).toEqual([]);
  expect(() => createRegistry([standardWork])).not.toThrow();
  expect(standardWork.panels[0]!.slot).toBe('cable-inspector');
  expect('commitHook' in standardWork).toBe(false); expect('integrations' in standardWork).toBe(false);
  const d = loadDesign('dc-led-lead'); d.labourMinutes = 77;
  d.extensions = { 'standard-work': { schema: 1, operations: [{ id: 'operation', label: 'Synthetic operation', minutes: 5, quantity: 1, basis: 'per-cable', src: 'synthetic timing fixture' }] } };
  const out = standardWork.exporters[0]!.render(d, loadDb(), { builds: 2 });
  expect(out).toMatchObject({ mimeType: 'text/csv', fileName: 'dc-led-lead-standard-work.csv' });
  expect(d.labourMinutes).toBe(77);
  expect(standardWork.validationRules[0]!.check(d)).toEqual([]);
  d.extensions['standard-work'] = { schema: 1, operations: [{ id: 'operation' }] };
  expect(standardWork.validationRules[0]!.check(d).length).toBeGreaterThan(0);
});

it('uses the explicitly adopted batch quantity for a saved document export', () => {
  const d = adoptLabour(loadDesign('dc-led-lead'), { schema: 1, operations: [{ id: 'setup', label: 'Setup', minutes: 20, quantity: 1, basis: 'per-batch', src: 'synthetic timing fixture' }] }, 10);
  const defaultReport = standardWork.exporters[0]!.render(d, loadDb(), undefined);
  const chosenReport = standardWork.exporters[0]!.render(d, loadDb(), { builds: 10 });
  expect(defaultReport).toEqual(chosenReport);
  expect(d.labourMinutes).toBe(2);
});
