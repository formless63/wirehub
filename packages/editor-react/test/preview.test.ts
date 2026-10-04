/**
 * The preview pane's one job: hand the committed design to the schematic
 * renderer. Proves the authoring canvas and the schematic renderer are two
 * consumers of one model — not two models.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { renderPreview } from '../src/panels/Preview.tsx';
import { editorReducer, initialEditorState } from '../src/store.ts';

const db: Db = loadDb();

describe('renderPreview', () => {
  it('renders the committed design as a self-contained SVG', () => {
    const state = initialEditorState(loadDesign('de9-terminal-board'), db);
    const result = renderPreview(state.design, db, false);
    expect('svg' in result).toBe(true);
    if (!('svg' in result)) return;
    expect(result.svg.startsWith('<svg')).toBe(true);
    expect(result.svg).not.toContain('<script');
  });

  it('follows an edit', () => {
    const state = initialEditorState(loadDesign('de9-terminal-board'), db);
    const before = renderPreview(state.design, db, false);
    const edited = editorReducer(state, {
      type: 'delete-joint',
      index: 0,
    });
    const after = renderPreview(edited.design, db, false);
    expect('svg' in before && 'svg' in after).toBe(true);
    if (!('svg' in before) || !('svg' in after)) return;
    expect(after.svg).not.toBe(before.svg);
  });

  it('survives a design carrying a part nothing is soldered to yet', () => {
    const state = initialEditorState(loadDesign('de9-terminal-board'), db);
    const added = editorReducer(state, {
      type: 'add-instance',
      kind: 'connector',
      def: 'jst-xh-2-dc',
    });
    expect(added.rejection).toBeUndefined();
    const result = renderPreview(added.design, db, false);
    expect('svg' in result).toBe(true);
  });
});
