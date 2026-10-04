/**
 * The analytical sweeps, run over every design in both drawing modes.
 *
 * Goldens catch "the file changed"; these catch "the file is still perfectly
 * well-formed and every element is present, but two labels now sit on top of
 * each other" — the class of regression a snapshot cannot see, because a
 * snapshot of a broken page looks exactly like a snapshot.
 *
 * See `audit.ts` for what the measurements are and what they deliberately do
 * not measure (real font rasterisation, and the interior of inlined artwork).
 */

import { describe, expect, it } from 'vitest';

import { listDesignIds, loadDb, loadDesign, type DesignId } from '@wirehub/catalog';

import type { CableDesign, Db } from '@wirehub/model';

import { DETOUR_DB, DETOUR_DESIGN } from '../../layout/test/detour-fixtures.ts';
import { renderSchematic } from '../src/index.ts';
import { auditDrawing, findings, type Audit } from './audit.ts';

const db = loadDb();

/**
 * Depicted drawings that still draw two nets along one line, and how many
 * times. Empty since: a run onto a fixed pad row, entry
 * guide or board row dog-legs off the line (`separateRoutes`), and an HD15's
 * far-row pins are reached from behind the pin field (`planPinLeads`). A cap,
 * not a pin: an entry here is a regression to explain, and a fix only lowers it.
 */
const KNOWN_SHARED_LINES: Record<string, number> = {};

/**
 * Depicted drawings where a run still crosses a label, and how many times — a
 * cap, like KNOWN_SHARED_LINES. Empty since: the device
 * cables' T-joint run onto the board's R pad no longer clips the perfboard's
 * "pads not used" foot, the perfboard now docked beside its board.
 */
const KNOWN_TEXT_CROSSINGS: Record<string, number> = {};

/** The two drawings every design has: the abstract one, and the depicted one. */
const MODES = [
  { name: 'abstract', depictions: false },
  { name: 'depicted', depictions: true },
] as const;

/** One render per design per mode, reused by every assertion below. */
const AUDITS = new Map<string, Audit>();
function auditOf(id: DesignId, depictions: boolean): Audit {
  const key = `${id}:${depictions}`;
  const existing = AUDITS.get(key);
  if (existing !== undefined) return existing;
  const audit = auditDrawing(renderSchematic(loadDesign(id), db, { depictions }));
  AUDITS.set(key, audit);
  return audit;
}

for (const mode of MODES) {
  describe(`${mode.name} drawings`, () => {
    describe.each(listDesignIds())('%s', (id) => {
      const audit = (): Audit => auditOf(id, mode.depictions);

      it('gives every label a font size the stylesheet actually defines', () => {
        expect(findings(audit(), 'text-unstyled')).toEqual([]);
      });

      it('keeps every label on the page', () => {
        expect(findings(audit(), 'text-off-page')).toEqual([]);
      });

      it('never lets two labels sit on top of each other', () => {
        expect(findings(audit(), 'text-overlap')).toEqual([]);
      });

      it('keeps blocks, bands, components and the cutaway clear of each other', () => {
        expect(findings(audit(), 'region-overlap')).toEqual([]);
      });

      it('never routes a wire behind a block, a band or the cutaway', () => {
        // blocks and the cutaway panel are painted on white fill *over* the
        // wiring, so a run that passes behind one does not read as a crossing
        // — it simply disappears
        expect(
          findings(
            audit(),
            'edge-crosses-block',
            'edge-crosses-band',
            'edge-crosses-panel',
          ),
        ).toEqual([]);
      });

      /**
       * A component symbol is painted on white fill after the wiring layer for
       * the same reason a block is, so a run whose y lands inside a discrete
       * part's body does not read as a crossing either — it vanishes behind
       * the part, which on a schematic says "this wire goes through the
       * capacitor". Unlike a block, a component cannot be moved out of the way
       * by lane discipline: it sits in the fan corridor at a y derived from
       * the anchors it bridges. The router detours around it instead
       *; this is the check that it still does.
       */
      it('never routes a wire behind a component symbol', () => {
        expect(findings(audit(), 'edge-crosses-component')).toEqual([]);
      });

      /** A wire through a label strikes the words out. */
      it('never runs a wire through a label', () => {
        const crossing = findings(audit(), 'edge-crosses-text');
        const known = mode.depictions ? (KNOWN_TEXT_CROSSINGS[id] ?? 0) : 0;
        if (known === 0) expect(crossing).toEqual([]);
        else expect(crossing.length, crossing.join('\n')).toBeLessThanOrEqual(known);
      });

      /** Two nets along one line read as one wire — a connection that is not there. */
      it('never draws two nets along one line', () => {
        const shared = findings(audit(), 'edge-overlap');
        const known = mode.depictions ? (KNOWN_SHARED_LINES[id] ?? 0) : 0;
        if (known === 0) expect(shared).toEqual([]);
        else expect(shared.length, shared.join('\n')).toBeLessThanOrEqual(known);
      });

      it('draws nothing outside the viewBox', () => {
        expect(findings(audit(), 'off-page')).toEqual([]);
      });

      it('lands every artwork frame inside the block that owns it', () => {
        expect(findings(audit(), 'artwork-outside-block')).toEqual([]);
      });

      it('actually measured something', () => {
        // a sweep that found nothing because it looked at nothing would pass
        // every assertion above; this is the guard against that
        const report = audit();
        expect(report.width, 'no viewBox').toBeGreaterThan(0);
        expect(report.texts.length, 'no text measured').toBeGreaterThan(10);
        expect(report.regions.length, 'no region measured').toBeGreaterThan(0);
      });
    });
  });
}

/**
 * Shapes the catalog does not carry, drawn and swept the same way: whip
 * branches and a hood crowded with parts (nck.13). These
 * hold to every check, with no exceptions.
 */
const FIXTURES: { id: string; design: CableDesign; db: Db }[] = [
  { id: DETOUR_DESIGN.id, design: DETOUR_DESIGN, db: DETOUR_DB },
];

for (const mode of MODES) {
  describe(`${mode.name} fixture drawings`, () => {
    describe.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))('%s', (_id, fixture) => {
      const report = auditDrawing(renderSchematic(fixture.design, fixture.db, { depictions: mode.depictions }));

      it('passes every sweep', () => {
        expect(report.findings.map((finding) => `${finding.kind}: ${finding.message}`)).toEqual([]);
      });

      it('actually measured something', () => {
        expect(report.texts.length).toBeGreaterThan(10);
        expect(report.regions.length).toBeGreaterThan(0);
      });
    });
  });
}
