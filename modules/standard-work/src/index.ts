/** Optional module; deliberately absent from the default Studio module manifest. */
import { defineModule } from '@wirehub/modules';
import { settingsOf, workCsv, workIssues } from './logic.ts';
import { StandardWorkPanel } from './ui.ts';

export const standardWork = defineModule({
  id: 'standard-work', label: 'Standard work', version: '0.1.0', license: 'MIT',
  panels: [{ id: 'operations', label: 'Operation times', slot: 'cable-inspector', component: StandardWorkPanel }],
  exporters: [{ id: 'work-csv', label: 'Operation time estimate (CSV)', description: 'Saved operator times with separate batch setup and build-quantity allocation.', render: (design, db, options?: Readonly<Record<string, unknown>>) => {
    const settings = settingsOf(design);
    return { mimeType: 'text/csv', fileName: `${design.id}-standard-work.csv`, body: workCsv(design, db, settings, options?.['builds'] === undefined ? settings.adoption?.builds ?? 1 : Number(options['builds'])) };
  } }],
  validationRules: [{ id: 'operation-times', label: 'Recorded operation times must be valid', check: workIssues }],
});

export { adoptLabour, estimateWork, settingsOf, workCsv, workIssues, workProblems } from './logic.ts';
export type { WorkEstimate, WorkOperation, WorkSettings } from './logic.ts';
