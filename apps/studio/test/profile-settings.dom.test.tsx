import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProfileSettings } from '../src/print/ProfileSettings.tsx';
import type { SettingValue } from '../src/print/settings-text.ts';

afterEach(cleanup);
it('edits ordinary printer dimensions and temperatures while preserving machine instructions', () => {
  const original = { bed_shape: '0x0,200x0,200x180,0x180', temperature: 210, start_gcode: 'G28\nG1 Z5', vendor_extension: 'keep' };
  let result: Record<string, SettingValue> = original;
  function Form() {
    const [value, setValue] = useState<Record<string, SettingValue>>(original);
    return <ProfileSettings value={value} onChange={(next) => { result = next; setValue(next); }} />;
  }
  render(<Form />);
  const width = screen.getByLabelText('Bed width (mm)');
  fireEvent.change(width, { target: { value: '240' } }); fireEvent.blur(width);
  const temperature = screen.getByLabelText('Nozzle temperature (°C)');
  fireEvent.change(temperature, { target: { value: '215' } }); fireEvent.blur(temperature);
  expect(result).toEqual({ ...original, bed_shape: '0x0,240x0,240x180,0x180', temperature: 215 });
  expect(screen.queryByDisplayValue(original.start_gcode)).toBeNull();
});
