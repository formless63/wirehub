import { createCatalog, dataPath, fsCatalogSource } from '@wirehub/catalog';
import { createRegistry, manifestProblems } from '@wirehub/modules';
import { expect, it, vi } from 'vitest';
import { fxRates } from '../src/index.ts';
import type { FxSettings } from '../src/types.ts';
import type { CableDesign } from '@wirehub/model';

it('declares optional integration/panel/export and exports only the saved design snapshot', async () => {
  expect(manifestProblems([fxRates])).toEqual([]);
  expect(createRegistry([fxRates]).module('fx-rates')?.id).toBe('fx-rates');
  expect(fxRates.panels?.[0]?.slot).toBe('cable-documents');
  expect(createRegistry([fxRates]).panels('cable-inspector')).toEqual([]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
  try {
    const catalog = createCatalog(fsCatalogSource(dataPath('')));
    const design = catalog.loadDesign(catalog.listDesignIds()[0]!) as CableDesign;
    const settings: FxSettings = { schema: 1, snapshot: { base: 'EUR', date: '2026-01-02', rates: { USD: 2 }, source: 'synthetic example', retrievedAt: '2026-01-03T00:00:00Z' }, target: 'USD' };
    const saved = { ...design, extensions: { ...design.extensions, 'fx-rates': settings } };
    const exporter = fxRates.exporters![0]!;
    const before = JSON.stringify(saved);
    expect(await exporter.render(saved, catalog.loadDb())).toMatchObject({ mimeType: 'text/csv' });
    const rendered = await exporter.render(saved, catalog.loadDb());
    expect(String(rendered.body)).toContain('2026-01-02');
    expect(String(rendered.body)).toContain('Saved reference rates');
    expect(String(rendered.body)).not.toContain('ECB reference rates');
    expect(() => exporter.render({ ...design, extensions: {} }, catalog.loadDb())).toThrow('Save a valid FX snapshot');
    expect(JSON.stringify(saved)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
