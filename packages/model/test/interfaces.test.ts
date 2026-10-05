/**
 * Bodies and interfaces (data model v2 §1.2): composition
 * and the reference checks, on a two-body toy library.
 */

import { describe, expect, it } from 'vitest';

import {
  composeConnector,
  composePins,
  validateInterfaces,
  type ConnectorBody,
  type Db,
  type Interface,
} from '../src/index.ts';

const din: ConnectorBody = {
  id: 'din3-male',
  label: 'DIN-3 male',
  family: 'din',
  gender: 'male',
  positions: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: 'shell', kind: 'shell' }],
  src: 'test',
};
const socket: ConnectorBody = { ...din, id: 'din3-female', label: 'DIN-3 female', gender: 'female', mates: 'din3-male' };
const plug: ConnectorBody = { ...din, mates: 'din3-female' };
const av: Interface = {
  id: 'toy-header',
  label: 'Toy header',
  bodies: ['din3-male', 'din3-female'],
  pins: {
    shell: { signal: 'gnd-chassis', label: 'Shell' },
    '1': { signal: 'led-anode', label: 'Anode', note: 'n' },
    '2': { signal: { oneOf: ['pwr-5v', 'pwr-12v'] }, label: '+5 V / +12 V', aliases: ['S'] },
    '3': { signal: 'gnd' },
  },
  src: 'test',
};

const db = (patch: Partial<Db> = {}): Db => ({
  connectors: [composeConnector({ id: 'toy', label: 'Toy', family: 'DIN', gender: 'male', body: 'din3-male', interface: 'toy-header', src: 'test' }, { bodies: [plug, socket], interfaces: [av] })],
  wires: [],
  components: [],
  pcbas: [],
  bodies: [plug, socket],
  interfaces: [av],
  ...patch,
});

describe('composePins', () => {
  it('lists body positions in body order, with the interface\'s labels and signals', () => {
    expect(composePins(plug, av)).toEqual([
      { id: '1', label: 'Anode', note: 'n', signal: 'led-anode' },
      { id: '2', label: '+5 V / +12 V', aliases: ['S'], signal: { oneOf: ['pwr-5v', 'pwr-12v'] } },
      { id: '3', label: 'gnd', signal: 'gnd' },
      { id: 'shell', label: 'Shell', signal: 'gnd-chassis' },
    ]);
  });

  it('lays a device\'s binding over an open pin (the task 11 seam)', () => {
    const pal = composePins(plug, av, undefined, { '2': { signal: 'pwr-12v' } });
    expect(pal.find((p) => p.id === '2')).toEqual({ id: '2', label: '+5 V / +12 V', aliases: ['S'], signal: 'pwr-12v' });
  });

  it('puts the connector\'s identity first and its body + interface last', () => {
    expect(Object.keys(db().connectors[0]!)).toEqual(['id', 'label', 'family', 'gender', 'pins', 'src', 'body', 'interface']);
  });
});

describe('validateInterfaces', () => {
  it('passes a consistent library', () => {
    expect(validateInterfaces(db())).toEqual([]);
  });

  it('checks nothing when the db does not carry the library', () => {
    const { bodies: _b, interfaces: _i, ...bare } = db();
    expect(validateInterfaces(bare)).toEqual([]);
  });

  const codes = (d: Db): string[] => validateInterfaces(d).map((i) => i.code);

  it('flags unknown references, foreign positions and a wrong gender', () => {
    const base = db();
    expect(codes({ ...base, connectors: [{ ...base.connectors[0]!, body: 'nope' }] })).toContain('connector-body-unknown');
    expect(codes({ ...base, connectors: [{ ...base.connectors[0]!, interface: 'nope' }] })).toContain('connector-interface-unknown');
    expect(codes({ ...base, connectors: [{ ...base.connectors[0]!, gender: 'female' }] })).toContain('connector-gender-mismatch');
    expect(codes({ ...base, interfaces: [{ ...av, pins: { ...av.pins, '9': { signal: 'gnd' } } }] })).toContain('interface-position-unknown');
    expect(codes({ ...base, interfaces: [{ ...av, bodies: ['din3-female'] }] })).toContain('connector-interface-body');
  });

  it('flags a mate that does not mate back or is the same gender', () => {
    expect(codes(db({ bodies: [plug, { ...socket, mates: undefined }] }))).toContain('body-mates');
    expect(codes(db({ bodies: [plug, { ...socket, gender: 'male' }] }))).toContain('body-mates');
  });

  it('warns when a connector\'s own pins diverge from its composition', () => {
    const base = db();
    const edited = { ...base.connectors[0]!, pins: base.connectors[0]!.pins.slice(1) };
    expect(validateInterfaces({ ...base, connectors: [edited] })).toEqual([
      expect.objectContaining({ code: 'connector-pins-diverge', severity: 'warning' }),
    ]);
  });
});
