/** User-editable slicer settings must not reach outside the slice (post-processing scripts, printer hosts). */

import { describe, expect, it } from 'vitest';

import { parseProfiles } from '../server/print/profiles.ts';

const profile = (settings: Record<string, unknown>) => [{ id: 'p-1', kind: 'process', label: 'P', settings }];

describe('print profiles', () => {
  it('refuses keys that run scripts or contact a printer host', () => {
    for (const key of ['post_process', 'host_type', 'print_host', 'printhost_apikey']) {
      expect(parseProfiles(profile({ [key]: 'x' })), key).toHaveProperty('error');
    }
  });

  it('refuses odd setting names and values, and duplicate ids', () => {
    expect(parseProfiles(profile({ 'bad key': 1 }))).toHaveProperty('error');
    expect(parseProfiles(profile({ layer_height: Number.NaN }))).toHaveProperty('error');
    expect(parseProfiles(profile({ layer_height: { a: 1 } }))).toHaveProperty('error');
    expect(parseProfiles([...profile({}), ...profile({})])).toHaveProperty('error');
  });

  it('keeps plain settings', () => {
    expect(parseProfiles(profile({ layer_height: 0.2, fill_pattern: 'gyroid', support_material: false }))).toEqual({
      profiles: [expect.objectContaining({ id: 'p-1', settings: { layer_height: 0.2, fill_pattern: 'gyroid', support_material: false } })],
    });
  });
});
