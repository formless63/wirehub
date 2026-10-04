/**
 * Data model v2 task 4: the draft ↔ record mapping
 * carries the tag fields and anything else the form does not show, the side
 * table's tags come into the form and go back out as the rows that changed,
 * and the component journey's value lists and terminal templates.
 */

import { loadDb } from '@wirehub/catalog';
import type { ComponentDefinition, ConnectorDefinition, PcbaDefinition, WireDefinition } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  changedTags,
  componentDraftOf,
  componentOf,
  connectorDraftOf,
  connectorOf,
  draftOfRecord,
  pcbaDraftOf,
  pcbaOf,
  tagsOfDraft,
  wireDefinitionOf,
  wireFormOf,
  type DefinitionDraft,
} from '../src/library.ts';
import {
  formatFarads,
  formatOhms,
  isTemplateTerminals,
  standardValues,
  suggestComponentId,
  suggestComponentLabel,
  terminalTemplate,
  valueAliases,
} from '../src/standard-values.ts';
import { exactOption, rankOptions, signalRefOf, signalText, vocabOptions } from '../src/vocab.ts';

const db = loadDb();

describe('the mapping carries tags and unknown fields', () => {
  it('keeps a pin signal written on the record, and any field the form has not heard of', () => {
    const connector = {
      ...(db.connectors[0] as ConnectorDefinition),
      body: 'din8-270',
      pins: [
        { id: '1', label: 'Red', signal: 'video-r' },
        { id: '2', label: 'Sync', signal: { oneOf: ['csync', 'cvbs'] }, confidence: 'measured' },
      ],
    } as ConnectorDefinition;
    const back = connectorOf(connectorDraftOf(connector));
    expect(back).toEqual(connector);
  });

  it('keeps extra component and terminal fields', () => {
    const component = { ...(db.components[0] as ComponentDefinition), package: '0805', conditioning: ['series-resistor'] } as ComponentDefinition;
    expect(componentOf(componentDraftOf(component))).toEqual(component);
  });

  it('keeps a stock colour code and a conductor lane', () => {
    const wire = structuredClone(db.wires.find((w) => wireFormOf(w) !== undefined) as WireDefinition);
    wire.colourCode = 'rca-audio';
    const draft = wireFormOf(wire);
    expect(draft).toBeDefined();
    expect(wireDefinitionOf(draft!).colourCode).toBe('rca-audio');
  });

  it('never writes a side-table tag into the record', () => {
    for (const connector of db.connectors) {
      const draft = connectorDraftOf(connector, db.tags);
      expect(connectorOf(draft)).toEqual(connector);
    }
    for (const pcba of db.pcbas) {
      expect(pcbaOf(pcbaDraftOf(pcba, db.tags))).toEqual(pcba);
    }
  });
});

describe('the component journey', () => {
  it('writes values the way the catalog does', () => {
    expect(formatOhms(330)).toBe('330 Ω');
    expect(formatOhms(4700)).toBe('4.7 kΩ');
    expect(formatOhms(1e6)).toBe('1 MΩ');
    expect(formatFarads(220e-6)).toBe('220 µF');
    expect(formatFarads(100e-9)).toBe('100 nF');
    expect(formatFarads(22e-12)).toBe('22 pF');
  });

  it('offers E24 resistors and E12 capacitors, and holds every catalog value', () => {
    const resistors = standardValues('resistor').map((v) => v.value);
    expect(resistors).toContain('330 Ω');
    expect(resistors).toContain('150 Ω');
    expect(resistors).toContain('180 Ω');
    expect(resistors).toContain('470 Ω');
    expect(resistors).toContain('10 MΩ');
    expect(new Set(resistors).size).toBe(resistors.length);
    const caps = standardValues('capacitor').map((v) => v.value);
    expect(caps).toContain('220 µF');
    expect(caps).toContain('4700 µF');
    expect(caps).not.toContain('5600 µF');
    // the hand-fit parts; a board-import record may carry a precision value (60.4 kΩ, E96 on
    // PCA-00119) that the picker offers under "In the catalog" instead
    for (const component of db.components.filter((c) => c.review === undefined)) {
      if (component.value !== undefined && standardValues(component.kind).length > 0) {
        expect(standardValues(component.kind).map((v) => v.value)).toContain(component.value);
      }
    }
    expect(standardValues('ic')).toEqual([]);
  });

  it('matches the way values get typed', () => {
    expect(valueAliases('4.7 kΩ')).toEqual(expect.arrayContaining(['4.7k', '4k7']));
    expect(valueAliases('220 µF')).toEqual(expect.arrayContaining(['220u', '220uf']));
    const options = standardValues('resistor').map((v) => ({ value: v.value, label: v.value, aliases: valueAliases(v.value) }));
    expect(rankOptions(options, '4k7')[0]?.value).toBe('4.7 kΩ');
    expect(rankOptions(options, '330')[0]?.value).toBe('330 Ω');
  });

  it('gives each kind its legs', () => {
    expect(terminalTemplate('resistor')?.map((t) => t.id)).toEqual(['a', 'b']);
    expect(terminalTemplate('capacitor')?.map((t) => t.polarity)).toEqual(['+', '-']);
    expect(terminalTemplate('capacitor', '100 nF')?.map((t) => t.polarity)).toEqual(['', '']);
    expect(terminalTemplate('capacitor', '220 µF')?.map((t) => t.polarity)).toEqual(['+', '-']);
    expect(terminalTemplate('ic')).toBeUndefined();
    expect(isTemplateTerminals(terminalTemplate('resistor') ?? [])).toBe(true);
    expect(isTemplateTerminals([{ id: '1', label: 'VCC', polarity: '' }])).toBe(false);
    // the catalog's capacitor is exactly the template: its legs are safe to replace
    const cap = componentDraftOf(db.components.find((c) => c.kind === 'capacitor') as ComponentDefinition);
    expect(isTemplateTerminals(cap.terminals)).toBe(true);
  });

  it('suggests a name and id in the catalog’s style', () => {
    expect(suggestComponentLabel('resistor', '330 Ω')).toBe('330 Ω resistor');
    expect(suggestComponentId('resistor', '330 Ω')).toBe('r-330');
    expect(suggestComponentId('resistor', '4.7 kΩ')).toBe('r-4-7k');
    expect(suggestComponentId('capacitor', '220 µF')).toBe('cap-220uf');
  });
});

describe('vocab options', () => {

  it('holds a one-of signal as text and back', () => {
    expect(signalText({ oneOf: ['cvbs', 'csync'] })).toBe('cvbs|csync');
    expect(signalRefOf('cvbs|csync')).toEqual({ oneOf: ['cvbs', 'csync'] });
    expect(signalRefOf('gnd')).toBe('gnd');
    expect(signalRefOf('')).toBeUndefined();
  });
});
