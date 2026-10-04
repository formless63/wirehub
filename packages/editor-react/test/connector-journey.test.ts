/**
 * The connector journey's pure half: body layouts,
 * pinout drafts, copy/mirror, and the connector that is the pair.
 */

import type { ConnectorBody, Db } from '@wirehub/model';
import { composeConnector, decomposeConnector } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { BODY_TEMPLATES, oppositeGenderBody, templateOfBody } from '../src/body-templates.ts';
import { connectorArt } from '../src/connector-art.ts';
import {
  blankBodyDraft,
  bodyDraftOf,
  bodyOfDraft,
  composeJourneyConnector,
  copyPinout,
  pinoutDraftOf,
  pinoutOfDraft,
  sameRecord,
  withBodyField,
} from '../src/connector-journey.ts';
import { loadDbFromDisk } from './fixture.ts';

const db: Db = loadDbFromDisk();
const body = (id: string): ConnectorBody => db.bodies!.find((b) => b.id === id)!;
const iface = (id: string) => db.interfaces!.find((i) => i.id === id)!;

describe('body layouts', () => {
  it('lays out a new body from family, layout and gender, and names it', () => {
    let draft = withBodyField(blankBodyDraft(), { family: 'din' }, []);
    expect(draft.template).toBe('din8-270');
    draft = withBodyField(draft, { gender: 'female' }, []);
    const made = bodyOfDraft({ ...draft, src: 'test' });
    expect(made.id).toBe('din8-270-female');
    expect(made.label).toBe('DIN-8 270° female');
    expect(made.positions.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', 'shell']);
    expect(made.drawing).toBe('din-270');
    // a taken id gets a suffix
    expect(withBodyField(blankBodyDraft(), { family: 'din' }, ['din8-270-male']).id).toBe('din8-270-male-2');
  });

  it('draws every standard layout the moment the body exists', () => {
    for (const [family, templates] of Object.entries(BODY_TEMPLATES)) {
      for (const template of templates) {
        for (const gender of ['male', 'female'] as const) {
          const made = bodyOfDraft({ ...withBodyField(blankBodyDraft(), { family, template: template.id, gender }, []), src: 'x' });
          const pins = made.positions.map((p) => ({ id: p.id, label: p.id }));
          const art = connectorArt({ def: { id: made.id, label: made.label, family, gender, pins, src: 'x' }, facing: 'right', body: made });
          expect(art, `${family}/${template.id}/${gender}`).toBeDefined();
          expect(art!.pins.length, `${family}/${template.id}`).toBe(pins.length);
        }
      }
    }
  });

});

describe('pinouts', () => {
  it('round-trips every stored pinout through the draft', () => {
    for (const stored of db.interfaces!) {
      const on = body(stored.bodies[0]!);
      expect(sameRecord(pinoutOfDraft(pinoutDraftOf(stored), on), stored), stored.id).toBe(true);
    }
  });

});

describe('the connector is the pair', () => {
  it('composes exactly today’s connector from its body and pinout, so an unchanged save writes nothing new', () => {
    for (const connector of db.connectors) {
      if (connector.body === undefined || connector.interface === undefined) continue;
      const made = composeJourneyConnector(
        { id: connector.id, label: connector.label, partNumber: connector.partNumber ?? '', construction: connector.construction ?? '', sourcing: connector.sourcing ?? '', src: connector.src, idTouched: true, labelTouched: true },
        body(connector.body),
        iface(connector.interface),
        db.vocab,
        connector,
      );
      expect(sameRecord(made, connector), connector.id).toBe(true);
      const library = { bodies: db.bodies!, interfaces: db.interfaces!, ...(db.vocab === undefined ? {} : { vocab: db.vocab }) };
      expect(composeConnector(decomposeConnector(made, library), library)).toEqual(connector);
    }
  });

});
