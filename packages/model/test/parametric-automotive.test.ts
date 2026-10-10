import { describe, expect, it } from 'vitest';
import { parametricProblems, type ParametricSpec } from '../src/parametric.ts';

const sealed: ParametricSpec = { shape: 'sealed-rectangular', pins: 6, gender: 'female', params: { widthMm: 18.19, heightMm: 22.63, lengthMm: 30.94, pinPitchMm: 3.81, rowPitchMm: 4.45, rows: 2 } };
const obd: ParametricSpec = { shape: 'obd2', pins: 16, gender: 'male', params: { widthMm: 36, heightMm: 13, lengthMm: 26, pinPitchMm: 4, rowPitchMm: 4.4 } };

describe('diagnostic and sealed rectangular model specifications', () => {
  it('accepts a full diagnostic connector and a two-row sealed socket', () => {
    expect(parametricProblems(obd)).toEqual([]);
    expect(parametricProblems(sealed)).toEqual([]);
  });
  it('refuses incomplete dimensions and impossible row populations', () => {
    expect(parametricProblems({ ...obd, pins: 8 })).toContain('obd2 has 16 contacts');
    expect(parametricProblems({ ...sealed, params: { ...sealed.params, rows: 1.5 } })).toContain('rows must be a whole number from 1 to 4');
    expect(parametricProblems({ ...sealed, pins: 5 })).toContain('pins must divide evenly between rows');
    expect(parametricProblems({ ...sealed, params: { ...sealed.params, widthMm: 0 } })).toContain('widthMm must be a number of millimetres above 0 and up to 500');
  });
});
