import { loadDb, loadDesigns } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { deriveFlow } from '../src/derive.ts';
import { cardSize, partsFlow } from '../src/lod.ts';
import { PART_CARD_LAYOUT, NODE_TITLE_MAX_WIDTH, estimateNodeSize, overlappingPairs, partCardCaption, textWidth, monoWidth } from '../src/layout-size.ts';

const db = loadDb();
const designs = loadDesigns();

describe('Parts card title geometry', () => {
  const data = { instanceId: 'j1', title: 'Terminal block, 4-way, screw clamp' };
  it('reserves the actual font, icon, id and gaps for an ordinary complete title', () => {
    const size = cardSize({ ...data, kind: 'card', part: 'connector', partNumber: 'terminal-block', meta: '', missingDef: false, docked: [] });
    expect(size.width).toBeGreaterThan(PART_CARD_LAYOUT.width);
    const c = PART_CARD_LAYOUT;
    const occupied = c.border * 2 + c.pad * 2 + c.icon + c.gap * 2 + monoWidth(data.instanceId, c.font) + textWidth(data.title, c.font) * c.semibold;
    expect(size.width).toBeGreaterThanOrEqual(occupied);
    expect(partCardCaption(data.instanceId, data.title)).toBeUndefined();
  });

  it('wraps an excessive imported title completely and reserves it in both detail modes', () => {
    const flow = deriveFlow(designs.find(design => design.instances.connectors.length > 0)!, db);
    const node = flow.nodes.find(node => node.data.kind === 'connector' && node.parentId === undefined)!;
    const title = 'W'.repeat(1000);
    node.data = { ...node.data, title };
    const parts = partsFlow(flow);
    const card = parts.nodes.find(card => card.id === node.id)!;
    const size = cardSize(card.data);
    const caption = partCardCaption(card.data.instanceId, title)!;
    expect(size.width).toBeLessThanOrEqual(NODE_TITLE_MAX_WIDTH);
    expect(caption.lines.join('')).toBe(title);
    expect(size.height).toBeGreaterThan(PART_CARD_LAYOUT.head + PART_CARD_LAYOUT.meta + caption.height);
    const full = estimateNodeSize(node.data);
    expect(full.width).toBeGreaterThanOrEqual(size.width);
    expect(full.height).toBeGreaterThanOrEqual(size.height);
    expect(card.position.x).toBeGreaterThanOrEqual(node.position.x);
    expect(card.position.y).toBeGreaterThanOrEqual(node.position.y);
    expect(card.position.x + size.width).toBeLessThanOrEqual(node.position.x + full.width + 1);
    expect(card.position.y + size.height).toBeLessThanOrEqual(node.position.y + full.height + 1);
  });

  it.each(designs.map(design => [design.id, design] as const))('keeps every card inside the space reserved in Pins for %s', (_id, design) => {
    const flow = deriveFlow(design, db);
    const parts = partsFlow(flow);
    const full = new Map(flow.nodes.map(node => [node.id, estimateNodeSize(node.data)]));
    for (const node of parts.nodes) {
      const size = cardSize(node.data);
      expect(size.width).toBeLessThanOrEqual(full.get(node.id)!.width);
      expect(size.height).toBeLessThanOrEqual(full.get(node.id)!.height);
    }
    expect(overlappingPairs(parts.nodes.map(node => ({ id: node.id, ...node.position, ...cardSize(node.data) })))).toEqual([]);
  });
});
