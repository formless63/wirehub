/**
 * Supply rails fail closed. A synthetic hub whose vocabulary has
 * composite/H/V sync but no plain "sync" phrase, a colour code that makes
 * yellow a supply, and a mini-coax stock whose yellow core is labelled
 * "Video Sync": the core's label reads as nothing, and the colour code must
 * not promote it to a supply. Landing it on a +5 V pad is an error.
 */

import { describe, expect, it } from 'vitest';
import { loadDb } from '@wirehub/catalog';

import { readConductor, validateDesign, type CableDesign, type ColourCodeEntry, type Db, type Joint, type SignalEntry } from '../src/index.ts';

const SRC = 'synthetic example: rail-safety test';

function syntheticDb(): Db {
  const db = structuredClone(loadDb());
  const vocab = db.vocab!;
  (vocab['signals']!.entries as SignalEntry[]).push(
    { id: 'csync', label: 'Composite sync', short: 'CSync', aliases: ['C-sync'], kind: 'video', src: SRC },
    { id: 'hsync', label: 'H sync', aliases: ['HSync'], kind: 'video', src: SRC },
    { id: 'vsync', label: 'V sync', aliases: ['VSync'], kind: 'video', src: SRC },
    { id: 'sog', label: 'Sync on green', kind: 'video', src: SRC },
  );
  (vocab['colour-codes']!.entries as ColourCodeEntry[]).push({ id: 'synthetic-yellow-supply', label: 'Synthetic code, yellow is a supply', lanes: { yellow: 'power', red: 'power', black: 'ground' }, src: SRC });
  db.wires.push({
    id: 'synthetic-mini-coax',
    label: 'Synthetic mini-coax multicore',
    colourCode: 'synthetic-yellow-supply',
    structure: {
      kind: 'group', id: 'synthetic-mini-coax', label: 'Cable', role: 'cable',
      children: [
        {
          kind: 'group', id: 'sync', label: 'Video Sync coax (yellow)', role: 'coax',
          children: [
            { kind: 'conductor', id: 'center', color: 'yellow', label: 'Video Sync centre conductor' },
            { kind: 'shield', id: 'braid', label: 'Braid', construction: 'braid' },
          ],
        },
        { kind: 'conductor', id: 'plain', color: 'yellow' },
        { kind: 'conductor', id: 'five', color: 'red', label: '+5 V' },
        { kind: 'conductor', id: 'twelve', color: 'red', label: '+12 V' },
      ],
    },
    src: SRC,
  } as unknown as Db['wires'][number]);
  db.pcbas.push({
    id: 'synthetic-sync-board',
    label: 'Synthetic board with a sync pad and a +5 V pad',
    terminals: [
      { id: 'S', label: 'S', role: 'sync' },
      { id: '5V', label: '+5 V', role: 'power', signal: 'pwr-5v' },
      { id: '12V', label: '+12 V', role: 'power', signal: 'pwr-12v' },
      { id: 'GND', label: 'GND', role: 'gnd' },
    ],
    internalLinks: [],
    src: SRC,
  } as unknown as Db['pcbas'][number]);
  return db;
}

function design(joints: Joint[]): CableDesign {
  return {
    schemaVersion: 4,
    id: 'synthetic-rail-safety',
    label: 'Synthetic rail safety',
    instances: {
      connectors: [],
      segments: [{ id: 'w1', def: 'synthetic-mini-coax', lengthMm: 500 }],
      components: [],
      pcbas: [{ id: 'u1', def: 'synthetic-sync-board' }, { id: 'u2', def: 'synthetic-sync-board' }],
    },
    joints,
  } as unknown as CableDesign;
}

const both = (path: string, terminal: string): Joint[] => [
  { a: { instance: 'w1', terminal: path, end: 'a' }, b: { instance: 'u1', terminal } },
  { a: { instance: 'w1', terminal: path, end: 'b' }, b: { instance: 'u2', terminal } },
];

const railCodes = (db: Db, d: CableDesign) =>
  validateDesign(d, db)
    .filter((i) => ['signal-on-power-rail', 'unknown-on-power-rail', 'rail-mismatch', 'rail-voltage-differs'].includes(i.code))
    .map((i) => `${i.severity}:${i.code}`);

describe('a supply rail takes only a conductor that reads as that supply', () => {
  const db = syntheticDb();
  const wire = db.wires.find((w) => w.id === 'synthetic-mini-coax')!;

  it('does not let a colour code turn an unread "Video Sync" core into a supply', () => {
    expect(readConductor(db, wire, 'sync.center')).toMatchObject({ basis: 'unread', colourLane: 'power' });
    expect(readConductor(db, wire, 'sync.center')?.hint).toBeUndefined();
    expect(railCodes(db, design(both('sync.center', '5V')))).toEqual(['error:unknown-on-power-rail', 'error:unknown-on-power-rail']);
    expect(railCodes(db, design(both('sync.center', 'GND')))).toEqual(['error:unknown-on-power-rail', 'error:unknown-on-power-rail']);
  });

  it('still takes a core with no words of its own by its colour code, and a labelled supply on its own rail', () => {
    expect(readConductor(db, wire, 'plain')).toMatchObject({ basis: 'colour-code', hint: 'power' });
    expect(railCodes(db, design(both('plain', '5V')))).toEqual([]);
    expect(railCodes(db, design(both('five', '5V')))).toEqual([]);
  });

  it('errors on one conductor joining two supplies, and warns on a supply core of another voltage', () => {
    const across: Joint[] = [
      { a: { instance: 'w1', terminal: 'twelve', end: 'a' }, b: { instance: 'u1', terminal: '12V' } },
      { a: { instance: 'w1', terminal: 'twelve', end: 'b' }, b: { instance: 'u2', terminal: '5V' } },
    ];
    expect(railCodes(db, design(across))).toEqual(['warning:rail-voltage-differs', 'error:rail-mismatch']);
    expect(railCodes(db, design(both('five', 'GND')))).toEqual(['error:rail-mismatch', 'error:rail-mismatch']);
  });
});
