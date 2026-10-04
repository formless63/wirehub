/** Reading a terminal's words against the starter catalog's generic signals. */

import { describe, expect, it } from 'vitest';
import { loadVocab } from '@wirehub/catalog';

import { readSignalWords } from '../src/index.ts';

const vocab = loadVocab();

describe('the generic signal words', () => {
  it('reads supplies by voltage and the generic rail by its words', () => {
    expect(readSignalWords(vocab, '+5V')).toBe('pwr-5v');
    expect(readSignalWords(vocab, '+12 V')).toBe('pwr-12v');
    expect(readSignalWords(vocab, '+V')).toBe('pwr-v');
    expect(readSignalWords(vocab, 'VCC')).toBe('pwr-v');
  });

  it('reads 0 V as the return, never as a rail', () => {
    expect(readSignalWords(vocab, '0 V')).toBe('gnd');
    expect(readSignalWords(vocab, '0V')).toBe('gnd');
  });

  it('reads grounds and the chassis', () => {
    expect(readSignalWords(vocab, 'GND')).toBe('gnd');
    expect(readSignalWords(vocab, 'Shell')).toBe('gnd-chassis');
    expect(readSignalWords(vocab, 'NC')).toBe('nc');
  });

  it('knows no domain signal without its pack', () => {
    expect(readSignalWords(vocab, 'TXD')).toBeUndefined();
    expect(readSignalWords(vocab, 'Audio L')).toBeUndefined();
  });
});
