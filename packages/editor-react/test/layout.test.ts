/**
 * Placement. The canvas is a projection of the design, and a projection nobody
 * can read is a broken one: the first thing a user sees must be parts they can
 * tell apart.
 *
 * The audit at the bottom is the real test — every design in the catalog,
 * derived, with its nodes' *drawn* boxes checked for collisions.
 */

import { loadDb, loadDesigns } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { NODE_DRAG_HANDLE, NODE_METRICS, autoLayout, deriveNodes, vacantPosition } from '../src/derive.ts';
import { connectorArt } from '../src/connector-art.ts';
import {
  NODE_BASE_WIDTH,
  NODE_TITLE_MAX_WIDTH,
  NODE_TITLE_CAPTION,
  nodeTitleCaption,
  rowsTop,
  connectorArtLayout,
  artHeadWidth,
  estimateNodeSize,
  nodeHeading,
  overlappingPairs,
  rectsOverlap,
  textWidth,
  type NodeRect,
} from '../src/layout-size.ts';

const db: Db = loadDb();
const designs: CableDesign[] = loadDesigns();

/** The boxes the browser draws, at the coordinates the editor placed them. */
function rectsOf(design: CableDesign, positions?: Record<string, { x: number; y: number }>): NodeRect[] {
  return deriveNodes(design, db, positions === undefined ? {} : { positions }).map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    ...estimateNodeSize(node.data),
  }));
}

describe('text metrics', () => {
  it('grows with the string and scales with the size', () => {
    expect(textWidth('mmmm', 10)).toBeGreaterThan(textWidth('ii', 10));
    expect(textWidth('DE-9', 20)).toBeCloseTo(textWidth('DE-9', 10) * 2, 5);
    expect(textWidth('', 10)).toBe(0);
  });
});

describe('node sizes', () => {
  it('reserve the base width and enough space for complete part titles', () => {
    for (const design of designs) {
      for (const node of deriveNodes(design, db)) {
        // a docked connector (mounted on a board, or housed in a breakout
        // mould) is sized to its own drawing alone, no
        // header, no base width of its own — its board/mould reserves room
        if (node.data.kind === 'connector' && node.data.dock !== undefined) continue;
        const base = NODE_BASE_WIDTH[node.data.kind];
        const size = estimateNodeSize(node.data);
        expect(size.width).toBeGreaterThanOrEqual(base);
        expect(size.height).toBeGreaterThan(0);
      }
    }
  });

  it('counts a board as its captioned two-column body, not as pads plus pins', () => {
    for (const design of designs) {
      for (const node of deriveNodes(design, db)) {
        if (node.data.kind !== 'pcba') continue;
        const rows = Math.max(node.data.pads.length, node.data.integrated.length);
        const stacked = node.data.pads.length + node.data.integrated.length;
        if (rows === stacked) continue;
        const height = estimateNodeSize(node.data).height;
        expect(height).toBeGreaterThan(rows * 19);
        expect(height).toBeLessThan(stacked * 19 + 120);
      }
    }
  });

  it('says the same thing the header renders', () => {
    const design = designs[0] as CableDesign;
    for (const node of deriveNodes(design, db)) {
      const heading = nodeHeading(node.data);
      expect(heading.badge).toBe(node.data.kind);
      expect(typeof heading.title).toBe('string');
    }
  });
});

describe('autoLayout', () => {
  // ELK runs in-process: a few tens of milliseconds per design, twice over the catalog
  it('is deterministic', { timeout: 30_000 }, () => {
    for (const design of designs) {
      expect(autoLayout(design, db)).toEqual(autoLayout(design, db));
    }
  });

  it('places every instance', () => {
    for (const design of designs) {
      const { positions } = autoLayout(design, db);
      for (const node of deriveNodes(design, db)) {
        // a docked connector has no position of its own: it rides inside its
        // board's or mould's node (`dock.offset`, relative) instead
        if (node.data.kind === 'connector' && node.data.dock !== undefined) continue;
        expect(positions[node.id]).toBeDefined();
      }
    }
  });

  it('keeps the column gap between columns and the row gap inside one', () => {
    for (const design of designs) {
      const { positions, columns } = autoLayout(design, db);
      const rects = new Map(rectsOf(design).map((rect) => [rect.id, rect]));
      for (const [id, rect] of rects) {
        for (const [other, otherRect] of rects) {
          if (id === other) continue;
          const sameColumn = columns[id] === columns[other];
          if (!sameColumn) continue;
          const gap =
            rect.y < otherRect.y
              ? otherRect.y - (rect.y + rect.height)
              : rect.y - (otherRect.y + otherRect.height);
          expect(gap).toBeGreaterThanOrEqual(NODE_METRICS.rowGap);
        }
      }
      expect(Object.keys(positions).length).toBeGreaterThan(0);
    }
  });
});

