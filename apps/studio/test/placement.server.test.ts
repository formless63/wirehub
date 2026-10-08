/** Where a module route is offered: a declared place, and `rail` only for a module the owner allowed. */
import { describe, expect, it } from 'vitest';

import { effectivePlacement, routesIn } from '../src/modules/placement.ts';
import { createRegistry, defineModule } from '@wirehub/modules';

const route = (placement?: 'rail' | 'library-import' | 'document-tools' | 'settings' | 'extensions', icon?: string) => ({ module: 'm', path: 'p', label: 'P', component: null, ...(placement === undefined ? {} : { placement }), ...(icon === undefined ? {} : { icon }) });

describe('effectivePlacement', () => {
  it('defaults to the Modules page, even for an older module with an icon', () => {
    expect(effectivePlacement(route(), [])).toBe('extensions');
    expect(effectivePlacement(route(undefined, 'IconTool'), ['m'])).toBe('extensions');
  });
  it('keeps a declared place', () => {
    for (const place of ['library-import', 'document-tools', 'settings', 'extensions'] as const) expect(effectivePlacement(route(place), [])).toBe(place);
  });
  it('gives the rail only to a module the owner allowed', () => {
    expect(effectivePlacement(route('rail'), [])).toBe('extensions');
    expect(effectivePlacement(route('rail'), ['other'])).toBe('extensions');
    expect(effectivePlacement(route('rail'), ['m'])).toBe('rail');
  });
});

describe('routesIn', () => {
  it('lists the routes of one place', () => {
    const registry = createRegistry([defineModule({ id: 'm', label: 'M', version: '1.0.0', routes: [{ path: 'a', label: 'A', component: null, placement: 'library-import' }, { path: 'b', label: 'B', component: null, placement: 'rail' }, { path: 'c', label: 'C', component: null }] })]);
    expect(routesIn(registry, 'library-import', []).map((r) => r.path)).toEqual(['a']);
    expect(routesIn(registry, 'rail', []).map((r) => r.path)).toEqual([]);
    expect(routesIn(registry, 'rail', ['m']).map((r) => r.path)).toEqual(['b']);
    expect(routesIn(registry, 'extensions', []).map((r) => r.path)).toEqual(['b', 'c']);
  });
});
