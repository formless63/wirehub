// @vitest-environment jsdom
/**
 * The wire node on the real canvas: a stock with a documented face draws both
 * cut ends with a handle on every element; one without keeps its rows.
 */

import './reactflow-jsdom.ts';

import type { Db } from '@wirehub/model';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Position } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CableEditor } from '../src/CableEditor.tsx';
import { BreakoutEdge } from '../src/edges.tsx';
import { HoverContext, createHoverStore } from '../src/hover.ts';
import { wireArt } from '../src/wire-art.ts';
import { designWithFacelessWhip, loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();

afterEach(cleanup);

function nodeOf(container: HTMLElement, instance: string): HTMLElement {
  const node = container.querySelector(`.react-flow__node[data-id="${instance}"]`);
  if (node === null) throw new Error(`no node for ${instance}`);
  return node as HTMLElement;
}

describe('wire node with end faces', () => {
  const design = loadDesignFromDisk('vga-monitor-cable');

  it('puts a handle on every element of each end, where the geometry says', () => {
    const { container } = render(<CableEditor design={design} db={db} />);
    const w1 = nodeOf(container, 'w1');
    const expected = wireArt({
      instanceId: 'w1',
      wire: db.wires.find((wire) => wire.id === 'vga-3coax-4core')!,
      lengthMm: 1830,
    })!;
    const handles = [...w1.querySelectorAll<HTMLElement>('.react-flow__handle.cs-wire-handle')];
    expect(handles).toHaveLength(expected.handles.length);
    for (const want of expected.handles) {
      const handle = handles.find((h) => h.getAttribute('data-handleid') === want.id);
      expect(handle, want.id).toBeDefined();
      expect(handle?.getAttribute('data-end')).toBe(want.end);
      expect(handle?.className).toContain(want.end === 'a' ? 'react-flow__handle-left' : 'react-flow__handle-right');
    }
    // the design's joints land on them — a pigtail's through its members
    const w1Def = design.instances.segments.find((s) => s.id === 'w1')!;
    for (const joint of design.joints) {
      for (const ref of [joint.a, joint.b]) {
        if (ref.instance !== 'w1') continue;
        const pigtail = w1Def.pigtails?.find((p) => `pigtail:${p.id}` === ref.terminal && p.end === ref.end);
        for (const rawId of pigtail === undefined
          ? [`${ref.instance}:${ref.terminal}@${ref.end}`]
          : (pigtail.members ?? []).map((m) => `w1:${m}@${ref.end}`)) {
          //: a joint straight onto a folded bonded
          // screen has no handle of its own — the edge still routes, to the
          // representative's (`foldedAliases`), but the representative keeps
          // its own literal used/cut fact (it may be a different, genuinely
          // cut wire — e.g. the drain, while the landed copper is the foil),
          // so this handle-level check only applies to an unfolded terminal
          if (rawId in expected.foldedAliases) continue;
          const handle = handles.find((h) => h.getAttribute('data-handleid') === rawId);
          expect(handle?.className, rawId).toContain('is-used');
        }
      }
    }
  });

});

describe('breakouts on the wire node', () => {
  const design = loadDesignFromDisk('vga-monitor-cable');

  it('turns the faces and reports the angles', () => {
    const { container } = render(<CableEditor design={design} db={db} />);
    const w1 = nodeOf(container, 'w1').querySelector('.cs-wire-node')!;
    const a = Number(w1.getAttribute('data-rotation-a'));
    const b = Number(w1.getAttribute('data-rotation-b'));
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
    expect(w1.querySelector('g.cs-face[data-end="a"]')?.getAttribute('data-rotation')).toBe(String(a));
    expect(w1.querySelector('g.cs-face[data-end="b"]')?.getAttribute('data-rotation')).toBe(String(b));
  });
});


describe('a ground edge shares its pigtail hover', () => {
  it('lights the pigtail from the edge and the edge from the pigtail', () => {
    const store = createHoverStore();
    const port = 'w1:core-red.shield@a~port.3';
    const props = {
      id: 'bundle:x',
      source: 'w1',
      target: 'u1',
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 40,
      sourcePosition: Position.Left,
      targetPosition: Position.Right,
      sourceHandleId: port,
      data: { jointIndex: 0, joints: [0, 1, 2], kind: 'ground', count: 3 },
    } as unknown as Parameters<typeof BreakoutEdge>[0];
    const { container } = render(
      <HoverContext.Provider value={store}>
        <svg>
          <BreakoutEdge {...props} />
        </svg>
      </HoverContext.Provider>,
    );
    const edge = container.querySelector('g.cs-edge')!;
    expect(edge.querySelector('.cs-edge-badge text')?.textContent).toBe('×3');
    fireEvent.mouseEnter(edge);
    expect(store.get()).toBe(port);
    expect(edge.getAttribute('class')).toContain('is-lit');
    fireEvent.mouseLeave(edge);
    expect(store.get()).toBeUndefined();
    expect(edge.getAttribute('class')).not.toContain('is-lit');
    // another pigtail's hover leaves it alone
    act(() => store.set('w1:drain@b~port.7'));
    expect(edge.getAttribute('class')).not.toContain('is-lit');
    act(() => store.set(port));
    expect(edge.getAttribute('class')).toContain('is-lit');
  });
});
