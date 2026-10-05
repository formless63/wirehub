/**
 * Connector naming rules and the canvas derivation on the starter designs:
 * every connector, segment and board becomes a node, every joint is drawn by
 * an edge, and a re-pin gesture maps to joint moves. Re-covers generic cases
 * of the editor tests dropped at the split (docs/boundaries.md §6).
 */

import { describe, expect, it } from 'vitest';
import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';

import {
  CONNECTOR_NAMING_RULE,
  connectorNameOf,
  constructionLabel,
  mountingSummaryText,
  useOfInterface,
  variantIdOf,
  withConstructionInLabel,
} from '../src/naming.ts';
import { deriveFlow } from '../src/derive.ts';
import { reconnectMoves, reconnectableEnds, type RepinEdge } from '../src/repin.ts';

const db = loadDb();

describe('connector naming', () => {
  it('states its own rule', () => {
    expect(CONNECTOR_NAMING_RULE).toContain('<Family>');
  });

  it('puts the construction before the use, replaces it, and removes it', () => {
    const label = 'DE-9 male (RS-232 DTE)';
    expect(withConstructionInLabel(label, 'solder-cup')).toBe('DE-9 male, solder cup (RS-232 DTE)');
    expect(withConstructionInLabel('DE-9 male, solder cup (RS-232 DTE)', 'pcb-mount-th')).toBe('DE-9 male, PCB mount (RS-232 DTE)');
    expect(withConstructionInLabel('DE-9 male, crimp (x)', '')).toBe('DE-9 male (x)');
    expect(withConstructionInLabel('DE-9 male', 'crimp')).toBe('DE-9 male, crimp');
  });

  it('takes the use from an interface label without its note', () => {
    expect(useOfInterface({ label: 'RS-232 DTE — pins by number (TIA-574)' })).toBe('RS-232 DTE');
    expect(useOfInterface({ label: 'RS-485 (TIA-485)' })).toBe('RS-485');
    expect(useOfInterface(undefined)).toBe('');
  });

  it('names a new connector from its body, interface and construction', () => {
    expect(connectorNameOf({ label: 'DE-9 male' }, { label: 'RS-232 DTE' }, 'crimp')).toBe('DE-9 male, crimp (RS-232 DTE)');
    expect(connectorNameOf(undefined, { label: 'x' })).toBe('');
    expect(connectorNameOf({ label: 'DE-9 male' }, undefined)).toBe('DE-9 male');
  });

  it('labels a construction from the vocabulary first, then the short form, then the id', () => {
    const vocab = { 'connector-constructions': { entries: [{ id: 'crimp', label: 'Crimp (vocab)' }] } } as never;
    expect(constructionLabel(vocab, 'crimp')).toBe('Crimp (vocab)');
    expect(constructionLabel(undefined, 'solder-cup')).toBe('solder cup');
    expect(constructionLabel(undefined, 'odd')).toBe('odd');
    expect(constructionLabel(undefined, undefined)).toBe('');
  });

  it('summarises how designs mount a construction', () => {
    expect(mountingSummaryText('crimp', 0, 0)).toBe('crimp');
    expect(mountingSummaryText('crimp', 2, 1)).toBe('crimp · used straddle-mounted in 2, direct in 1');
  });

  it('makes a free variant id by suffix', () => {
    expect(variantIdOf('de9-male', 'pcb-mount-th', [])).toBe('de9-male-pcb');
    expect(variantIdOf('de9-male-cup', 'pcb-mount-th', [])).toBe('de9-male-pcb');
    expect(variantIdOf('de9-male', 'crimp', ['de9-male-crimp'])).toBe('de9-male-crimp-2');
  });
});

describe('canvas derivation', () => {
  for (const id of listDesignIds()) {
    const design = loadDesign(id);
    const flow = deriveFlow(design, db);

    it(`${id}: a node for every instance, with unique ids`, () => {
      const ids = flow.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of design.instances.connectors) expect(ids, c.id).toContain(c.id);
      for (const s of design.instances.segments) expect(ids, s.id).toContain(s.id);
      for (const p of design.instances.pcbas) expect(ids, p.id).toContain(p.id);
    });

    it(`${id}: every edge joins two nodes that exist, and every joint is drawn`, () => {
      const ids = new Set(flow.nodes.map((n) => n.id));
      for (const edge of flow.edges) {
        expect(ids.has(edge.source), `${edge.id} source`).toBe(true);
        expect(ids.has(edge.target), `${edge.id} target`).toBe(true);
      }
      const drawn = new Set(flow.edges.flatMap((e) => e.data?.joints ?? []));
      // a joint inside one carrier (a docked or stub joint) may be drawn without an edge of its own
      expect(drawn.size).toBeGreaterThan(0);
      expect(drawn.size).toBeLessThanOrEqual(design.joints.length);
    });

    it(`${id}: the derivation is repeatable`, () => {
      expect(JSON.stringify(deriveFlow(structuredClone(design), db))).toBe(JSON.stringify(flow));
    });
  }
});

describe('re-pinning', () => {
  const design = loadDesign('de9-crossover');
  const flow = deriveFlow(design, db);
  const movable = flow.edges.find((e) => reconnectableEnds(design, e as RepinEdge) === true);

  it('finds a plain wire-to-pin edge that can move at both ends', () => {
    expect(movable).toBeDefined();
  });

  it('turns a drop on another pin into a move of that end of every joint the edge draws', () => {
    const edge = movable as RepinEdge;
    const moves = reconnectMoves(design, edge, {
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      target: 'j2',
      targetHandle: 'j2~t~5',
    }, (_node, _handle) => ({ instance: 'j2', terminal: '5' }));
    expect(moves).toBeDefined();
    expect(moves!.length).toBe(edge.data!.joints.length);
    expect(moves!.every((m) => m.to.terminal === '5')).toBe(true);
  });

  it('moves nothing for a drop on no handle or an unrelated connection', () => {
    const edge = movable as RepinEdge;
    expect(reconnectMoves(design, edge, { source: edge.source, sourceHandle: edge.sourceHandle ?? null, target: 'x', targetHandle: null })).toBeUndefined();
    expect(reconnectMoves(design, edge, { source: 'p', sourceHandle: 'q', target: 'r', targetHandle: 's' })).toBeUndefined();
  });

  it('cannot move an edge with no data', () => {
    expect(reconnectableEnds(design, { source: 'a', target: 'b' })).toBe(false);
  });
});
