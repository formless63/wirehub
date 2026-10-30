/**
 * The drawing sheet never states a falsehood about a board-landed cable: a conductor soldered to a
 * board pad is named by that pad (never "NC"), and a foil + drain cable is neither called unshielded nor has its trimmed foil named.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { deriveDrawing } from '../src/drawing/index.ts';

// the starter board as an imported board carries it: bare pads, no integrated terminal block
const starter = loadDb();
const db = {
  ...starter,
  pcbas: starter.pcbas.map((p) => (p.id === 'pair-terminal-board' ? { ...p, integratedConnectors: [] } : p)),
};

describe('drawing sheet on a board-landed design (synthetic de9-terminal-board, bare pads)', () => {
  const drawing = deriveDrawing(loadDesign('de9-terminal-board'), db);

  it('names the board pads a conductor lands on, never NC', () => {
    const landed = drawing.rows.filter((row) => row.left !== 'NC' && row.left !== '');
    expect(landed.map((row) => row.right)).toEqual(['U1 “B” pad', 'U1 “A” pad', 'U1 “GND” pad', 'NC']);
    expect(drawing.boardEnds.b).toBe('U1');
    expect(drawing.boardEnds.a).toBeUndefined();
  });

  it('never calls a foil + drain cable unshielded, and never names the trimmed foil', () => {
    const text = drawing.remarks.map((r) => r.text).join(' ');
    expect(text).not.toMatch(/unshielded/);
    expect(text).not.toMatch(/foil/i);
    expect(text).toMatch(/without their own shields/);
  });
});
