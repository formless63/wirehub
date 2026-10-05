/** Part costs in the Library forms and the design's labour time (cs-5k1.17). */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { componentDraftOf, componentOf, connectorDraftOf, connectorOf, mechanicalDraftOf, mechanicalOf, wireDefinitionOf, wireFormOf } from '../src/library.ts';
import { readCostTexts, costOfExtra, withExtraCost } from '../src/panels/CostFields.tsx';
import { editorReducer, initialEditorState } from '../src/store.ts';

const db = loadDb();
const cost = { unit: 0.5, currency: 'USD', breaks: [{ minQty: 10, unit: 0.4 }] };

describe('cost survives the forms', () => {
  it('a wire stock keeps its price through draft and back', () => {
    const plain = db.wires.find((w) => wireFormOf(w) !== undefined)!;
    const wire = { ...plain, cost: { ...cost, per: 'each' as const } };
    expect(wireDefinitionOf(wireFormOf(wire)!).cost).toEqual(wire.cost);
    expect(wireDefinitionOf(wireFormOf(plain)!).cost).toBeUndefined();
  });

  it('a connector, component and mechanical keep theirs among the extras', () => {
    expect(connectorOf(connectorDraftOf({ ...db.connectors[0]!, cost })).cost).toEqual(cost);
    expect(componentOf(componentDraftOf({ ...db.components[0]!, cost })).cost).toEqual(cost);
    const mech = { ...db.mechanicals![0]!, cost };
    expect(mechanicalOf(mechanicalDraftOf(mech)).cost).toEqual(cost);
    const draft = mechanicalDraftOf(mech);
    expect(costOfExtra(draft.extra)).toEqual(cost);
    expect(withExtraCost(draft.extra, undefined)).toBeUndefined();
    expect(withExtraCost(undefined, cost)).toEqual({ cost });
  });
});

describe('typed prices', () => {
  const t = { unit: '', currency: '', per: 'each' as const, breaks: '', moq: '' };
  it('blank unit means no price', () => expect(readCostTexts(t, false)).toEqual({}));
  it('reads price, currency, breaks (sorted) and minimum order', () => {
    expect(readCostTexts({ ...t, unit: '0.5', currency: 'usd', breaks: '100: 0.3, 10: 0.4', moq: '25' }, false).cost).toEqual({
      unit: 0.5,
      currency: 'USD',
      breaks: [{ minQty: 10, unit: 0.4 }, { minQty: 100, unit: 0.3 }],
      moq: 25,
    });
  });
  it('wire defaults to per metre and records per piece only when asked', () => {
    expect(readCostTexts({ ...t, unit: '1', per: 'm' }, true).cost).toEqual({ unit: 1 });
    expect(readCostTexts({ ...t, unit: '1', per: 'each' }, true).cost).toEqual({ unit: 1, per: 'each' });
  });
  it('says what is wrong', () => {
    for (const bad of [{ unit: 'x' }, { unit: '1', currency: 'dollar' }, { unit: '1', breaks: '10 0.4' }, { unit: '1', breaks: '10: 1, 10: 2' }, { unit: '1', moq: '0' }]) {
      expect(readCostTexts({ ...t, ...bad }, false).problem).toBeDefined();
    }
  });
});

describe('set-labour', () => {
  it('sets, changes and removes the design labour, as undoable edits', () => {
    const start = initialEditorState(loadDesign('de9-crossover'), db);
    const set = editorReducer(start, { type: 'set-labour', minutes: 12 });
    expect(set.design.labourMinutes).toBe(12);
    expect(Object.keys(set.design).indexOf('labourMinutes')).toBeLessThan(Object.keys(set.design).indexOf('src'));
    expect(editorReducer(set, { type: 'set-labour', minutes: 12 })).toBe(set);
    expect(editorReducer(set, { type: 'set-labour', minutes: undefined }).design.labourMinutes).toBeUndefined();
    expect(editorReducer(start, { type: 'set-labour', minutes: -1 }).design.labourMinutes).toBeUndefined();
  });
});
