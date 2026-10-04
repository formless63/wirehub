/**
 * The continuity / test spec, on known paths.
 *
 * The distinction this file exists to defend: **a path that exists is not a
 * path a meter reads.** Each behaviour is pinned to an example design's
 * path, named in the test title, so a regression tells you which electrical
 * claim broke rather than just which number moved.
 */

import { listDesignIds, loadDb, loadDesign, type DesignId } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { deriveTestSpec, type PathCheck, type TestSpec } from '../src/test-spec.ts';
import { testSpecToHtml, testSpecToMarkdown } from '../src/test-spec-render.ts';

const db = loadDb();

const path = (spec: TestSpec, from: string, to: string): PathCheck => {
  const found = spec.pathChecks.find(
    (check) =>
      (check.from.key === from && check.to.key === to) ||
      (check.from.key === to && check.to.key === from),
  );
  expect(found, `expected a path check between ${from} and ${to}`).toBeDefined();
  return found as PathCheck;
};

/* ------------------------------------------------------------------ *
 * The four behaviours, on named paths
 * ------------------------------------------------------------------ */

describe('DC continuity vs resistors and boards', () => {
  it('the LED lead VBUS path through its 150 Ω resistor predicts its own reading', () => {
    const spec = deriveTestSpec(loadDesign('usb-a-led-lead'), db);
    const check = path(spec, 'j1:1', 'j2:1');
    expect(check.behaviour.verdict).toBe('resistive');
    expect(check.behaviour.ohms).toBe(150);
    expect(check.behaviour.dcContinuous).toBe(true);
  });

  it('the RS-485 termination reads 120 Ω between A and B', () => {
    const spec = deriveTestSpec(loadDesign('rs485-de9-terminal-board'), db);
    const check = path(spec, 'j1:8', 'j1:3');
    expect(check.behaviour.ohms).toBe(120);
  });

  it('a straight patch cord is plain copper: one net per pin, no path checks', () => {
    const spec = deriveTestSpec(loadDesign('rj45-patch-t568b'), db);
    expect(spec.pathChecks).toEqual([]);
    expect(spec.netChecks.length).toBeGreaterThanOrEqual(8);
  });
});

/* ------------------------------------------------------------------ *
 * Isolation
 * ------------------------------------------------------------------ */

/** A copy of a real design with one extra joint welded in. */
function shorted(id: DesignId, a: [string, string], b: [string, string]): CableDesign {
  const design = loadDesign(id);
  return {
    ...design,
    id: `${design.id}-SHORTED`,
    joints: [
      ...design.joints,
      {
        a: { instance: a[0], terminal: a[1] },
        b: { instance: b[0], terminal: b[1] },
        note: 'DELIBERATE FAULT — test fixture only',
      },
    ],
  };
}

describe('isolation', () => {
  it('catches a line deliberately shorted to ground', () => {
    // the microphone lead's hot pin bridged to its shield pin
    const spec = deriveTestSpec(shorted('xlr-mic-cable', ['j1', '2'], ['j1', '1']), db);
    expect(spec.violations.length).toBeGreaterThan(0);
  });

  it('finds nothing wrong with any real design in the catalog', () => {
    for (const id of listDesignIds()) {
      const spec = deriveTestSpec(loadDesign(id), db);
      expect(spec.violations.map((check) => check.id), id).toEqual([]);
    }
  });

  it('never asserts isolation across the length of the cable', () => {
    for (const id of listDesignIds()) {
      const spec = deriveTestSpec(loadDesign(id), db);
      for (const check of spec.isolationChecks) {
        const sides = new Set([check.a.side, check.b.side]);
        sides.delete('both');
        expect(sides.size, `${id} ${check.id}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Deliberate opens
 * ------------------------------------------------------------------ */

describe('deliberate opens', () => {
  it('reports the spare core cut at the board end, citing the design note', () => {
    const spec = deriveTestSpec(loadDesign('rs485-de9-terminal-board'), db);
    expect(spec.openChecks.some((check) => check.key === 'w1:pair-2.b@b')).toBe(true);
  });

  it('never reports a terminal as both open and on a net', () => {
    for (const id of listDesignIds()) {
      const spec = deriveTestSpec(loadDesign(id), db);
      const wired = new Set(spec.ports.filter((port) => port.net !== undefined).map((p) => p.key));
      for (const check of spec.openChecks) {
        expect(wired.has(check.key), `${id} ${check.key}`).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Catalog-wide properties
 * ------------------------------------------------------------------ */

describe.each(listDesignIds())('%s', (id) => {
  const spec = deriveTestSpec(loadDesign(id), db);

  it('produces at least one continuity assertion', () => {
    expect(spec.netChecks.length + spec.pathChecks.length).toBeGreaterThan(0);
  });

  it('gives every check a rationale and an expectation', () => {
    const all = [
      ...spec.netChecks,
      ...spec.pathChecks,
      ...spec.isolationChecks,
      ...spec.openChecks,
    ];
    for (const check of all) {
      expect(check.rationale.length, check.id).toBeGreaterThan(20);
      expect(check.expected.length, check.id).toBeGreaterThan(5);
    }
  });

  it('agrees with itself about which paths a meter reads', () => {
    for (const check of spec.pathChecks) {
      expect(check.dcContinuous).toBe(check.behaviour.dcContinuous);
      if (!check.dcContinuous) expect(check.expected).not.toMatch(/^Continuity —/);
    }
    expect(spec.summary.nonDcPaths).toBe(
      spec.pathChecks.filter((check) => !check.dcContinuous).length,
    );
  });

  it('renders an HTML fragment with no external references', () => {
    const html = testSpecToHtml(spec);
    expect(html).toMatch(/^<section class="cs-section cs-testspec">/);
    expect(html).toMatch(/<\/section>$/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
  });

  it('keeps the meter verdict in the rendered output', () => {
    const markdown = testSpecToMarkdown(spec);
    for (const check of spec.pathChecks.filter((c) => !c.dcContinuous)) {
      expect(markdown).toContain(check.from.text);
    }
    if (spec.summary.nonDcPaths > 0) expect(markdown).toContain('OPEN');
  });
});
