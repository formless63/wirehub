// @vitest-environment jsdom
import { pickOption } from './ui-helpers.ts';
import { useState } from 'react';
import { join } from 'node:path';
import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import type { ConditioningRecipe, DeviceProfile } from '@wirehub/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { canEditFields, DeviceForm, RecipeForm } from '../src/routes/ResolverRecordForms.tsx';

const db = createCatalog(fsCatalogSource(join(process.cwd(), '../../packages/catalog/data'))).loadDb();
const src = 'synthetic example';
afterEach(cleanup);

it('edits a pin through vocabulary fields without losing port, pin or record facts', async () => {
  const original: DeviceProfile = {
    id: 'test-device', label: 'Test device', src, aliases: ['older-name'], note: 'Keep this note',
    ports: [{ id: 'p1', interface: 'dc-2pin', body: 'jst-xh-2', terminals: '', requires: [{ id: 'test', conditioning: 'series-resistor', positions: ['1'], src }],
      pins: { '1': { signal: 'pwr-5v', dir: 'out', accepts: ['dc-5v'], confidence: 'documented', src, note: 'Pin note' }, '2': 'nc' } }],
  };
  let current = original;
  function Editor() {
    const [record, setRecord] = useState(original);
    return <DeviceForm record={record} db={db} onChange={(next) => { current = next; setRecord(next); }} />;
  }
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('Device label'), { target: { value: 'Edited device' } });
  await pickOption('Port 1 pin 1 signal', 'Signal ground');
  await pickOption('Port 1 pin 1 direction', /passive/i);
  expect(current).toEqual({ ...original, label: 'Edited device', ports: [{ ...original.ports[0]!, pins: { ...original.ports[0]!.pins, '1': { ...original.ports[0]!.pins!['1'] as object, signal: 'gnd-signal', dir: 'passive' } } }] });
  fireEvent.change(screen.getByLabelText('Port 1 new position'), { target: { value: 'aux' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add pin' }));
  await pickOption('Port 1 pin aux signal', 'Unconnected');
  expect(current.ports[0]!.pins!['aux']).toBe('nc');
  fireEvent.click(screen.getByRole('button', { name: 'Add port' }));
  expect(current.ports[1]?.id).toBe('port-1');
});

it('edits recipe predicates and parts without losing metadata or part annotations', async () => {
  const original: ConditioningRecipe = { id: 'test-recipe', label: 'Test recipe', conditioning: 'series-resistor', src, note: 'Keep note', from: { kind: 'power', level: 'dc-5v' }, parts: [{ component: 'r-150', placement: 'series', note: 'Keep part note' }], license: 'CC0-1.0' };
  let current = original;
  function Editor() {
    const [record, setRecord] = useState(original);
    return <RecipeForm record={record} db={db} onChange={(next) => { current = next; setRecord(next); }} />;
  }
  render(<Editor />);
  await pickOption('Input level', /12/);
  await pickOption('Part 1 placement', /shunt/i);
  fireEvent.click(screen.getByLabelText('Bidirectional'));
  expect(current).toEqual({ ...original, bidirectional: true, from: { kind: 'power', level: 'dc-12v' }, parts: [{ ...original.parts[0]!, placement: 'shunt' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
  await pickOption('Part 2 component', /120/);
  expect(current.parts[1]).toEqual({ component: 'r-120', placement: 'series' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove part 2' }));
  expect(current.parts).toHaveLength(1);
});

it('leaves malformed advanced JSON shapes to the JSON editor', () => {
  expect(canEditFields('devices', { ports: [{ pins: { '1': { signal: 'pwr-5v', needs: null } } }] })).toBe(false);
  expect(canEditFields('devices', { label: {}, ports: [] })).toBe(false);
  expect(canEditFields('recipes', { parts: [{}], from: null })).toBe(false);
  expect(canEditFields('recipes', { parts: [{ placement: 'series', note: 'Unshown fields survive' }] })).toBe(true);
});
