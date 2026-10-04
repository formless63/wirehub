import { describe, expect, it } from 'vitest';

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { electricalPaths, findWire, inScope, isFullyBonded, terminalKey } from '@wirehub/model';

import { bondFoldedPaths, isFoilElement, layoutSchematic } from '../src/index.ts';

const db = loadDb();

describe('layoutSchematic', () => {
  for (const id of listDesignIds()) {
    describe(id, () => {
      const design = loadDesign(id);
      const diagram = layoutSchematic(design, db);

      it('is deterministic', () => {
        const again = layoutSchematic(loadDesign(id), loadDb());
        expect(JSON.stringify(again)).toBe(JSON.stringify(diagram));
      });

      it('lays out one band per segment with a track per electrical element, minus folded bonded screens', () => {
        expect(diagram.bands.map((band) => band.segment).sort()).toEqual(
          design.instances.segments.map((segment) => segment.id).sort(),
        );
        for (const band of diagram.bands) {
          const segment = design.instances.segments.find(
            (item) => item.id === band.segment,
          );
          const wire = findWire(db, segment?.def ?? '');
          expect(wire).toBeDefined();
          //: a bonded screen other than its set's
          // representative gets no track — "the drain stands for the mass"
          const dropped = bondFoldedPaths(wire!);
          // a breakout run draws only the elements it carries
          const expected = electricalPaths(wire!.structure).filter((path) => !dropped.has(path) && inScope(segment, path));
          expect(band.tracks.map((track) => track.elementPath).sort()).toEqual(
            [...expected].sort(),
          );
          //: the foil never draws, and nothing is labelled foil
          for (const track of band.tracks) {
            expect(isFoilElement(wire!, track.elementPath), track.key).toBe(false);
            expect(track.label, track.key).not.toMatch(/foil/i);
          }
          // a fully bonded stock (bonded multi-core) draws its shielding as one labelled track
          if (isFullyBonded(wire!)) {
            const mass = band.tracks.filter((track) => /^shields · /.test(track.label));
            expect(mass, band.segment).toHaveLength(1);
          }
        }
      });

      // a breakout's own solder joint onto a connector it houses
      // draws entirely
      // inside the mould instead (`DiagramBreakout.jacks`): no anchor of its
      // own on the page, and no routed edge reaching it.
      const isHousedJoint = (joint: (typeof design.joints)[number]): boolean =>
        (design.instances.breakouts ?? []).some((breakout) => {
          const housed = breakout.housed ?? [];
          if (housed.length === 0) return false;
          const pairs: [typeof joint.a, typeof joint.b][] = [
            [joint.a, joint.b],
            [joint.b, joint.a],
          ];
          return pairs.some(([mine, other]) => housed.includes(mine.instance) && other.instance === breakout.trunk.segment);
        });

      it('anchors every terminal a joint lands on', () => {
        for (const joint of design.joints) {
          if (isHousedJoint(joint)) continue;
          for (const ref of [joint.a, joint.b]) {
            expect(diagram.anchors[terminalKey(ref)]).toBeDefined();
          }
        }
      });

      it('routes one edge per joint, orthogonally', () => {
        const housedJoints = design.joints.filter((joint) => isHousedJoint(joint)).length;
        expect(diagram.edges).toHaveLength(design.joints.length - housedJoints);
        for (const edge of diagram.edges) {
          for (let index = 1; index < edge.points.length; index += 1) {
            const previous = edge.points[index - 1]!;
            const current = edge.points[index]!;
            const horizontal = Math.abs(previous.y - current.y) < 1e-9;
            const vertical = Math.abs(previous.x - current.x) < 1e-9;
            expect(horizontal || vertical).toBe(true);
          }
        }
      });

      it('keeps everything inside the computed page', () => {
        for (const band of diagram.bands) {
          expect(band.rect.x).toBeGreaterThanOrEqual(0);
          expect(band.rect.x + band.rect.w).toBeLessThanOrEqual(diagram.width);
          expect(band.rect.y + band.rect.h).toBeLessThanOrEqual(diagram.height);
        }
        for (const block of diagram.blocks) {
          expect(block.rect.x).toBeGreaterThanOrEqual(0);
          expect(block.rect.x + block.rect.w).toBeLessThanOrEqual(diagram.width);
          expect(block.rect.y + block.rect.h).toBeLessThanOrEqual(diagram.height);
        }
      });
    });
  }
});

