// @vitest-environment jsdom
/**
 * A free-standing connector is always its pin list: one row per pin with a
 * handle each, whether or not the family has a drawing. The drawing is a
 * header thumbnail and a "face" toggle, never the only target.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

describe('a connector with a drawing', () => {
  const design = loadDesignFromDisk('de9-crossover');
  const pins = db.connectors.find((c) => c.id === 'de9-female')!.pins.map((p) => p.id);

  it('lists every pin with a handle, beside a thumbnail and a face toggle', () => {
    const { container } = render(<CableEditor design={design} db={db} />);
    const node = container.querySelector('.react-flow__node[data-id="j1"]')!;
    const rows = [...node.querySelectorAll<HTMLElement>('.cs-row')].map((row) => row.getAttribute('data-terminal'));
    expect(rows.sort()).toEqual(pins.map((id) => `j1:${id}`).sort());
    for (const id of pins) expect(node.querySelector(`.react-flow__handle[data-handleid="j1:${id}"]`), id).not.toBeNull();
    expect(node.querySelector('svg.cs-conn-thumb')).not.toBeNull();
    expect(node.querySelector('button[aria-label="j1 face"]')).not.toBeNull();
  });

  it('shows the face on request and keeps a handle on every pin there too', () => {
    const { container } = render(<CableEditor design={design} db={db} />);
    fireEvent.click(container.querySelector('button[aria-label="j1 face"]')!);
    const node = container.querySelector('.react-flow__node[data-id="j1"]')!;
    expect(node.querySelector('.cs-conn-art')).not.toBeNull();
    expect(node.querySelector('button[aria-label="j1 pin list"]')).not.toBeNull();
    for (const id of pins) expect(node.querySelector(`.react-flow__handle[data-handleid="j1:${id}"]`), id).not.toBeNull();
  });
});
