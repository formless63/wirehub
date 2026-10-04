// @vitest-environment jsdom
/**
 *: the re-pin grips a selected wire draws on the ends
 * that can move — on the very spot React Flow's own reconnect circle sits, so
 * the thing the user sees is the thing they can grab.
 */

import { Position } from '@xyflow/react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BreakoutEdge, REPIN_GRIP_RADIUS } from '../src/edges.tsx';

afterEach(cleanup);

function edge(grips?: 'source' | 'target' | 'both'): ReturnType<typeof render> {
  const props = {
    id: 'joint:w1:core-purple.center@b|j1:4',
    source: 'w1',
    target: 'j1',
    sourceX: 100,
    sourceY: 50,
    targetX: 300,
    targetY: 80,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    sourceHandleId: 'w1:core-purple.center@b~port.0',
    selected: true,
    data: { jointIndex: 15, joints: [15], kind: 'conductor', count: 1, ...(grips === undefined ? {} : { grips }) },
  } as unknown as Parameters<typeof BreakoutEdge>[0];
  return render(
    <svg>
      <BreakoutEdge {...props} />
    </svg>,
  );
}

describe('re-pin grips', () => {
  it('none unless the editor asks for them', () => {
    const { container } = edge();
    expect(container.querySelectorAll('.cs-edge-grip')).toHaveLength(0);
  });

  it('both ends, each on React Flow`s reconnect circle', () => {
    const { container } = edge('both');
    const source = container.querySelector('.cs-edge-grip[data-grip="source"] circle');
    const target = container.querySelector('.cs-edge-grip[data-grip="target"] circle');
    // right-facing source: out to the right; left-facing target: out to the left
    expect(source?.getAttribute('cx')).toBe(String(100 + REPIN_GRIP_RADIUS));
    expect(source?.getAttribute('cy')).toBe('50');
    expect(target?.getAttribute('cx')).toBe(String(300 - REPIN_GRIP_RADIUS));
    expect(target?.getAttribute('cy')).toBe('80');
  });

  it('only the end that can move', () => {
    const { container } = edge('target');
    expect([...container.querySelectorAll('.cs-edge-grip')].map((g) => g.getAttribute('data-grip'))).toEqual(['target']);
  });
});
