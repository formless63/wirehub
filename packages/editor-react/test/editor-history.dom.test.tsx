// @vitest-environment jsdom
/**
 * The two things a user touches that the store cannot prove on its own: the
 * undo/redo controls (buttons and keys, and the descriptions they carry), and
 * the `depictionSource` prop actually reaching the preview's renderer.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@cable-studio/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import type { DepictionSource } from '../src/index.ts';
import { loadDbFromDisk, loadDepictionMetaFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

/* ------------------------------------------------------------------ *
 * Undo / redo
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The depiction source, threaded through to the preview
 * ------------------------------------------------------------------ */

const DEPICTED = 'PCA-00110-rev5';

const MARKER_ASSET =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
  '<rect id="frame" class="fake-board-art" x="0" y="0" width="20" height="20"/>' +
  '</svg>';

/** A host-supplied source with exactly one asset — no filesystem in sight. */
const oneAsset: DepictionSource = {
  meta: (defId) =>
    defId === DEPICTED
      ? (loadDepictionMetaFromDisk(DEPICTED) as ReturnType<DepictionSource['meta']>)
      : undefined,
  artwork: (defId, view) =>
    defId === DEPICTED && view === 'board-top'
      ? { kind: 'vector', source: MARKER_ASSET }
      : undefined,
};

describe('<CableEditor depictionSource>', () => {

  it('renders every block abstractly when the host supplies no source', async () => {
    const design = loadDesignFromDisk('db9-null-modem');
    const { container } = render(<CableEditor design={design} db={db} />);
    const svg = (): string => container.querySelector('.cs-svg')?.innerHTML ?? '';
    await waitFor(() => expect(svg().length).toBeGreaterThan(0));
    expect(svg()).not.toContain('class="artwork"');
  });
});
