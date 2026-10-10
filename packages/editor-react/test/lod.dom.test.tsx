// @vitest-environment jsdom
/**
 * The minimap draws the parts (derived nodes keep a size React Flow can read),
 * and the Parts | Pins level of detail: cards, one bundle per pair of parts,
 * a bundle selecting its connection, the choice remembered by the host.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { memoryLayoutStore } from '../src/layout-store.ts';
import { diskDepictions, loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

describe('the minimap', () => {
  it.each(['de9-terminal-board', 'dc-y-splitter'])('draws one shape per node of %s', (id) => {
    const design = loadDesignFromDisk(id);
    const { container } = render(<CableEditor design={design} db={db} depictionSource={diskDepictions()} />);
    const nodes = container.querySelectorAll('.react-flow__node');
    expect(nodes.length).toBeGreaterThan(2);
    const shapes = container.querySelectorAll('.react-flow__minimap .react-flow__minimap-node');
    expect(shapes).toHaveLength(nodes.length);
    for (const shape of shapes) expect(Number(shape.getAttribute('width'))).toBeGreaterThan(0);
  });
});

describe('readable Parts titles', () => {
  it('grows ordinary cards and paints excessive imported names in a bounded full caption', () => {
    const design = loadDesignFromDisk('dc-led-lead');
    const connector = design.instances.connectors[0]!;
    const layout = memoryLayoutStore();
    layout.saveDetail!('parts');
    const title = 'Terminal block, 4-way, screw clamp';
    const catalog = { ...db, connectors: db.connectors.map(def => def.id === connector.def ? { ...def, label: title } : def) };
    const ordinary = render(<CableEditor design={design} db={catalog} layout={layout} />);
    const card = ordinary.container.querySelector(`[data-id="${connector.id}"] .cs-card`)!;
    expect(card.querySelector('.cs-card-title')!.textContent).toBe(title);
    expect(Number.parseFloat((card as HTMLElement).style.width)).toBeGreaterThan(216);
    expect(card.querySelector('.cs-node-title-caption')).toBeNull();
    ordinary.unmount();

    const verbose = 'W'.repeat(1000);
    const imported = { ...catalog, connectors: catalog.connectors.map(def => def.id === connector.def ? { ...def, label: verbose } : def) };
    const rendered = render(<CableEditor design={design} db={imported} layout={layout} />);
    const verboseCard = rendered.container.querySelector(`[data-id="${connector.id}"] .cs-card`)!;
    expect(Number.parseFloat((verboseCard as HTMLElement).style.width)).toBeLessThanOrEqual(480);
    const caption = verboseCard.querySelector('.cs-node-title-caption')!;
    expect(caption.textContent).toBe(verbose);
    expect(caption.querySelectorAll('span').length).toBeGreaterThan(1);
    expect(Number.parseFloat((verboseCard as HTMLElement).style.height)).toBeGreaterThan(Number.parseFloat((caption as HTMLElement).style.height));
  });
});
