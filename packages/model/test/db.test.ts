/** The starter catalog as a whole: zero errors, every record cited. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadVocab } from '@wirehub/catalog';

import { errors, validateDb, validateVocab, type Db } from '../src/index.ts';

const db: Db = loadDb();

describe('the starter catalog', () => {
  it('validates with no issues', () => {
    expect(validateDb(db)).toEqual([]);
  });

  it('every record carries a src citation', () => {
    const records = [
      ...db.connectors,
      ...db.wires,
      ...db.components,
      ...db.pcbas,
      ...(db.mechanicals ?? []),
      ...(db.bodies ?? []),
      ...(db.interfaces ?? []),
      ...(db.kits ?? []),
    ];
    expect(records.length).toBeGreaterThan(20);
    for (const record of records) expect(record.src, (record as { id?: string }).id).toBeTruthy();
  });

  it('its vocabularies validate', () => {
    expect(errors(validateVocab(loadVocab()))).toEqual([]);
  });

  it('composes connector pins from body + interface', () => {
    const de9 = db.connectors.find((c) => c.id === 'de9-female-rs232');
    expect(de9?.pins.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'shell']);
    expect(de9?.pins.find((p) => p.id === '3')?.signal).toBe('rs232-txd');
  });

  it('exposes integrated connector pins as PCBA terminals', () => {
    const board = db.pcbas.find((p) => p.id === 'rs485-terminal-board');
    expect(board?.integratedConnectors?.[0]?.terminalPrefix).toBe('tb');
  });

  it('keeps two-terminal parts on terminals a/b with a = +', () => {
    for (const c of db.components) {
      expect(c.terminals.map((t) => t.id)).toEqual(['a', 'b']);
    }
    expect(db.components.find((c) => c.id === 'led-red-5mm')?.terminals[0]?.polarity).toBe('+');
  });

  it('cites a public standard or says "synthetic example" on every record', () => {
    for (const record of [...db.connectors, ...db.wires, ...db.components, ...db.pcbas]) {
      expect(/synthetic example|IEC|TIA|IEEE|VESA|USB|AES|JST|generic/i.test(record.src), record.id).toBe(true);
    }
  });
});
