/** Optional module: installation opts into manual ECB requests and saved rate snapshots. */
import { defineModule } from '@wirehub/modules';
import { costReportCsv, settingsOf } from './logic.ts';
import { fxIntegration } from './server.ts';
import { FxPanel } from './ui.ts';

export const fxRates = defineModule({
  id: 'fx-rates', label: 'FX reference rates', version: '0.1.1', license: 'MIT',
  integrations: [fxIntegration],
  panels: [{ id: 'snapshot', label: 'FX cost snapshot', slot: 'cable-inspector', component: FxPanel }],
  exporters: [{ id: 'cost-csv', label: 'FX cost report (saved snapshot)', render: (design, db, options?: Readonly<Record<string, unknown>>) => {
    const settings = settingsOf(design);
    if (settings === undefined) throw new Error('Save a valid FX snapshot and target currency on this design before exporting.');
    return { mimeType: 'text/csv', fileName: `${design.id}-fx-costs.csv`, body: costReportCsv(design, db, settings, options?.['builds'] === undefined ? settings.builds ?? 1 : Number(options['builds'])) };
  } }],
});

export { convertAmount, costReportCsv, settingsOf, snapshotProblems } from './logic.ts';
export type { FxSettings, FxSnapshot } from './types.ts';
