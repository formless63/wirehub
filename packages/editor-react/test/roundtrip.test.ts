/**
 * Export/import fidelity. What the editor writes out is a plain CableDesign —
 * no editor wrapper, no coordinates, no derived data — so a design can go
 * through the editor and back into `packages/catalog/data/designs/` unchanged.
 */

import { listDesignIds, loadDb, loadDesign } from '@cable-studio/catalog';
import { errors, type Db } from '@cable-studio/model';
import { describe, expect, it } from 'vitest';

import {
  editorReducer,
  exportDesignJson,
  initialEditorState,
  parseDesignJson,
} from '../src/store.ts';

const db: Db = loadDb();

describe('JSON round trip', () => {
  it.each(listDesignIds())('%s survives load → export → parse unchanged', (id) => {
    const design = loadDesign(id);
    const state = initialEditorState(design, db);
    expect(errors(state.issues)).toHaveLength(0);

    const json = exportDesignJson(state.design);
    const parsed = parseDesignJson(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.design).toEqual(design);

    const reloaded = editorReducer(state, { type: 'import-json', json });
    expect(reloaded.design).toEqual(design);
    expect(reloaded.rejection).toBeUndefined();
    expect(errors(reloaded.issues)).toHaveLength(0);
  });

  it('round-trips an edited design too', () => {
    const state = initialEditorState(loadDesign('rs485-de9-terminal-board'), db);
    const edited = editorReducer(state, {
      type: 'update-instance',
      id: 'w1',
      patch: { lengthMm: 3000 },
    });
    const back = parseDesignJson(exportDesignJson(edited.design));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.design).toEqual(edited.design);
  });
});

describe('import guards', () => {
  const state = initialEditorState(loadDesign('rs485-de9-terminal-board'), db);

  it('refuses text that is not JSON', () => {
    const next = editorReducer(state, { type: 'import-json', json: 'not json {' });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('not JSON');
  });

  it('refuses JSON that is not a design document', () => {
    const next = editorReducer(state, { type: 'import-json', json: '{"hello":"world"}' });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('schemaVersion');
  });

  it('refuses a design document the definition library cannot resolve', () => {
    const broken = {
      ...loadDesign('rs485-de9-terminal-board'),
      instances: {
        ...loadDesign('rs485-de9-terminal-board').instances,
        connectors: [{ id: 'jX', def: 'invented-connector' }],
      },
    };
    const next = editorReducer(state, {
      type: 'import-json',
      json: JSON.stringify(broken),
    });
    expect(next.design).toBe(state.design);
    expect(next.rejection).toContain('unknown connector definition');
  });

});