describe('every node can be grabbed', () => {
  it('names the header as the drag handle on every node of every design', () => {
    for (const design of designs) {
      const nodes = deriveNodes(design, db);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        // a docked connector is not grabbed on its own: it moves with its
        // board or mould (`draggable: false`, no drag handle of its own)
        if (node.data.kind === 'connector' && node.data.dock !== undefined) {
          expect(node.draggable).toBe(false);
          continue;
        }
        expect(node.dragHandle).toBe(NODE_DRAG_HANDLE);
      }
    }
  });
});

describe('a part added from the palette', () => {
  it('never lands on top of one already placed', () => {
    for (const design of designs.slice(0, 6)) {
      const before = deriveNodes(design, db);
      const positions = Object.fromEntries(before.map((node) => [node.id, node.position]));
      // a part with no joints yet — the case the auto-layout has least to say about
      const grown: CableDesign = {
        ...design,
        instances: {
          ...design.instances,
          connectors: [...design.instances.connectors, { id: 'jNEW', def: 'jst-xh-2-dc' }],
        },
      };
      const spot = vacantPosition(grown, db, 'jNEW', positions);
      const rects = rectsOf(grown, { ...positions, jNEW: spot });
      expect(overlappingPairs(rects)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The audit: no design in the catalog opens with parts on top of parts
 * ------------------------------------------------------------------ */

describe.each(designs.map((design) => [design.id, design] as const))(
  'first open of %s',
  (_id, design) => {
    it('draws no two parts on top of each other', () => {
      expect(overlappingPairs(rectsOf(design))).toEqual([]);
    });

    it('is what Auto-arrange puts back', () => {
      const arranged = autoLayout(design, db).positions;
      const scrambled = Object.fromEntries(
        Object.keys(arranged).map((id) => [id, { x: 0, y: 0 }]),
      );
      expect(overlappingPairs(rectsOf(design, arranged))).toEqual([]);
      // …and the scramble really would have collided, so the check has teeth
      const nodes = rectsOf(design, scrambled);
      if (nodes.length > 1) {
        expect(rectsOverlap(nodes[0] as NodeRect, nodes[1] as NodeRect)).toBe(true);
      }
    });
  },
);

describe('readable part titles', () => {
  it('grows connector nodes for a long part title while leaving the pin rows unchanged', () => {
    const connector = deriveNodes(designs.find(d => d.instances.connectors.length > 0)!, db).find(n => n.data.kind === 'connector')!;
    const normal = estimateNodeSize(connector.data);
    const titled = { ...connector.data, title: 'Connector mounting style and complete part number' };
    const longer = estimateNodeSize(titled);
    expect(longer.width).toBeGreaterThan(normal.width);
    expect(longer.width).toBeGreaterThan(textWidth(titled.title, 10));
    expect(longer.height).toBe(normal.height);
  });
});

describe('verbose imported titles', () => {
  const connector = deriveNodes(designs.find(d => d.instances.connectors.length > 0)!, db).find(n => n.data.kind === 'connector')!;
  it.each(['Imported connector description '.repeat(18).trim(), 'W'.repeat(1000)])('keeps the complete name visible without making an enormous pin-list node', (title) => {
    const data = { ...connector.data, title };
    const size = estimateNodeSize(data);
    const caption = nodeTitleCaption(data)!;
    expect(size.width).toBeLessThanOrEqual(NODE_TITLE_MAX_WIDTH);
    expect(caption.lines.length).toBeGreaterThan(1);
    expect(caption.lines.join(' ').replace(/\s/g, '')).toBe(title.replace(/\s/g, ''));
    for (const line of caption.lines) expect(textWidth(line, NODE_TITLE_CAPTION.font)).toBeLessThanOrEqual(caption.width - 2 * NODE_TITLE_CAPTION.padding);
    expect(rowsTop(data)).toBe(rowsTop(connector.data));
    expect(size.height).toBe(estimateNodeSize({ ...data, title: 'Connector' }).height + caption.height);
  });
  it('keeps art local coordinates and header origins while reserving the full caption below them', () => {
    if (connector.data.kind !== 'connector') throw new Error('Fixture needs a connector');
    const original = connector.data;
    const definition = db.connectors.find(def => def.id === 'de9-male')!;
    const drawing = connectorArt({ def: definition, facing: 'right' })!;
    const regularArt = connectorArtLayout(original.instanceId, 'Connector', drawing);
    const title = 'M'.repeat(500);
    const art = connectorArtLayout(original.instanceId, title, drawing);
    const data = { ...original, title, art, face: true };
    const caption = nodeTitleCaption(data)!;
    const normal = { ...data, title: 'Connector' };
    expect(art.width).toBeLessThanOrEqual(NODE_TITLE_MAX_WIDTH);
    expect(art.art).toBe(drawing);
    expect(art.oy).toBe(regularArt.oy);
    expect(estimateNodeSize(data).height).toBe(estimateNodeSize(normal).height + caption.height);
    expect(artHeadWidth('w1', title, '1000 mm')).toBeLessThanOrEqual(NODE_TITLE_MAX_WIDTH);
  });
});
