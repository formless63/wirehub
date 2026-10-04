// @vitest-environment jsdom
/**
 * The minimap draws the parts (derived nodes keep a size React Flow can read),
 * and the Parts | Pins level of detail: cards, one bundle per pair of parts,
 * a bundle selecting its connection, the choice remembered by the host.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@cable-studio/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { memoryLayoutStore } from '../src/layout-store.ts';
import { diskDepictions, loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

describe('the minimap', () => {
  it.each(['rs485-de9-terminal-board', 'vga-monitor-cable'])('draws one shape per node of %s', (id) => {
    const design = loadDesignFromDisk(id);
    const { container } = render(<CableEditor design={design} db={db} depictionSource={diskDepictions()} />);
    const nodes = container.querySelectorAll('.react-flow__node');
    expect(nodes.length).toBeGreaterThan(2);
    const shapes = container.querySelectorAll('.react-flow__minimap .react-flow__minimap-node');
    expect(shapes).toHaveLength(nodes.length);
    for (const shape of shapes) expect(Number(shape.getAttribute('width'))).toBeGreaterThan(0);
  });
});

